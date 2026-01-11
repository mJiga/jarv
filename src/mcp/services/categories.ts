// src/mcp/services/categories.ts
import { notion, EXPENSES_DB_ID, CATEGORIES_DB_ID } from "../notion/client";
import {
  ensure_category_page,
  get_data_source_id_for_database,
  validate_category,
} from "../notion/utils";

/* ──────────────────────────────
 * Types
 * ────────────────────────────── */

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

/* ──────────────────────────────
 * get_uncategorized_transactions
 * ────────────────────────────── */

/**
 * Returns all expenses that have category "other" — the inbox.
 * Agent can use this to review and re-categorize them.
 */
export async function get_uncategorized_transactions(): Promise<get_uncategorized_transactions_result> {
  try {
    // First, find the "other" category page id
    const categories_ds_id = await get_data_source_id_for_database(
      CATEGORIES_DB_ID
    );
    const cat_response = await (notion as any).dataSources.query({
      data_source_id: categories_ds_id,
      filter: {
        property: "title",
        title: { equals: "other" },
      },
      page_size: 1,
    });

    if (!cat_response.results || cat_response.results.length === 0) {
      return { success: true, expenses: [] }; // no "other" category exists
    }

    const other_category_id = cat_response.results[0].id;

    // Query expenses that have category relation to "other"
    const expenses_ds_id = await get_data_source_id_for_database(
      EXPENSES_DB_ID
    );
    const response = await (notion as any).dataSources.query({
      data_source_id: expenses_ds_id,
      filter: {
        property: "categories",
        relation: { contains: other_category_id },
      },
      sorts: [{ timestamp: "created_time", direction: "descending" }],
      page_size: 50, // reasonable limit
    });

    const expenses: uncategorized_transaction[] = (response.results || []).map(
      (page: any) => {
        const props = page.properties;

        // Extract amount
        const amount = props?.amount?.number ?? 0;

        // Extract note (rich_text)
        const note_arr = props?.note?.rich_text;
        const note =
          Array.isArray(note_arr) && note_arr.length > 0
            ? note_arr[0]?.plain_text ?? ""
            : "";

        // Extract date
        const date = props?.date?.date?.start ?? "";

        return { id: page.id, amount, note, date };
      }
    );

    return { success: true, expenses };
  } catch (err: any) {
    console.error("error getting uncategorized transactions:", err);
    return {
      success: false,
      error: err?.message || "unknown error getting uncategorized transactions.",
    };
  }
}

/* ──────────────────────────────
 * update_transaction_category
 * ────────────────────────────── */

/**
 * Update a specific expense's category by its page ID.
 */
export async function update_transaction_category(
  input: update_transaction_category_input
): Promise<update_transaction_category_result> {
  try {
    // Validate category - force "other" if invalid
    const validated_category = validate_category(input.category);

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
  } catch (err: any) {
    console.error("error updating transaction category:", err);
    return {
      success: false,
      error: err?.message || "unknown error updating transaction category.",
    };
  }
}

/* ──────────────────────────────
 * update_transaction_categories_batch
 * ────────────────────────────── */

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
 * Update categories for multiple expenses at once.
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
    } catch (err: any) {
      results.push({
        expense_id: update.expense_id,
        category: update.category,
        success: false,
        error: err?.message ?? String(err),
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
