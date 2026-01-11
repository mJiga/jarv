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
