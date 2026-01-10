// src/agent/flows/inbox_cleanup.ts
import { infer_action } from "../llm/gemini_client";
import {
  call_get_uncategorized_expenses_tool,
  call_update_expense_category_batch_tool,
} from "../mcp_client";

export interface inbox_cleanup_result {
  success: boolean;
  message: string;
  applied_count?: number;
  updates?: string[];
}

/**
 * Multi-step flow: fetch uncategorized expenses, ask Gemini to categorize them, apply directly.
 */
export async function run_inbox_cleanup(): Promise<inbox_cleanup_result> {
  const get_result = await call_get_uncategorized_expenses_tool();
  const expenses = get_result.raw?.result?.structuredContent?.expenses || [];

  if (expenses.length === 0) {
    return {
      success: true,
      message: "No uncategorized expenses found. Inbox is clean!",
    };
  }

  const categorize_message = `Categorize these expenses by their notes. For each, infer the best category:
${expenses.map((e: any) => `- id: "${e.id}", note: "${e.note}"`).join("\n")}`;

  console.log("[inbox_cleanup] Asking Gemini to categorize expenses...");
  const categorize_action = await infer_action(categorize_message);
  console.log("[inbox_cleanup] Categorization action:", categorize_action);

  if (categorize_action.action !== "update_expense_category_batch") {
    return {
      success: false,
      message: `Found ${expenses.length} uncategorized expenses but couldn't categorize them.`,
    };
  }

  // Apply directly
  const batch_result = await call_update_expense_category_batch_tool({
    updates: categorize_action.args.updates,
  });

  const results = batch_result.raw?.result?.structuredContent?.results || [];
  const applied_count = results.filter((r: any) => r.ok).length;

  const updates_preview: string[] = [];
  for (const update of categorize_action.args.updates) {
    const expense = expenses.find((e: any) => e.id === update.expense_id);
    updates_preview.push(
      `$${expense?.amount ?? "?"} "${expense?.note ?? "?"}" → ${
        update.category
      }`
    );
  }

  return {
    success: true,
    applied_count,
    updates: updates_preview,
    message: `Applied ${applied_count}/${
      results.length
    } category update(s):\n${updates_preview.join("\n")}`,
  };
}
