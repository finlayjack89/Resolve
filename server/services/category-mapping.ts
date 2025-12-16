/**
 * Category Mapping Service
 * 
 * Translates Ntropy enrichment labels to UK-specific budget categories
 * for the Current Finances feature. This enables accurate income and
 * expense categorization for debt repayment budget calculations.
 */

// UK Budget Categories
export enum UKBudgetCategory {
  // Income Categories
  EMPLOYMENT = "employment",
  BENEFITS = "benefits",
  PENSION = "pension",
  INVESTMENT_INCOME = "investment_income",
  RENTAL_INCOME = "rental_income",
  SIDE_HUSTLE = "side_hustle",
  OTHER_INCOME = "other_income",
  
  // Fixed Cost Categories
  RENT = "rent",
  MORTGAGE = "mortgage",
  COUNCIL_TAX = "council_tax",
  UTILITIES = "utilities",
  INSURANCE = "insurance",
  CHILDCARE = "childcare",
  
  // Essential Categories
  GROCERIES = "groceries",
  TRANSPORT = "transport",
  HEALTHCARE = "healthcare",
  EDUCATION = "education",
  
  // Discretionary Categories
  SUBSCRIPTIONS = "subscriptions",
  ENTERTAINMENT = "entertainment",
  DINING = "dining",
  SHOPPING = "shopping",
  PERSONAL_CARE = "personal_care",
  TRAVEL = "travel",
  GIFTS = "gifts",
  
  // Debt & Savings
  DEBT_PAYMENT = "debt_payment",
  SAVINGS = "savings",
  
  // Other
  TRANSFER = "transfer",
  CASH = "cash",
  FEES = "fees",
  OTHER = "other",
}

// Budget category groups for summary views
export type BudgetGroup = "income" | "fixed_costs" | "essentials" | "discretionary" | "debt" | "savings" | "other";

export interface CategoryMapping {
  ukCategory: UKBudgetCategory;
  budgetGroup: BudgetGroup;
  displayName: string;
  icon?: string; // Lucide icon name
}

// Ntropy label patterns to UK category mappings
// Order matters - first match wins
const NTROPY_LABEL_MAPPINGS: Array<{ patterns: string[]; mapping: CategoryMapping }> = [
  // Income - Employment
  {
    patterns: ["payroll", "salary", "wages", "employer", "employment"],
    mapping: {
      ukCategory: UKBudgetCategory.EMPLOYMENT,
      budgetGroup: "income",
      displayName: "Employment Income",
      icon: "Briefcase",
    },
  },
  // Income - Benefits (UK-specific)
  {
    patterns: ["dwp", "universal credit", "benefits", "hmrc", "tax credit", "child benefit", "housing benefit", "pip", "esa", "jsa"],
    mapping: {
      ukCategory: UKBudgetCategory.BENEFITS,
      budgetGroup: "income",
      displayName: "Benefits",
      icon: "Shield",
    },
  },
  // Income - Pension
  {
    patterns: ["pension", "retirement", "state pension"],
    mapping: {
      ukCategory: UKBudgetCategory.PENSION,
      budgetGroup: "income",
      displayName: "Pension",
      icon: "Landmark",
    },
  },
  // Income - Investments
  {
    patterns: ["dividend", "investment income", "interest income", "capital gains"],
    mapping: {
      ukCategory: UKBudgetCategory.INVESTMENT_INCOME,
      budgetGroup: "income",
      displayName: "Investment Income",
      icon: "TrendingUp",
    },
  },
  // Income - Rental
  {
    patterns: ["rental income", "rent received", "tenant"],
    mapping: {
      ukCategory: UKBudgetCategory.RENTAL_INCOME,
      budgetGroup: "income",
      displayName: "Rental Income",
      icon: "Home",
    },
  },
  
  // Fixed Costs - Rent
  {
    patterns: ["rent", "letting agent", "landlord"],
    mapping: {
      ukCategory: UKBudgetCategory.RENT,
      budgetGroup: "fixed_costs",
      displayName: "Rent",
      icon: "Home",
    },
  },
  // Fixed Costs - Mortgage
  {
    patterns: ["mortgage", "home loan"],
    mapping: {
      ukCategory: UKBudgetCategory.MORTGAGE,
      budgetGroup: "fixed_costs",
      displayName: "Mortgage",
      icon: "Building",
    },
  },
  // Fixed Costs - Council Tax (UK-specific)
  {
    patterns: ["council tax", "local authority"],
    mapping: {
      ukCategory: UKBudgetCategory.COUNCIL_TAX,
      budgetGroup: "fixed_costs",
      displayName: "Council Tax",
      icon: "Building2",
    },
  },
  // Fixed Costs - Utilities
  {
    patterns: ["utilities", "energy", "electricity", "gas", "water", "british gas", "edf", "ovo", "octopus", "bulb", "thames water", "severn trent", "united utilities", "scottish power", "sse", "npower"],
    mapping: {
      ukCategory: UKBudgetCategory.UTILITIES,
      budgetGroup: "fixed_costs",
      displayName: "Utilities",
      icon: "Zap",
    },
  },
  // Fixed Costs - Insurance
  {
    patterns: ["insurance", "aviva", "direct line", "admiral", "axa", "legal and general", "zurich", "prudential"],
    mapping: {
      ukCategory: UKBudgetCategory.INSURANCE,
      budgetGroup: "fixed_costs",
      displayName: "Insurance",
      icon: "Shield",
    },
  },
  // Fixed Costs - Childcare
  {
    patterns: ["childcare", "nursery", "daycare", "nanny", "au pair", "childminder"],
    mapping: {
      ukCategory: UKBudgetCategory.CHILDCARE,
      budgetGroup: "fixed_costs",
      displayName: "Childcare",
      icon: "Baby",
    },
  },
  
  // Essentials - Groceries
  {
    patterns: ["groceries", "supermarket", "tesco", "sainsbury", "asda", "morrisons", "aldi", "lidl", "waitrose", "co-op", "iceland", "ocado", "m&s food", "marks spencer food"],
    mapping: {
      ukCategory: UKBudgetCategory.GROCERIES,
      budgetGroup: "essentials",
      displayName: "Groceries",
      icon: "ShoppingCart",
    },
  },
  // Essentials - Transport
  {
    patterns: ["transport", "fuel", "petrol", "diesel", "parking", "train", "bus", "underground", "tube", "tfl", "national rail", "uber", "bolt", "taxi", "car wash", "mot", "car service", "car repair", "congestion charge", "ulez"],
    mapping: {
      ukCategory: UKBudgetCategory.TRANSPORT,
      budgetGroup: "essentials",
      displayName: "Transport",
      icon: "Car",
    },
  },
  // Essentials - Healthcare
  {
    patterns: ["pharmacy", "chemist", "boots", "superdrug", "doctor", "dentist", "optician", "specsavers", "hospital", "nhs", "healthcare", "medical", "prescription"],
    mapping: {
      ukCategory: UKBudgetCategory.HEALTHCARE,
      budgetGroup: "essentials",
      displayName: "Healthcare",
      icon: "Heart",
    },
  },
  // Essentials - Education
  {
    patterns: ["education", "school", "university", "college", "tuition", "course", "training", "books", "stationery"],
    mapping: {
      ukCategory: UKBudgetCategory.EDUCATION,
      budgetGroup: "essentials",
      displayName: "Education",
      icon: "GraduationCap",
    },
  },
  
  // Discretionary - Subscriptions
  {
    patterns: ["subscription", "netflix", "spotify", "amazon prime", "disney", "apple music", "youtube premium", "gym", "fitness", "pure gym", "david lloyd", "virgin active", "now tv", "sky", "bt sport"],
    mapping: {
      ukCategory: UKBudgetCategory.SUBSCRIPTIONS,
      budgetGroup: "discretionary",
      displayName: "Subscriptions",
      icon: "Repeat",
    },
  },
  // Discretionary - Entertainment
  {
    patterns: ["entertainment", "cinema", "theatre", "concert", "festival", "sports event", "ticket", "gaming", "playstation", "xbox", "steam"],
    mapping: {
      ukCategory: UKBudgetCategory.ENTERTAINMENT,
      budgetGroup: "discretionary",
      displayName: "Entertainment",
      icon: "Tv",
    },
  },
  // Discretionary - Dining
  {
    patterns: ["restaurant", "dining", "takeaway", "fast food", "cafe", "coffee", "pub", "bar", "deliveroo", "just eat", "uber eats", "mcdonald", "kfc", "pizza", "nando", "wagamama", "costa", "starbucks", "pret", "greggs"],
    mapping: {
      ukCategory: UKBudgetCategory.DINING,
      budgetGroup: "discretionary",
      displayName: "Dining & Takeaways",
      icon: "Utensils",
    },
  },
  // Discretionary - Shopping
  {
    patterns: ["shopping", "retail", "amazon", "ebay", "asos", "next", "primark", "h&m", "zara", "john lewis", "argos", "currys", "clothing", "fashion", "electronics"],
    mapping: {
      ukCategory: UKBudgetCategory.SHOPPING,
      budgetGroup: "discretionary",
      displayName: "Shopping",
      icon: "ShoppingBag",
    },
  },
  // Discretionary - Personal Care
  {
    patterns: ["personal care", "beauty", "salon", "hairdresser", "barber", "spa", "wellness", "cosmetics"],
    mapping: {
      ukCategory: UKBudgetCategory.PERSONAL_CARE,
      budgetGroup: "discretionary",
      displayName: "Personal Care",
      icon: "Sparkles",
    },
  },
  // Discretionary - Travel
  {
    patterns: ["travel", "holiday", "hotel", "airbnb", "booking.com", "expedia", "flight", "airline", "easyjet", "ryanair", "british airways", "eurostar"],
    mapping: {
      ukCategory: UKBudgetCategory.TRAVEL,
      budgetGroup: "discretionary",
      displayName: "Travel & Holidays",
      icon: "Plane",
    },
  },
  // Discretionary - Gifts
  {
    patterns: ["gift", "charity", "donation", "just giving", "gofundme"],
    mapping: {
      ukCategory: UKBudgetCategory.GIFTS,
      budgetGroup: "discretionary",
      displayName: "Gifts & Charity",
      icon: "Gift",
    },
  },
  
  // Debt Payments - Credit Cards & Loans
  {
    patterns: ["credit card", "amex", "american express", "barclaycard", "capital one", "mbna", "hsbc card", "lloyds card", "natwest card", "santander card", "virgin money", "tesco credit", "loan", "klarna", "clearpay", "afterpay", "laybuy", "paypal credit", "very", "littlewoods", "jd williams", "studio", "brighthouse", "provident", "payday"],
    mapping: {
      ukCategory: UKBudgetCategory.DEBT_PAYMENT,
      budgetGroup: "debt",
      displayName: "Debt Payments",
      icon: "CreditCard",
    },
  },
  
  // Savings
  {
    patterns: ["savings", "investment", "isa", "stocks", "shares", "pension contribution", "sipp"],
    mapping: {
      ukCategory: UKBudgetCategory.SAVINGS,
      budgetGroup: "savings",
      displayName: "Savings & Investments",
      icon: "PiggyBank",
    },
  },
  
  // Other - Transfers
  {
    patterns: ["transfer", "internal", "trf"],
    mapping: {
      ukCategory: UKBudgetCategory.TRANSFER,
      budgetGroup: "other",
      displayName: "Transfers",
      icon: "ArrowLeftRight",
    },
  },
  // Other - Cash
  {
    patterns: ["atm", "cash", "withdrawal", "cashback"],
    mapping: {
      ukCategory: UKBudgetCategory.CASH,
      budgetGroup: "other",
      displayName: "Cash",
      icon: "Banknote",
    },
  },
  // Other - Fees
  {
    patterns: ["fee", "charge", "overdraft", "interest", "bank charge"],
    mapping: {
      ukCategory: UKBudgetCategory.FEES,
      budgetGroup: "other",
      displayName: "Fees & Charges",
      icon: "AlertCircle",
    },
  },
];

// Default mapping for uncategorized transactions
const DEFAULT_MAPPING: CategoryMapping = {
  ukCategory: UKBudgetCategory.OTHER,
  budgetGroup: "other",
  displayName: "Other",
  icon: "HelpCircle",
};

// Default income mapping
const DEFAULT_INCOME_MAPPING: CategoryMapping = {
  ukCategory: UKBudgetCategory.OTHER_INCOME,
  budgetGroup: "income",
  displayName: "Other Income",
  icon: "CircleDollarSign",
};

/**
 * Maps Ntropy labels to UK budget category
 * @param labels - Array of Ntropy enrichment labels
 * @param merchantName - Clean merchant name from Ntropy
 * @param description - Original transaction description
 * @param isIncoming - Whether this is an incoming (credit) transaction
 * @returns CategoryMapping with UK category and budget group
 */
export function mapNtropyLabelsToCategory(
  labels: string[],
  merchantName?: string,
  description?: string,
  isIncoming: boolean = false
): CategoryMapping {
  // Combine all text sources for pattern matching
  const searchText = [
    ...labels.map(l => l.toLowerCase()),
    merchantName?.toLowerCase() || "",
    description?.toLowerCase() || "",
  ].join(" ");

  // Find first matching pattern
  for (const { patterns, mapping } of NTROPY_LABEL_MAPPINGS) {
    for (const pattern of patterns) {
      if (searchText.includes(pattern.toLowerCase())) {
        // For incoming transactions, only return if it's an income category
        if (isIncoming && mapping.budgetGroup !== "income") {
          // Check if this could be income despite pattern match
          continue;
        }
        return mapping;
      }
    }
  }

  // Default: return appropriate default based on transaction direction
  return isIncoming ? DEFAULT_INCOME_MAPPING : DEFAULT_MAPPING;
}

/**
 * Get the budget group for a UK category
 */
export function getBudgetGroup(ukCategory: UKBudgetCategory): BudgetGroup {
  const mapping = Object.values(NTROPY_LABEL_MAPPINGS)
    .flatMap(m => m.mapping)
    .find(m => m.ukCategory === ukCategory);
  
  return mapping?.budgetGroup || "other";
}

/**
 * Get display name for a UK category
 */
export function getCategoryDisplayName(ukCategory: UKBudgetCategory): string {
  const mapping = NTROPY_LABEL_MAPPINGS
    .map(m => m.mapping)
    .find(m => m.ukCategory === ukCategory);
  
  return mapping?.displayName || ukCategory;
}

/**
 * Get icon name for a UK category
 */
export function getCategoryIcon(ukCategory: UKBudgetCategory): string {
  const mapping = NTROPY_LABEL_MAPPINGS
    .map(m => m.mapping)
    .find(m => m.ukCategory === ukCategory);
  
  return mapping?.icon || "HelpCircle";
}

/**
 * Check if a category is income-related
 */
export function isIncomeCategory(ukCategory: UKBudgetCategory): boolean {
  return [
    UKBudgetCategory.EMPLOYMENT,
    UKBudgetCategory.BENEFITS,
    UKBudgetCategory.PENSION,
    UKBudgetCategory.INVESTMENT_INCOME,
    UKBudgetCategory.RENTAL_INCOME,
    UKBudgetCategory.SIDE_HUSTLE,
    UKBudgetCategory.OTHER_INCOME,
  ].includes(ukCategory);
}

/**
 * Check if a category is a fixed cost
 */
export function isFixedCostCategory(ukCategory: UKBudgetCategory): boolean {
  return [
    UKBudgetCategory.RENT,
    UKBudgetCategory.MORTGAGE,
    UKBudgetCategory.COUNCIL_TAX,
    UKBudgetCategory.UTILITIES,
    UKBudgetCategory.INSURANCE,
    UKBudgetCategory.CHILDCARE,
  ].includes(ukCategory);
}

/**
 * Check if a category is essential spending
 */
export function isEssentialCategory(ukCategory: UKBudgetCategory): boolean {
  return [
    UKBudgetCategory.GROCERIES,
    UKBudgetCategory.TRANSPORT,
    UKBudgetCategory.HEALTHCARE,
    UKBudgetCategory.EDUCATION,
  ].includes(ukCategory);
}

/**
 * Check if a category is discretionary spending
 */
export function isDiscretionaryCategory(ukCategory: UKBudgetCategory): boolean {
  return [
    UKBudgetCategory.SUBSCRIPTIONS,
    UKBudgetCategory.ENTERTAINMENT,
    UKBudgetCategory.DINING,
    UKBudgetCategory.SHOPPING,
    UKBudgetCategory.PERSONAL_CARE,
    UKBudgetCategory.TRAVEL,
    UKBudgetCategory.GIFTS,
  ].includes(ukCategory);
}

/**
 * Check if a category is a debt payment
 */
export function isDebtPaymentCategory(ukCategory: UKBudgetCategory): boolean {
  return ukCategory === UKBudgetCategory.DEBT_PAYMENT;
}

/**
 * Get all categories for a budget group
 */
export function getCategoriesForGroup(group: BudgetGroup): UKBudgetCategory[] {
  switch (group) {
    case "income":
      return [
        UKBudgetCategory.EMPLOYMENT,
        UKBudgetCategory.BENEFITS,
        UKBudgetCategory.PENSION,
        UKBudgetCategory.INVESTMENT_INCOME,
        UKBudgetCategory.RENTAL_INCOME,
        UKBudgetCategory.SIDE_HUSTLE,
        UKBudgetCategory.OTHER_INCOME,
      ];
    case "fixed_costs":
      return [
        UKBudgetCategory.RENT,
        UKBudgetCategory.MORTGAGE,
        UKBudgetCategory.COUNCIL_TAX,
        UKBudgetCategory.UTILITIES,
        UKBudgetCategory.INSURANCE,
        UKBudgetCategory.CHILDCARE,
      ];
    case "essentials":
      return [
        UKBudgetCategory.GROCERIES,
        UKBudgetCategory.TRANSPORT,
        UKBudgetCategory.HEALTHCARE,
        UKBudgetCategory.EDUCATION,
      ];
    case "discretionary":
      return [
        UKBudgetCategory.SUBSCRIPTIONS,
        UKBudgetCategory.ENTERTAINMENT,
        UKBudgetCategory.DINING,
        UKBudgetCategory.SHOPPING,
        UKBudgetCategory.PERSONAL_CARE,
        UKBudgetCategory.TRAVEL,
        UKBudgetCategory.GIFTS,
      ];
    case "debt":
      return [UKBudgetCategory.DEBT_PAYMENT];
    case "savings":
      return [UKBudgetCategory.SAVINGS];
    case "other":
      return [
        UKBudgetCategory.TRANSFER,
        UKBudgetCategory.CASH,
        UKBudgetCategory.FEES,
        UKBudgetCategory.OTHER,
      ];
    default:
      return [];
  }
}

/**
 * Summary of all budget groups with display names
 */
export const BUDGET_GROUP_CONFIG: Record<BudgetGroup, { displayName: string; icon: string; color: string }> = {
  income: { displayName: "Income", icon: "TrendingUp", color: "green" },
  fixed_costs: { displayName: "Fixed Costs", icon: "Home", color: "blue" },
  essentials: { displayName: "Essentials", icon: "ShoppingCart", color: "amber" },
  discretionary: { displayName: "Discretionary", icon: "Sparkles", color: "purple" },
  debt: { displayName: "Debt Payments", icon: "CreditCard", color: "red" },
  savings: { displayName: "Savings", icon: "PiggyBank", color: "emerald" },
  other: { displayName: "Other", icon: "HelpCircle", color: "gray" },
};

// ============================================================================
// MASTER TAXONOMY - PRD User-Friendly Categories (11 Categories)
// ============================================================================

export enum MasterCategory {
  BILLS_UTILITIES = "bills_utilities",
  SUBSCRIPTIONS = "subscriptions",
  TRANSPORT = "transport",
  GROCERIES = "groceries",
  EATING_OUT = "eating_out",
  SHOPPING = "shopping",
  ENTERTAINMENT = "entertainment",
  HEALTH_WELLBEING = "health_wellbeing",
  TRANSFERS = "transfers",
  INCOME = "income",
  UNCATEGORIZED = "uncategorized",
}

export interface MasterCategoryConfig {
  displayName: string;
  icon: string;
  color: string;
  description: string;
  excludeFromAnalysis?: boolean;
}

export const MASTER_CATEGORY_CONFIG: Record<MasterCategory, MasterCategoryConfig> = {
  [MasterCategory.BILLS_UTILITIES]: {
    displayName: "Bills & Utilities",
    icon: "Zap",
    color: "blue",
    description: "Energy, Water, Council Tax, Broadband, Phone",
  },
  [MasterCategory.SUBSCRIPTIONS]: {
    displayName: "Subscriptions",
    icon: "RotateCw",
    color: "purple",
    description: "Netflix, Gym, App Store, Streaming",
  },
  [MasterCategory.TRANSPORT]: {
    displayName: "Transport",
    icon: "Car",
    color: "amber",
    description: "Train, Uber, Bus, Fuel, Parking",
  },
  [MasterCategory.GROCERIES]: {
    displayName: "Groceries",
    icon: "ShoppingCart",
    color: "green",
    description: "Supermarkets, Bakeries, Food shops",
  },
  [MasterCategory.EATING_OUT]: {
    displayName: "Eating Out",
    icon: "Utensils",
    color: "orange",
    description: "Restaurants, Fast Food, Coffee, Cafes",
  },
  [MasterCategory.SHOPPING]: {
    displayName: "Shopping",
    icon: "ShoppingBag",
    color: "pink",
    description: "Amazon, Clothing, Electronics, General retail",
  },
  [MasterCategory.ENTERTAINMENT]: {
    displayName: "Entertainment",
    icon: "Ticket",
    color: "violet",
    description: "Cinema, Events, Betting, Gaming",
  },
  [MasterCategory.HEALTH_WELLBEING]: {
    displayName: "Health & Wellbeing",
    icon: "Heart",
    color: "red",
    description: "Pharmacy, Doctors, Hairdressers, Beauty",
  },
  [MasterCategory.TRANSFERS]: {
    displayName: "Transfers",
    icon: "ArrowLeftRight",
    color: "gray",
    description: "Internal movements, CC payments",
    excludeFromAnalysis: true,
  },
  [MasterCategory.INCOME]: {
    displayName: "Income",
    icon: "TrendingUp",
    color: "emerald",
    description: "Salary, Dividends, Refunds, Benefits",
  },
  [MasterCategory.UNCATEGORIZED]: {
    displayName: "Uncategorized",
    icon: "HelpCircle",
    color: "slate",
    description: "Needs review",
  },
};

// UK Category to Master Category mapping
const UK_TO_MASTER_CATEGORY_MAP: Record<UKBudgetCategory, MasterCategory> = {
  // Income → income
  [UKBudgetCategory.EMPLOYMENT]: MasterCategory.INCOME,
  [UKBudgetCategory.BENEFITS]: MasterCategory.INCOME,
  [UKBudgetCategory.PENSION]: MasterCategory.INCOME,
  [UKBudgetCategory.INVESTMENT_INCOME]: MasterCategory.INCOME,
  [UKBudgetCategory.RENTAL_INCOME]: MasterCategory.INCOME,
  [UKBudgetCategory.SIDE_HUSTLE]: MasterCategory.INCOME,
  [UKBudgetCategory.OTHER_INCOME]: MasterCategory.INCOME,
  
  // Fixed Costs → bills_utilities
  [UKBudgetCategory.RENT]: MasterCategory.BILLS_UTILITIES,
  [UKBudgetCategory.MORTGAGE]: MasterCategory.BILLS_UTILITIES,
  [UKBudgetCategory.COUNCIL_TAX]: MasterCategory.BILLS_UTILITIES,
  [UKBudgetCategory.UTILITIES]: MasterCategory.BILLS_UTILITIES,
  [UKBudgetCategory.INSURANCE]: MasterCategory.BILLS_UTILITIES,
  [UKBudgetCategory.CHILDCARE]: MasterCategory.BILLS_UTILITIES,
  
  // Essentials → mixed
  [UKBudgetCategory.GROCERIES]: MasterCategory.GROCERIES,
  [UKBudgetCategory.TRANSPORT]: MasterCategory.TRANSPORT,
  [UKBudgetCategory.HEALTHCARE]: MasterCategory.HEALTH_WELLBEING,
  [UKBudgetCategory.EDUCATION]: MasterCategory.BILLS_UTILITIES,
  
  // Discretionary → mixed
  [UKBudgetCategory.SUBSCRIPTIONS]: MasterCategory.SUBSCRIPTIONS,
  [UKBudgetCategory.ENTERTAINMENT]: MasterCategory.ENTERTAINMENT,
  [UKBudgetCategory.DINING]: MasterCategory.EATING_OUT,
  [UKBudgetCategory.SHOPPING]: MasterCategory.SHOPPING,
  [UKBudgetCategory.PERSONAL_CARE]: MasterCategory.HEALTH_WELLBEING,
  [UKBudgetCategory.TRAVEL]: MasterCategory.TRANSPORT,
  [UKBudgetCategory.GIFTS]: MasterCategory.SHOPPING,
  
  // Debt & Savings → bills_utilities
  [UKBudgetCategory.DEBT_PAYMENT]: MasterCategory.BILLS_UTILITIES,
  [UKBudgetCategory.SAVINGS]: MasterCategory.TRANSFERS,
  
  // Other → transfers/uncategorized
  [UKBudgetCategory.TRANSFER]: MasterCategory.TRANSFERS,
  [UKBudgetCategory.CASH]: MasterCategory.UNCATEGORIZED,
  [UKBudgetCategory.FEES]: MasterCategory.BILLS_UTILITIES,
  [UKBudgetCategory.OTHER]: MasterCategory.UNCATEGORIZED,
};

/**
 * Map UK Budget Category to Master Taxonomy Category
 */
export function mapUKToMasterCategory(ukCategory: UKBudgetCategory): MasterCategory {
  return UK_TO_MASTER_CATEGORY_MAP[ukCategory] || MasterCategory.UNCATEGORIZED;
}

/**
 * Get Master Category configuration
 */
export function getMasterCategoryConfig(category: MasterCategory): MasterCategoryConfig {
  return MASTER_CATEGORY_CONFIG[category];
}

/**
 * Get all Master Categories
 */
export function getAllMasterCategories(): MasterCategory[] {
  return Object.values(MasterCategory);
}

// ============================================================================
// REASONING TRACE SUPPORT
// ============================================================================

export interface ReasoningStep {
  step: string;
  detail: string;
  confidence?: number;
}

export interface CategoryResult {
  masterCategory: MasterCategory;
  ukCategory: UKBudgetCategory;
  isSubscription: boolean;
  subscriptionId?: string;
  reasoningSteps: ReasoningStep[];
  confidence: number;
  excludeFromAnalysis: boolean;
}

// Transfer detection patterns (Ghost Check)
const TRANSFER_PATTERNS = [
  /transfer\s*(from|to)/i,
  /internal\s*transfer/i,
  /moving\s*money/i,
  /savings?\s*pot/i,
  /credit\s*card\s*payment/i,
  /pay\s*off\s*(card|balance)/i,
  /between\s*accounts/i,
  /\bdd\b.*\bcc\b/i,
  /bank\s*transfer/i,
  /standing\s*order.*self/i,
];

/**
 * Check if transaction is a transfer (Ghost Check - Priority 1)
 */
export function isTransferTransaction(
  description: string,
  linkedTransactionId?: string | null
): { isTransfer: boolean; reason: string } {
  if (linkedTransactionId) {
    return { isTransfer: true, reason: "Linked to matching transaction (refund/reversal pair)" };
  }
  
  const lowerDesc = description.toLowerCase();
  
  for (const pattern of TRANSFER_PATTERNS) {
    if (pattern.test(description)) {
      return { isTransfer: true, reason: `Matches transfer pattern: ${pattern.source}` };
    }
  }
  
  return { isTransfer: false, reason: "No transfer patterns detected" };
}

/**
 * Priority-based Category Mapping (PRD Logic)
 * 
 * Priority Order:
 * 1. Ghost Check: Transfer detection → exclude from analysis
 * 2. Subscription Catalog: Merchant+amount match → subscriptions/bills
 * 3. Context Hunter: Event enrichment → category boost
 * 4. Ntropy Mapping: Label-based categorization
 */
export function applyCategoryMappingPriorities(
  transaction: {
    description: string;
    merchantName?: string | null;
    amountCents: number;
    entryType: "incoming" | "outgoing";
    labels?: string[];
    linkedTransactionId?: string | null;
  },
  subscriptionMatch?: {
    id: string;
    category: string;
    subscriptionType: string;
  } | null,
  contextData?: {
    eventName?: string;
    sourceType?: string;
  } | null,
  ntropyCategory?: UKBudgetCategory
): CategoryResult {
  const steps: ReasoningStep[] = [];
  let masterCategory: MasterCategory = MasterCategory.UNCATEGORIZED;
  let ukCategory: UKBudgetCategory = UKBudgetCategory.OTHER;
  let isSubscription = false;
  let subscriptionId: string | undefined;
  let confidence = 0.5;
  let excludeFromAnalysis = false;

  // Step 0: Bank Data Extraction
  steps.push({
    step: "Bank Data",
    detail: `Raw description: "${transaction.description}"`,
    confidence: 1.0,
  });

  // Priority 1: Ghost Check - Transfer Detection
  const transferCheck = isTransferTransaction(
    transaction.description,
    transaction.linkedTransactionId
  );
  
  if (transferCheck.isTransfer) {
    steps.push({
      step: "Ghost Check",
      detail: transferCheck.reason,
      confidence: 0.95,
    });
    masterCategory = MasterCategory.TRANSFERS;
    ukCategory = UKBudgetCategory.TRANSFER;
    excludeFromAnalysis = true;
    confidence = 0.95;
    
    return {
      masterCategory,
      ukCategory,
      isSubscription: false,
      reasoningSteps: steps,
      confidence,
      excludeFromAnalysis,
    };
  }
  
  steps.push({
    step: "Ghost Check",
    detail: "Not a transfer - continuing analysis",
    confidence: 0.9,
  });

  // Priority 2: Subscription Catalog Match
  if (subscriptionMatch) {
    steps.push({
      step: "Subscription Catalog",
      detail: `Matched to catalog entry: ${subscriptionMatch.category} (${subscriptionMatch.subscriptionType})`,
      confidence: 0.95,
    });
    
    isSubscription = true;
    subscriptionId = subscriptionMatch.id;
    confidence = 0.95;
    
    // Map subscription category to master category
    const subType = subscriptionMatch.subscriptionType?.toLowerCase() || "";
    const subCategory = subscriptionMatch.category?.toLowerCase() || "";
    
    if (subType === "utility" || subCategory === "utility" || subCategory === "broadband" || subCategory === "mobile") {
      masterCategory = MasterCategory.BILLS_UTILITIES;
      ukCategory = UKBudgetCategory.UTILITIES;
    } else if (subCategory === "health" || subCategory === "fitness") {
      masterCategory = MasterCategory.HEALTH_WELLBEING;
      ukCategory = UKBudgetCategory.SUBSCRIPTIONS;
    } else if (subCategory === "transport") {
      masterCategory = MasterCategory.TRANSPORT;
      ukCategory = UKBudgetCategory.TRANSPORT;
    } else {
      masterCategory = MasterCategory.SUBSCRIPTIONS;
      ukCategory = UKBudgetCategory.SUBSCRIPTIONS;
    }
    
    return {
      masterCategory,
      ukCategory,
      isSubscription,
      subscriptionId,
      reasoningSteps: steps,
      confidence,
      excludeFromAnalysis: false,
    };
  }
  
  steps.push({
    step: "Subscription Catalog",
    detail: "No catalog match found",
    confidence: 0.5,
  });

  // Priority 3: Context Hunter - Event enrichment
  if (contextData?.eventName) {
    steps.push({
      step: "Context Hunter",
      detail: `Event detected: "${contextData.eventName}" (source: ${contextData.sourceType})`,
      confidence: 0.85,
    });
    
    // Events typically boost to entertainment
    masterCategory = MasterCategory.ENTERTAINMENT;
    ukCategory = UKBudgetCategory.ENTERTAINMENT;
    confidence = 0.85;
    
    return {
      masterCategory,
      ukCategory,
      isSubscription: false,
      reasoningSteps: steps,
      confidence,
      excludeFromAnalysis: false,
    };
  }

  // Priority 4: Ntropy/Label Mapping
  if (ntropyCategory) {
    masterCategory = mapUKToMasterCategory(ntropyCategory);
    ukCategory = ntropyCategory;
    confidence = 0.8;
    
    steps.push({
      step: "Ntropy Analysis",
      detail: `Mapped to ${getMasterCategoryConfig(masterCategory).displayName} from labels`,
      confidence: 0.8,
    });
  } else if (transaction.labels && transaction.labels.length > 0) {
    // Try to map from labels directly
    const mapping = mapNtropyLabelsToCategory(transaction.labels);
    if (mapping) {
      ukCategory = mapping.ukCategory;
      masterCategory = mapUKToMasterCategory(ukCategory);
      confidence = 0.75;
      
      steps.push({
        step: "Label Analysis",
        detail: `Matched labels: ${transaction.labels.join(", ")} → ${mapping.displayName}`,
        confidence: 0.75,
      });
    } else {
      steps.push({
        step: "Label Analysis",
        detail: `Labels ${transaction.labels.join(", ")} did not match known patterns`,
        confidence: 0.3,
      });
    }
  }

  // Priority 5: Income detection (for incoming transactions)
  if (transaction.entryType === "incoming" && masterCategory === MasterCategory.UNCATEGORIZED) {
    masterCategory = MasterCategory.INCOME;
    ukCategory = UKBudgetCategory.OTHER_INCOME;
    confidence = 0.7;
    
    steps.push({
      step: "Income Detection",
      detail: "Incoming transaction classified as income",
      confidence: 0.7,
    });
  }

  // Final fallback
  if (masterCategory === MasterCategory.UNCATEGORIZED) {
    steps.push({
      step: "Fallback",
      detail: "Could not confidently categorize - marked for review",
      confidence: 0.3,
    });
    confidence = 0.3;
  }

  return {
    masterCategory,
    ukCategory,
    isSubscription,
    subscriptionId,
    reasoningSteps: steps,
    confidence,
    excludeFromAnalysis,
  };
}
