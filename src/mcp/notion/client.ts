// src/mcp/notion/client.ts
// Notion API client and database ID exports.
// All Notion interactions flow through this client.

import "dotenv/config";
import { Client } from "@notionhq/client";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set in .env`);
  }
  return value;
}

export const notion = new Client({ auth: requireEnv("NOTION_API_KEY") });

// Database IDs - each maps to a distinct Notion database
export const EXPENSES_DB_ID = requireEnv("EXPENSES_DB_ID");
export const INCOME_DB_ID = requireEnv("INCOME_DB_ID");
export const ACCOUNTS_DB_ID = requireEnv("ACCOUNTS_DB_ID");
export const CATEGORIES_DB_ID = requireEnv("CATEGORIES_DB_ID");
export const BUDGET_RULES_DB_ID = requireEnv("BUDGET_RULES_DB_ID");
export const PAYMENTS_DB_ID = requireEnv("PAYMENTS_DB_ID");
