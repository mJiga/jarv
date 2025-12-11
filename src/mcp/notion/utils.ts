// src/notion/utils.ts
import {
  notion,
  ACCOUNTS_DB_ID,
  CATEGORIES_DB_ID,
  BUDGET_RULES_DB_ID,
} from "./client";

/**
 * Get the first data source id attached to a database.
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
 * Generic helper: query a data source by exact title.
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
 * Accounts DB: resolve account page by title ("checkings", "savings", ...).
 */
export async function find_account_page_by_title(
  title: string
): Promise<string | null> {
  const results = await query_data_source_by_title(ACCOUNTS_DB_ID, title, 1);
  const first = results[0];
  return first ? first.id : null;
}

/**
 * Categories DB: resolve category page by title ("out", "food", ...).
 */
export async function find_category_page_by_title(
  title: string
): Promise<string | null> {
  const results = await query_data_source_by_title(CATEGORIES_DB_ID, title, 1);
  const first = results[0];
  return first ? first.id : null;
}

/**
 * Ensure a category page exists; create it if missing.
 */
export async function ensure_category_page(title: string): Promise<string> {
  const existing_id = await find_category_page_by_title(title);
  if (existing_id) return existing_id;

  const created = await notion.pages.create({
    parent: { database_id: CATEGORIES_DB_ID },
    properties: {
      title: {
        title: [
          {
            text: { content: title },
          },
        ],
      },
    },
  });

  return created.id;
}

/**
 * Budget rules DB: find all pages for a given rule name (title).
 */
export async function find_budget_rule_pages_by_title(
  rule_name: string
): Promise<any[]> {
  // up to 100 allocations per rule is plenty
  return await query_data_source_by_title(BUDGET_RULES_DB_ID, rule_name, 100);
}

/**
 * Safely get the plain-text title of a page.
 */
export function get_page_title_text(page: any): string {
  const title = page?.properties?.title?.title;
  if (!Array.isArray(title) || title.length === 0) return "";
  return title[0]?.plain_text ?? "";
}

/* ──────────────────────────────
 * Shared Types
 * ────────────────────────────── */

export type transaction_type = "expense" | "income";

/**
 * Fields that live on an income row in the Notion Income DB.
 * Shared by transactions and budgets modules.
 */
export interface income_db_fields {
  amount: number; // net amount hitting this account
  account: string; // account title (e.g., "checkings")
  date: string; // ISO "YYYY-MM-DD"
  pre_breakdown?: number | undefined; // total gross paycheck / original amount
  percentage?: number | undefined; // fraction (0–1) of gross going into this row
  budget?: string | undefined; // label for the budget rule (e.g., rule_name)
}
