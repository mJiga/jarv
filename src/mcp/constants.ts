// src/mcp/constants.ts
// Shared account constants used across the MCP server and services

/**
 * All valid account names in the system.
 */
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

/**
 * Accounts that can fund credit card expenses or payments.
 */
export const FUNDING_ACCOUNTS = [
  "checkings",
  "bills",
  "short term savings",
] as const;

export type funding_account_type = (typeof FUNDING_ACCOUNTS)[number];

/**
 * Credit card accounts.
 */
export const CREDIT_CARD_ACCOUNTS = ["sapphire", "freedom unlimited"] as const;

export type credit_card_account_type = (typeof CREDIT_CARD_ACCOUNTS)[number];

/**
 * Helper to check if a string is a valid account.
 */
export function is_valid_account(value: string): value is account_type {
  return ACCOUNTS.includes(value as account_type);
}

/**
 * Helper to check if a string is a valid funding account.
 */
export function is_valid_funding_account(
  value: string
): value is funding_account_type {
  return FUNDING_ACCOUNTS.includes(value as funding_account_type);
}

/**
 * Helper to check if a string is a valid credit card account.
 */
export function is_valid_credit_card_account(
  value: string
): value is credit_card_account_type {
  return CREDIT_CARD_ACCOUNTS.includes(value as credit_card_account_type);
}
