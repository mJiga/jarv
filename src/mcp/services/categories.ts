// src/services/categories.ts
import { notion, EXPENSES_DB_ID } from "../notion/client";
import {
  ensure_category_page,
  get_data_source_id_for_database,
} from "../notion/utils";

export interface update_last_expense_category_input {
  category: string; // e.g. "groceries", "out", "subscriptions"
}

export interface update_last_expense_category_result {
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
