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
