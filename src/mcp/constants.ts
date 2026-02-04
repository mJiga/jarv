// src/mcp/constants.ts
// Centralized definitions and application constants.
// Single source of truth — import these across the codebase for scalability.

// -----------------------------------------------------------------------------
// Accounts
// -----------------------------------------------------------------------------

export const ACCOUNTS = [
  "checkings",
  "short term savings",
  "bills",
  "freedom unlimited",
  "sapphire",
  "brokerage",
  "roth ira",
  "spaxx",
] as const;

export type account_type = (typeof ACCOUNTS)[number];

/** Accounts that can source funds for credit card expenses or payments */
export const FUNDING_ACCOUNTS = [
  "checkings",
  "bills",
  "short term savings",
] as const;

export type funding_account_type = (typeof FUNDING_ACCOUNTS)[number];

/** Credit cards that accumulate expenses and receive payments */
export const CREDIT_CARD_ACCOUNTS = ["sapphire", "freedom unlimited"] as const;

export type credit_card_account_type = (typeof CREDIT_CARD_ACCOUNTS)[number];

// -----------------------------------------------------------------------------
// Transaction Types
// -----------------------------------------------------------------------------

export const TRANSACTION_TYPES = ["expense", "income", "payment"] as const;

export type transaction_type = (typeof TRANSACTION_TYPES)[number];

// -----------------------------------------------------------------------------
// Default Accounts
// Fallback values when the caller doesn't specify an account.
// Change these in one place to update behavior across the entire codebase.
// -----------------------------------------------------------------------------

export const DEFAULT_EXPENSE_ACCOUNT: credit_card_account_type = "sapphire";
export const DEFAULT_INCOME_ACCOUNT: account_type = "checkings";
export const DEFAULT_PAYMENT_FROM: funding_account_type = "checkings";
export const DEFAULT_PAYMENT_TO: credit_card_account_type = "sapphire";
export const DEFAULT_FUNDING_ACCOUNT: funding_account_type = "checkings";

// -----------------------------------------------------------------------------
// Budget
// -----------------------------------------------------------------------------

export const DEFAULT_BUDGET_NAME = "default";

/** Known budget rule names — referenced in LLM prompts and validation */
export const KNOWN_BUDGET_NAMES = ["hunt", "msft", "default"] as const;

// -----------------------------------------------------------------------------
// Categories
// -----------------------------------------------------------------------------

/** Hardcoded fallback if Notion fetch fails — ensures system remains functional */
export const FALLBACK_CATEGORIES = [
  "paycheck",
  "out",
  "lyft",
  "shopping",
  "concerts",
  "zelle",
  "health",
  "groceries",
  "att",
  "chatgpt",
  "house",
  "car",
  "gas",
  "other",
] as const;

/** Categories in this map auto-assign funding_account when not explicitly provided */
export const CATEGORY_FUNDING_MAP: Record<string, funding_account_type> = {
  groceries: "bills",
  gas: "bills",
  att: "bills",
  car: "bills",
  house: "bills",
  chatgpt: "bills",
};

// -----------------------------------------------------------------------------
// Cache TTLs
// -----------------------------------------------------------------------------

/** Category cache lifespan — categories change occasionally */
export const CATEGORY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Data source ID cache — these are stable and almost never change */
export const DATA_SOURCE_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Account page ID cache — accounts change rarely */
export const ACCOUNT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// -----------------------------------------------------------------------------
// Dedup
// -----------------------------------------------------------------------------

/** Time window for duplicate detection (minutes) */
export const DEDUP_WINDOW_MINUTES = 5;

// -----------------------------------------------------------------------------
// Request Limits
// -----------------------------------------------------------------------------

/** Max request body size for Express JSON middleware */
export const REQUEST_BODY_LIMIT = "100kb";

// -----------------------------------------------------------------------------
// Type Guards
// -----------------------------------------------------------------------------

export function is_valid_account(value: string): value is account_type {
  return ACCOUNTS.includes(value as account_type);
}

export function is_valid_funding_account(
  value: string
): value is funding_account_type {
  return FUNDING_ACCOUNTS.includes(value as funding_account_type);
}

export function is_valid_credit_card_account(
  value: string
): value is credit_card_account_type {
  return CREDIT_CARD_ACCOUNTS.includes(value as credit_card_account_type);
}
