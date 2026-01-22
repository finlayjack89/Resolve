import { EnrichedTransaction, RecurrenceFrequency, type InsertRecurringPattern, type RecurringPattern } from "@shared/schema";

interface MerchantGroup {
  merchantName: string;
  transactions: EnrichedTransaction[];
  ukCategory?: string;
}

interface DetectedPattern {
  merchantName: string;
  frequency: RecurrenceFrequency;
  avgAmountCents: number;
  minAmountCents: number;
  maxAmountCents: number;
  anchorDay: number;
  lastSeenDate: string;
  nextDueDate: string;
  occurrenceCount: number;
  confidenceScore: number;
  ukCategory?: string;
}

const INTERVAL_TOLERANCES = {
  WEEKLY: { min: 5, max: 9, target: 7 },
  FORTNIGHTLY: { min: 12, max: 16, target: 14 },
  MONTHLY: { min: 27, max: 34, target: 30 },
  QUARTERLY: { min: 85, max: 100, target: 91 },
  ANNUAL: { min: 350, max: 380, target: 365 },
};

const MIN_OCCURRENCES_FOR_DETECTION = 2;
const MIN_CONFIDENCE_THRESHOLD = 0.5;

export function detectRecurringPatterns(
  transactions: EnrichedTransaction[],
  userId: string
): InsertRecurringPattern[] {
  const outgoingTransactions = transactions.filter(
    tx => tx.entryType === 'outgoing' && 
    !tx.excludeFromAnalysis && 
    !tx.isInternalTransfer &&
    (tx.merchantCleanName || tx.originalDescription)
  );

  const merchantGroups = groupByMerchant(outgoingTransactions);
  const detectedPatterns: DetectedPattern[] = [];

  for (const group of merchantGroups) {
    if (group.transactions.length < MIN_OCCURRENCES_FOR_DETECTION) {
      continue;
    }

    const pattern = analyzeGroupForRecurrence(group);
    if (pattern && pattern.confidenceScore >= MIN_CONFIDENCE_THRESHOLD) {
      detectedPatterns.push(pattern);
    }
  }

  return detectedPatterns.map(pattern => ({
    userId,
    merchantName: pattern.merchantName,
    frequency: pattern.frequency,
    avgAmountCents: pattern.avgAmountCents,
    minAmountCents: pattern.minAmountCents,
    maxAmountCents: pattern.maxAmountCents,
    anchorDay: pattern.anchorDay,
    lastSeenDate: pattern.lastSeenDate,
    nextDueDate: pattern.nextDueDate,
    occurrenceCount: pattern.occurrenceCount,
    confidenceScore: pattern.confidenceScore,
    ukCategory: pattern.ukCategory,
    isActive: true,
  }));
}

function groupByMerchant(transactions: EnrichedTransaction[]): MerchantGroup[] {
  const groups = new Map<string, EnrichedTransaction[]>();

  for (const tx of transactions) {
    const merchantName = (tx.merchantCleanName || tx.originalDescription)?.toLowerCase().trim();
    if (!merchantName || merchantName.length < 3) continue;

    if (!groups.has(merchantName)) {
      groups.set(merchantName, []);
    }
    groups.get(merchantName)!.push(tx);
  }

  return Array.from(groups.entries()).map(([merchantName, txs]) => ({
    merchantName,
    transactions: txs.sort((a, b) => 
      new Date(a.transactionDate).getTime() - new Date(b.transactionDate).getTime()
    ),
    ukCategory: txs[0]?.ukCategory || undefined,
  }));
}

function analyzeGroupForRecurrence(group: MerchantGroup): DetectedPattern | null {
  const { merchantName, transactions, ukCategory } = group;

  if (transactions.length < MIN_OCCURRENCES_FOR_DETECTION) {
    return null;
  }

  const intervals = calculateIntervals(transactions);
  if (intervals.length === 0) {
    return null;
  }

  const medianInterval = calculateMedian(intervals);
  const frequency = classifyFrequency(medianInterval);

  if (!frequency) {
    return null;
  }

  const confidenceScore = calculateConfidence(intervals, frequency);
  if (confidenceScore < MIN_CONFIDENCE_THRESHOLD) {
    return null;
  }

  const amounts = transactions.map(tx => Math.abs(tx.amountCents));
  const avgAmountCents = Math.round(amounts.reduce((sum, a) => sum + a, 0) / amounts.length);
  const minAmountCents = Math.min(...amounts);
  const maxAmountCents = Math.max(...amounts);

  const lastTransaction = transactions[transactions.length - 1];
  const lastSeenDate = lastTransaction.transactionDate;
  const anchorDay = calculateAnchorDay(transactions, frequency);
  const nextDueDate = calculateNextDueDate(lastSeenDate, frequency, anchorDay);

  return {
    merchantName: lastTransaction.merchantCleanName || merchantName,
    frequency,
    avgAmountCents,
    minAmountCents,
    maxAmountCents,
    anchorDay,
    lastSeenDate,
    nextDueDate,
    occurrenceCount: transactions.length,
    confidenceScore,
    ukCategory,
  };
}

function calculateIntervals(transactions: EnrichedTransaction[]): number[] {
  const intervals: number[] = [];

  for (let i = 1; i < transactions.length; i++) {
    const prevDate = new Date(transactions[i - 1].transactionDate);
    const currDate = new Date(transactions[i].transactionDate);
    const daysDiff = Math.round((currDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24));

    if (daysDiff > 0) {
      intervals.push(daysDiff);
    }
  }

  return intervals;
}

function calculateMedian(values: number[]): number {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function classifyFrequency(medianInterval: number): RecurrenceFrequency | null {
  for (const [freq, tolerance] of Object.entries(INTERVAL_TOLERANCES)) {
    if (medianInterval >= tolerance.min && medianInterval <= tolerance.max) {
      return freq as RecurrenceFrequency;
    }
  }
  return null;
}

function calculateConfidence(intervals: number[], frequency: RecurrenceFrequency): number {
  const tolerance = INTERVAL_TOLERANCES[frequency];
  const target = tolerance.target;
  const range = tolerance.max - tolerance.min;

  let matchCount = 0;
  let totalDeviation = 0;

  for (const interval of intervals) {
    const deviation = Math.abs(interval - target);

    if (interval >= tolerance.min && interval <= tolerance.max) {
      matchCount++;
    }

    totalDeviation += deviation / target;
  }

  const matchRatio = matchCount / intervals.length;
  const avgDeviation = totalDeviation / intervals.length;
  const deviationPenalty = Math.max(0, 1 - avgDeviation);

  const baseConfidence = matchRatio * 0.7 + deviationPenalty * 0.3;
  const occurrenceBonus = Math.min(0.1, (intervals.length - 1) * 0.02);

  return Math.min(1.0, baseConfidence + occurrenceBonus);
}

function calculateAnchorDay(transactions: EnrichedTransaction[], frequency: RecurrenceFrequency): number {
  const days = transactions.map(tx => {
    const date = new Date(tx.transactionDate);
    if (frequency === RecurrenceFrequency.WEEKLY) {
      return date.getDay() || 7;
    }
    return date.getDate();
  });

  const dayCounts = new Map<number, number>();
  for (const day of days) {
    dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
  }

  let maxCount = 0;
  let mostFrequentDay = days[0];
  dayCounts.forEach((count, day) => {
    if (count > maxCount) {
      maxCount = count;
      mostFrequentDay = day;
    }
  });

  return mostFrequentDay;
}

function calculateNextDueDate(lastSeenDate: string, frequency: RecurrenceFrequency, anchorDay: number): string {
  const lastDate = new Date(lastSeenDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let nextDate: Date;

  switch (frequency) {
    case RecurrenceFrequency.WEEKLY:
      nextDate = new Date(lastDate);
      nextDate.setDate(lastDate.getDate() + 7);

      while (nextDate <= today) {
        nextDate.setDate(nextDate.getDate() + 7);
      }
      break;

    case RecurrenceFrequency.FORTNIGHTLY:
      nextDate = new Date(lastDate);
      nextDate.setDate(lastDate.getDate() + 14);

      while (nextDate <= today) {
        nextDate.setDate(nextDate.getDate() + 14);
      }
      break;

    case RecurrenceFrequency.MONTHLY:
      nextDate = new Date(lastDate);
      nextDate.setMonth(lastDate.getMonth() + 1);

      nextDate.setDate(Math.min(anchorDay, getDaysInMonth(nextDate.getFullYear(), nextDate.getMonth())));

      while (nextDate <= today) {
        nextDate.setMonth(nextDate.getMonth() + 1);
        nextDate.setDate(Math.min(anchorDay, getDaysInMonth(nextDate.getFullYear(), nextDate.getMonth())));
      }
      break;

    case RecurrenceFrequency.QUARTERLY:
      nextDate = new Date(lastDate);
      nextDate.setMonth(lastDate.getMonth() + 3);

      while (nextDate <= today) {
        nextDate.setMonth(nextDate.getMonth() + 3);
      }
      break;

    case RecurrenceFrequency.ANNUAL:
      nextDate = new Date(lastDate);
      nextDate.setFullYear(lastDate.getFullYear() + 1);

      while (nextDate <= today) {
        nextDate.setFullYear(nextDate.getFullYear() + 1);
      }
      break;

    default:
      nextDate = new Date(lastDate);
      nextDate.setMonth(lastDate.getMonth() + 1);
  }

  return nextDate.toISOString().split('T')[0];
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

export function getUpcomingBillsForCurrentMonth(
  patterns: RecurringPattern[],
  paidTransactions: EnrichedTransaction[]
): { upcomingBills: any[]; paidBills: any[] } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const currentMonthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);

  const paidMerchantsThisMonth = new Set<string>();
  for (const tx of paidTransactions) {
    const txDate = new Date(tx.transactionDate);
    if (txDate >= currentMonthStart && txDate <= currentMonthEnd && tx.entryType === 'outgoing') {
      const merchantName = (tx.merchantCleanName || tx.originalDescription)?.toLowerCase().trim();
      if (merchantName) {
        paidMerchantsThisMonth.add(merchantName);
      }
    }
  }

  const upcomingBills: any[] = [];
  const paidBills: any[] = [];

  for (const pattern of patterns) {
    if (!pattern.isActive) continue;

    const nextDue = pattern.nextDueDate ? new Date(pattern.nextDueDate) : null;
    if (!nextDue) continue;

    const merchantNameLower = pattern.merchantName.toLowerCase().trim();
    const isPaid = paidMerchantsThisMonth.has(merchantNameLower);

    const isInCurrentMonth = nextDue >= currentMonthStart && nextDue <= currentMonthEnd;
    const isOverdue = nextDue < today && !isPaid;

    if (!isInCurrentMonth && !isOverdue) continue;

    const bill = {
      id: pattern.id,
      merchantName: pattern.merchantName,
      amountCents: pattern.avgAmountCents,
      dueDate: pattern.nextDueDate,
      status: isPaid ? 'PAID' : (isOverdue ? 'OVERDUE' : 'PENDING'),
      frequency: pattern.frequency,
      ukCategory: pattern.ukCategory,
      confidenceScore: pattern.confidenceScore,
    };

    if (isPaid) {
      paidBills.push(bill);
    } else {
      upcomingBills.push(bill);
    }
  }

  upcomingBills.sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
  paidBills.sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());

  return { upcomingBills, paidBills };
}
