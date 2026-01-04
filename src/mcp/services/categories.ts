// src/services/categories.ts
import { notion, EXPENSES_DB_ID, CATEGORIES_DB_ID } from "../notion/client";
import {
  ensure_category_page,
  get_data_source_id_for_database,
} from "../notion/utils";

/* ──────────────────────────────
 * Types
 * ────────────────────────────── */

export interface update_last_expense_category_input {
  category: string; // e.g. "groceries", "out", "subscriptions"
}

export interface update_last_expense_category_result {
  success: boolean;
  expense_id?: string | undefined;
  category?: string | undefined;
  error?: string | undefined;
}

export interface uncategorized_expense {
  id: string;
  amount: number;
  note: string;
  date: string;
}

export interface get_uncategorized_expenses_result {
  success: boolean;
  expenses?: uncategorized_expense[] | undefined;
  error?: string | undefined;
}

export interface update_expense_category_input {
  expense_id: string;
  category: string;
}

export interface update_expense_category_result {
  success: boolean;
  expense_id?: string | undefined;
  category?: string | undefined;
  error?: string | undefined;
}

/**
 * Update the category of the most recently added expense.
 * Queries the Expenses DB sorted by created_time descending and updates the first result.
 */
export async function update_last_expense_category(
  input: update_last_expense_category_input
): Promise<update_last_expense_category_result> {
  try {
    // Query for the most recent expense using Data Sources API (Notion SDK v5)
    const data_source_id = await get_data_source_id_for_database(
      EXPENSES_DB_ID
    );

    const response = await (notion as any).dataSources.query({
      data_source_id,
      sorts: [
        {
          timestamp: "created_time",
          direction: "descending",
        },
      ],
      page_size: 1,
    });

    if (!response.results || response.results.length === 0) {
      return {
        success: false,
        error: "No expenses found in the database.",
      };
    }

    const last_expense = response.results[0];
    const expense_id = last_expense.id;

    const category_page_id = await ensure_category_page(input.category);

    await notion.pages.update({
      page_id: expense_id,
      properties: {
        categories: {
          relation: [{ id: category_page_id }],
        },
      },
    });

    return {
      success: true,
      expense_id,
      category: input.category,
    };
  } catch (err: any) {
    console.error("error updating last expense category:", err);
    return {
      success: false,
      error: err?.message || "unknown error updating last expense category.",
    };
  }
}

/* ──────────────────────────────
 * get_uncategorized_expenses
 * ────────────────────────────── */

/**
 * Returns all expenses that have category "other" — the inbox.
 * Agent can use this to review and re-categorize them.
 */
export async function get_uncategorized_expenses(): Promise<get_uncategorized_expenses_result> {
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

    const expenses: uncategorized_expense[] = (response.results || []).map(
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
    console.error("error getting uncategorized expenses:", err);
    return {
      success: false,
      error: err?.message || "unknown error getting uncategorized expenses.",
    };
  }
}

/* ──────────────────────────────
 * update_expense_category
 * ────────────────────────────── */

/**
 * Update a specific expense's category by its page ID.
 */
export async function update_expense_category(
  input: update_expense_category_input
): Promise<update_expense_category_result> {
  try {
    const category_page_id = await ensure_category_page(input.category);

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
      category: input.category,
    };
  } catch (err: any) {
    console.error("error updating expense category:", err);
    return {
      success: false,
      error: err?.message || "unknown error updating expense category.",
    };
  }
}
