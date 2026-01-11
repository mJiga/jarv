// src/mcp/notion/utils.ts
// Notion query helpers and shared utilities.
// Handles category caching, page lookups, and common query patterns.

import {
  notion,
  ACCOUNTS_DB_ID,
  CATEGORIES_DB_ID,
  BUDGET_RULES_DB_ID,
} from "./client";

// -----------------------------------------------------------------------------
// Category Management
// -----------------------------------------------------------------------------

// Fallback if Notion fetch fails - ensures system remains functional
const FALLBACK_CATEGORIES = [
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

// In-memory cache to reduce Notion API calls
let cached_categories: string[] | null = null;
let cache_timestamp: number = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetches category list from Notion with caching.
 * Returns cached value if within TTL, otherwise queries Notion.
 * Falls back to hardcoded list on error.
 */
export async function get_available_categories(): Promise<string[]> {
  const now = Date.now();

  if (cached_categories && now - cache_timestamp < CACHE_TTL_MS) {
    return cached_categories;
  }

  try {
    const data_source_id = await get_data_source_id_for_database(
      CATEGORIES_DB_ID
    );

    const response = await (notion as any).dataSources.query({
      data_source_id,
      page_size: 100,
    });

    const categories: string[] = (response.results || [])
      .map((page: any) => {
        const title = page?.properties?.title?.title;
        if (!Array.isArray(title) || title.length === 0) return null;
        return (title[0]?.plain_text ?? "").trim().toLowerCase();
      })
      .filter((cat: string | null): cat is string => !!cat);

    // Ensure "other" always exists as the catch-all category
    if (!categories.includes("other")) {
      categories.push("other");
    }

    cached_categories = categories;
    cache_timestamp = now;

    return categories;
  } catch (err) {
    console.error("Error fetching categories from Notion:", err);
    return cached_categories ?? [...FALLBACK_CATEGORIES];
  }
}

/**
 * Validates and normalizes a category string.
 * Unknown categories are coerced to "other" to prevent invalid data.
 */
export function validate_category(category: string): string {
  const normalized = (category ?? "").trim().toLowerCase();
  const available: readonly string[] = cached_categories ?? FALLBACK_CATEGORIES;
  return available.includes(normalized) ? normalized : "other";
}

// -----------------------------------------------------------------------------
// Data Source Queries
// -----------------------------------------------------------------------------

/**
 * Retrieves the data source ID for a Notion database.
 * Required for using the dataSources.query API.
 */
export async function get_data_source_id_for_database(
  database_id: string
): Promise<string> {
  const db: any = await notion.databases.retrieve({ database_id });
  const ds = db.data_sources?.[0];
  if (!ds) {
    throw new Error(
      `No data source attached to database ${database_id}. Check Notion setup.`
    );
  }
  return ds.id;
}

/**
 * Queries a database by exact title match.
 * Common pattern for looking up accounts, categories, budget rules.
 */
export async function query_data_source_by_title(
  database_id: string,
  title: string,
  page_size = 1
): Promise<any[]> {
  const data_source_id = await get_data_source_id_for_database(database_id);

  const res = await (notion as any).dataSources.query({
    data_source_id,
    filter: {
      property: "title",
      title: { equals: title },
    },
    page_size,
  });

  return res.results;
}

/**
 * Queries a database with a custom filter and optional sorting.
 * Used for complex queries like finding uncleared expenses.
 */
export async function query_data_source_with_filter(
  database_id: string,
  filter: any,
  sorts?: any[],
  page_size = 100
): Promise<any[]> {
  const data_source_id = await get_data_source_id_for_database(database_id);

  const query_params: any = {
    data_source_id,
    filter,
    page_size,
  };

  if (sorts && sorts.length > 0) {
    query_params.sorts = sorts;
  }

  const res = await (notion as any).dataSources.query(query_params);

  return res.results;
}

// -----------------------------------------------------------------------------
// Page Lookups
// -----------------------------------------------------------------------------

/** Resolves an account page ID by its title (e.g., "checkings") */
export async function find_account_page_by_title(
  title: string
): Promise<string | null> {
  const results = await query_data_source_by_title(ACCOUNTS_DB_ID, title, 1);
  return results[0]?.id ?? null;
}

/** Resolves a category page ID by its title (e.g., "groceries") */
export async function find_category_page_by_title(
  title: string
): Promise<string | null> {
  const results = await query_data_source_by_title(CATEGORIES_DB_ID, title, 1);
  return results[0]?.id ?? null;
}

/**
 * Gets or creates a category page.
 * Safe to call with validated categories - won't create arbitrary new ones
 * since validate_category() should be called first.
 */
export async function ensure_category_page(title: string): Promise<string> {
  const existing_id = await find_category_page_by_title(title);
  if (existing_id) return existing_id;

  const created = await notion.pages.create({
    parent: { database_id: CATEGORIES_DB_ID },
    properties: {
      title: {
        title: [{ text: { content: title } }],
      },
    },
  });

  return created.id;
}

/** Finds all budget rule pages for a given rule name (up to 100 allocations) */
export async function find_budget_rule_pages_by_title(
  rule_name: string
): Promise<any[]> {
  return await query_data_source_by_title(BUDGET_RULES_DB_ID, rule_name, 100);
}

// -----------------------------------------------------------------------------
// Utility Functions
// -----------------------------------------------------------------------------

/** Extracts plain text from a Notion page title property */
export function get_page_title_text(page: any): string {
  const title = page?.properties?.title?.title;
  if (!Array.isArray(title) || title.length === 0) return "";
  return title[0]?.plain_text ?? "";
}

// -----------------------------------------------------------------------------
// Shared Types
// -----------------------------------------------------------------------------

/** Transaction types supported by add_transaction */
export type transaction_type = "expense" | "income" | "payment";

/** Fields stored on income rows in Notion. Shared by transactions and budgets. */
export interface income_db_fields {
  amount: number;
  account?: string | undefined;
  date?: string | undefined;
  pre_breakdown?: number | undefined; // Gross amount before budget split
  percentage?: number | undefined; // Fraction of gross (0-1)
  budget?: string | undefined; // Budget rule name
}
