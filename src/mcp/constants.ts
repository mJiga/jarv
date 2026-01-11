// src/mcp/constants.ts
// Centralized account definitions. Single source of truth for valid account names.

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

// Accounts that can source funds for credit card expenses or payments
export const FUNDING_ACCOUNTS = [
  "checkings",
  "bills",
  "short term savings",
] as const;

export type funding_account_type = (typeof FUNDING_ACCOUNTS)[number];

// Credit cards that accumulate expenses and receive payments
export const CREDIT_CARD_ACCOUNTS = ["sapphire", "freedom unlimited"] as const;

export type credit_card_account_type = (typeof CREDIT_CARD_ACCOUNTS)[number];

// Transaction types
export const TRANSACTION_TYPES = ["expense", "income", "payment"] as const;

export type transaction_type = (typeof TRANSACTION_TYPES)[number];

// Category-to-funding-account mapping
// Categories in this map auto-assign funding_account when not explicitly provided
export const CATEGORY_FUNDING_MAP: Record<string, funding_account_type> = {
  groceries: "bills",
  gas: "bills",
  att: "bills",
  car: "bills",
  house: "bills",
  chatgpt: "bills",
};

// Type guards for runtime validation

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
