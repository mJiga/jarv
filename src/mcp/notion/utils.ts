// src/mcp/notion/utils.ts
// Notion query helpers and shared utilities.
// Handles category caching, page lookups, data source caching, and common query patterns.

import {
  notion,
  ACCOUNTS_DB_ID,
  CATEGORIES_DB_ID,
  BUDGET_RULES_DB_ID,
} from "./client";
import {
  FALLBACK_CATEGORIES,
  CATEGORY_CACHE_TTL_MS,
  DATA_SOURCE_CACHE_TTL_MS,
  ACCOUNT_CACHE_TTL_MS,
  DEDUP_WINDOW_MINUTES,
} from "../constants";
import {
  with_data_sources,
  get_title_text,
  type notion_page,
  type data_source_query_params,
} from "./types";

// Typed wrapper — single escape hatch for the untyped dataSources API
const ds_client = with_data_sources(notion);

// -----------------------------------------------------------------------------
// Cache infrastructure
// -----------------------------------------------------------------------------

interface cache_entry<T> {
  value: T;
  timestamp: number;
}

/** Data source ID cache — eliminates ~4 redundant Notion API calls per transaction */
const data_source_id_cache = new Map<string, cache_entry<string>>();

/** Account page ID cache — accounts rarely change */
const account_page_id_cache = new Map<string, cache_entry<string>>();

// Category cache
let cached_categories: string[] | null = null;
let cache_timestamp: number = 0;

// -----------------------------------------------------------------------------
// Category Management
// -----------------------------------------------------------------------------

/**
 * Fetches category list from Notion with caching.
 * Returns cached value if within TTL, otherwise queries Notion.
 * Falls back to hardcoded list on error.
 */
export async function get_available_categories(): Promise<string[]> {
  const now = Date.now();

  if (cached_categories && now - cache_timestamp < CATEGORY_CACHE_TTL_MS) {
    return cached_categories;
  }

  try {
    const data_source_id = await get_data_source_id_for_database(
      CATEGORIES_DB_ID
    );

    const response = await ds_client.dataSources.query({
      data_source_id,
      page_size: 100,
    });

    const categories: string[] = (response.results || [])
      .map((page) => {
        return get_title_text(page).trim().toLowerCase();
      })
      .filter((cat): cat is string => !!cat);

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
 * Async to ensure the category cache is warm before checking.
 * Unknown categories are coerced to "other" to prevent invalid data.
 */
export async function validate_category(category: string): Promise<string> {
  const normalized = (category ?? "").trim().toLowerCase();
  const available = await get_available_categories();
  return available.includes(normalized) ? normalized : "other";
}

// -----------------------------------------------------------------------------
// Data Source Queries
// -----------------------------------------------------------------------------

/**
 * Retrieves the data source ID for a Notion database.
 * Cached — data source IDs are stable and almost never change.
 */
export async function get_data_source_id_for_database(
  database_id: string
): Promise<string> {
  const cached = data_source_id_cache.get(database_id);
  if (cached && Date.now() - cached.timestamp < DATA_SOURCE_CACHE_TTL_MS) {
    return cached.value;
  }

  const db = await notion.databases.retrieve({ database_id });
  const ds = (db as Record<string, unknown> & typeof db).data_sources as
    | Array<{ id: string }>
    | undefined;
  const first_ds = ds?.[0];
  if (!first_ds) {
    throw new Error(
      `No data source attached to database ${database_id}. Check Notion setup.`
    );
  }

  data_source_id_cache.set(database_id, {
    value: first_ds.id,
    timestamp: Date.now(),
  });
  return first_ds.id;
}

/**
 * Queries a database by exact title match.
 * Common pattern for looking up accounts, categories, budget rules.
 */
export async function query_data_source_by_title(
  database_id: string,
  title: string,
  page_size = 1
): Promise<notion_page[]> {
  const data_source_id = await get_data_source_id_for_database(database_id);

  const res = await ds_client.dataSources.query({
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
  filter: data_source_query_params["filter"],
  sorts?: data_source_query_params["sorts"],
  page_size = 100
): Promise<notion_page[]> {
  const data_source_id = await get_data_source_id_for_database(database_id);

  const query_params: data_source_query_params = {
    data_source_id,
    filter,
    page_size,
  };

  if (sorts && sorts.length > 0) {
    query_params.sorts = sorts;
  }

  const res = await ds_client.dataSources.query(query_params);

  return res.results;
}

// -----------------------------------------------------------------------------
// Page Lookups
// -----------------------------------------------------------------------------

/**
 * Resolves an account page ID by its title (e.g., "checkings").
 * Cached — account pages rarely change.
 */
export async function find_account_page_by_title(
  title: string
): Promise<string | null> {
  const cached = account_page_id_cache.get(title);
  if (cached && Date.now() - cached.timestamp < ACCOUNT_CACHE_TTL_MS) {
    return cached.value;
  }

  const results = await query_data_source_by_title(ACCOUNTS_DB_ID, title, 1);
  const id = results[0]?.id ?? null;

  if (id) {
    account_page_id_cache.set(title, { value: id, timestamp: Date.now() });
  }

  return id;
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
): Promise<notion_page[]> {
  return await query_data_source_by_title(BUDGET_RULES_DB_ID, rule_name, 100);
}

// -----------------------------------------------------------------------------
// Utility Functions
// -----------------------------------------------------------------------------

/** Extracts plain text from a Notion page title property */
export function get_page_title_text(page: Record<string, unknown>): string {
  return get_title_text(page as unknown as notion_page);
}

// -----------------------------------------------------------------------------
// Duplicate Detection
// -----------------------------------------------------------------------------

/**
 * Checks for a recent duplicate transaction in a Notion database.
 * Returns the existing page ID if a match is found, null otherwise.
 *
 * A transaction is considered a duplicate if ALL match within the time window:
 * - amount (exact match)
 * - account (relation contains the account page ID)
 * - date (transaction date)
 * - created_time (within the last N minutes)
 */
export async function find_recent_duplicate(
  db_id: string,
  amount: number,
  account_page_id: string,
  date: string,
  window_minutes: number = DEDUP_WINDOW_MINUTES
): Promise<string | null> {
  try {
    const cutoff = new Date(Date.now() - window_minutes * 60 * 1000);
    const cutoff_iso = cutoff.toISOString();

    const results = await query_data_source_with_filter(
      db_id,
      {
        and: [
          { property: "amount", number: { equals: amount } },
          { property: "accounts", relation: { contains: account_page_id } },
          { property: "date", date: { equals: date } },
          { timestamp: "created_time", created_time: { on_or_after: cutoff_iso } },
        ],
      },
      [{ timestamp: "created_time", direction: "descending" }],
      1
    );

    if (results.length > 0) {
      return results[0]?.id ?? null;
    }

    return null;
  } catch (err) {
    console.error("[dedup] Error checking for duplicate:", err);
    // On error, allow the transaction to proceed (fail open)
    return null;
  }
}

/**
 * Checks for a recent duplicate payment in the Payments DB.
 * Payments use from_account and to_account instead of a single accounts relation.
 */
export async function find_recent_duplicate_payment(
  db_id: string,
  amount: number,
  from_account_page_id: string,
  to_account_page_id: string,
  date: string,
  window_minutes: number = DEDUP_WINDOW_MINUTES
): Promise<string | null> {
  try {
    const cutoff = new Date(Date.now() - window_minutes * 60 * 1000);
    const cutoff_iso = cutoff.toISOString();

    const results = await query_data_source_with_filter(
      db_id,
      {
        and: [
          { property: "amount", number: { equals: amount } },
          { property: "from_account", relation: { contains: from_account_page_id } },
          { property: "to_account", relation: { contains: to_account_page_id } },
          { property: "date", date: { equals: date } },
          { timestamp: "created_time", created_time: { on_or_after: cutoff_iso } },
        ],
      },
      [{ timestamp: "created_time", direction: "descending" }],
      1
    );

    if (results.length > 0) {
      return results[0]?.id ?? null;
    }

    return null;
  } catch (err) {
    console.error("[dedup] Error checking for duplicate payment:", err);
    // On error, allow the payment to proceed (fail open)
    return null;
  }
}

// -----------------------------------------------------------------------------
// Shared Types
// -----------------------------------------------------------------------------

/** Fields stored on income rows in Notion. Shared by transactions and budgets. */
export interface income_db_fields {
  amount: number;
  account?: string | undefined;
  date?: string | undefined;
  pre_breakdown?: number | undefined; // Gross amount before budget split
  percentage?: number | undefined; // Fraction of gross (0-1)
  budget?: string | undefined; // Budget rule name
}
