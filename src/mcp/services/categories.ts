// src/mcp/services/categories.ts
// Category management for expenses.
// Handles uncategorized inbox (category="other") and category updates.

import { notion, EXPENSES_DB_ID, CATEGORIES_DB_ID } from "../notion/client";
import {
  ensure_category_page,
  get_data_source_id_for_database,
  validate_category,
} from "../notion/utils";
import { with_data_sources, get_number_prop, get_rich_text_prop, get_date_prop, type notion_page } from "../notion/types";

const ds_client = with_data_sources(notion);

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface uncategorized_transaction {
  id: string;
  amount: number;
  note: string;
  date: string;
}

export interface get_uncategorized_transactions_result {
  success: boolean;
  expenses?: uncategorized_transaction[] | undefined;
  error?: string | undefined;
}

export interface update_transaction_category_input {
  expense_id: string;
  category: string;
}

export interface update_transaction_category_result {
  success: boolean;
  expense_id?: string | undefined;
  category?: string | undefined;
  error?: string | undefined;
}

// -----------------------------------------------------------------------------
// Get Uncategorized (Inbox)
// -----------------------------------------------------------------------------

/**
 * Fetches expenses with category="other" (the inbox).
 * These are transactions that need manual categorization.
 * Returns up to 50 most recent uncategorized expenses.
 */
export async function get_uncategorized_transactions(): Promise<get_uncategorized_transactions_result> {
  try {
    // Find the "other" category page
    const categories_ds_id = await get_data_source_id_for_database(
      CATEGORIES_DB_ID
    );
    const cat_response = await ds_client.dataSources.query({
      data_source_id: categories_ds_id,
      filter: {
        property: "title",
        title: { equals: "other" },
      },
      page_size: 1,
    });

    if (!cat_response.results?.length) {
      return { success: true, expenses: [] };
    }

    const other_category_id = cat_response.results[0]?.id;
    if (!other_category_id) {
      return { success: true, expenses: [] };
    }

    // Query expenses linked to "other" category
    const expenses_ds_id = await get_data_source_id_for_database(EXPENSES_DB_ID);
    const response = await ds_client.dataSources.query({
      data_source_id: expenses_ds_id,
      filter: {
        property: "categories",
        relation: { contains: other_category_id },
      },
      sorts: [{ timestamp: "created_time", direction: "descending" }],
      page_size: 50,
    });

    const expenses: uncategorized_transaction[] = (response.results || []).map(
      (page: notion_page) => {
        return {
          id: page.id,
          amount: get_number_prop(page.properties, "amount") ?? 0,
          note: get_rich_text_prop(page.properties, "note"),
          date: get_date_prop(page.properties, "date"),
        };
      }
    );

    return { success: true, expenses };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "unknown error getting uncategorized transactions.";
    console.error("error getting uncategorized transactions:", err);
    return {
      success: false,
      error: message,
    };
  }
}

// -----------------------------------------------------------------------------
// Update Category
// -----------------------------------------------------------------------------

/**
 * Updates the category of a single expense.
 * Invalid categories are coerced to "other".
 */
export async function update_transaction_category(
  input: update_transaction_category_input
): Promise<update_transaction_category_result> {
  try {
    const validated_category = await validate_category(input.category);
    const category_page_id = await ensure_category_page(validated_category);

    await notion.pages.update({
      page_id: input.expense_id,
      properties: {
        categories: {
          relation: [{ id: category_page_id }],
        },
      },
    });

    return {
      success: true,
      expense_id: input.expense_id,
      category: validated_category,
    };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "unknown error updating transaction category.";
    console.error("error updating transaction category:", err);
    return {
      success: false,
      error: message,
    };
  }
}

// -----------------------------------------------------------------------------
// Batch Update
// -----------------------------------------------------------------------------

export interface update_transaction_categories_batch_input {
  updates: Array<{
    expense_id: string;
    category: string;
  }>;
}

export interface batch_category_result {
  expense_id: string;
  category: string;
  success: boolean;
  error?: string | undefined;
}

export interface update_transaction_categories_batch_result {
  success: boolean;
  results: batch_category_result[];
  success_count: number;
}

/**
 * Updates categories for multiple expenses.
 * Processes sequentially; individual failures don't block others.
 */
export async function update_transaction_categories_batch(
  input: update_transaction_categories_batch_input
): Promise<update_transaction_categories_batch_result> {
  const results: batch_category_result[] = [];

  for (const update of input.updates) {
    try {
      const res = await update_transaction_category({
        expense_id: update.expense_id,
        category: update.category,
      });
      results.push({
        expense_id: update.expense_id,
        category: update.category,
        success: !!res.success,
        error: res.error,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        expense_id: update.expense_id,
        category: update.category,
        success: false,
        error: message,
      });
    }
  }

  const success_count = results.filter((r) => r.success).length;

  return {
    success: success_count > 0,
    results,
    success_count,
  };
}
