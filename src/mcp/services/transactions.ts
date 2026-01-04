// src/services/transactions.ts
import { notion, EXPENSES_DB_ID, INCOME_DB_ID } from "../notion/client";

import {
  find_account_page_by_title,
  ensure_category_page,
  find_budget_rule_pages_by_title,
  transaction_type,
  income_db_fields,
} from "../notion/utils";

export type { transaction_type, income_db_fields };

/**
 * Input payload for add_transaction.
 * For incomes, this overlaps with income_db_fields; for expenses, some
 * properties (pre_breakdown, budget) are unused.
 */
export interface add_transaction_input extends Partial<income_db_fields> {
  amount: number;
  transaction_type: transaction_type;
  account?: string | undefined;
  date?: string | undefined;
  category?: string | undefined;
  note?: string | undefined;
}

export interface add_transaction_result {
  success: boolean;
  transactionId?: string;
  message?: string;
  error?: string;
}

export interface add_transactions_batch_input {
  transactions: add_transaction_input[];
}

export interface add_transactions_batch_item_result {
  index: number;
  success: boolean;
  transaction_id?: string | undefined;
  message?: string | undefined;
  error?: string | undefined;
}

export interface add_transactions_batch_result {
  success: boolean;
  results: add_transactions_batch_item_result[];
}

function build_title(input: add_transaction_input): string {
  const is_expense = input.transaction_type === "expense";
  const transaction_type = is_expense ? "expense" : "income";
  const amount_str = `$${input.amount}`;
  const acc = input.account;

  if (is_expense) {
    const cat = input.category || "other";
    return `${transaction_type} ${amount_str} ${cat} (${acc})`;
  } else {
    // For income, use budget (e.g., rule_name) if provided
    if (input.budget) {
      return `${input.budget} ${amount_str} (${acc})`;
    }
    return `${transaction_type} ${amount_str} (${acc})`;
  }
}

/**
 * Add multiple transactions in one call.
 * Each element is passed to add_transaction and its result is collected.
 */
export async function add_transactions_batch(
  input: add_transactions_batch_input
): Promise<add_transactions_batch_result> {
  const results: add_transactions_batch_item_result[] = [];

  const txs = input.transactions || [];

  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i];

    // Guard against undefined (satisfies TypeScript)
    if (!tx) {
      results.push({
        index: i,
        success: false,
        error: "transaction entry is undefined.",
      });
      continue;
    }

    try {
      const res: add_transaction_result = await add_transaction(tx);

      results.push({
        index: i,
        success: res.success,
        transaction_id: res.transactionId,
        message: res.message,
        error: res.error,
      });
    } catch (err: any) {
      console.error("error in add_transactions_batch item:", err);
      results.push({
        index: i,
        success: false,
        error: err?.message || "unknown error while adding transaction.",
      });
    }
  }

  return {
    success: true,
    results,
  };
}

export async function add_transaction(
  input: add_transaction_input
): Promise<add_transaction_result> {
  try {
    // validation
    if (typeof input.amount !== "number" || input.amount <= 0) {
      return { success: false, error: "amount must be a positive number." };
    }

    if (
      input.transaction_type !== "expense" &&
      input.transaction_type !== "income"
    ) {
      return {
        success: false,
        error: "transaction_type must be 'expense' or 'income'.",
      };
    }

    // Default account: sapphire for expenses, checkings for income
    const default_account =
      input.transaction_type === "expense" ? "sapphire" : "checkings";
    const account_name = input.account || default_account;

    // allowed categories - default to "other" if not in list
    const allowed_categories = [
      "out",
      "food",
      "att",
      "chatgpt",
      "lyft",
      "shopping",
      "health",
      "car",
      "house",
      "other",
    ] as const;

    const category_name = allowed_categories.includes(input.category as any)
      ? input.category!
      : "other";

    // allowed accounts guard
    const allowed_accounts = [
      "checkings",
      "short term savings",
      "bills",
      "freedom unlimited",
      "sapphire",
      "brokerage",
      "roth ira",
      "spaxx",
    ] as const;

    if (!allowed_accounts.includes(account_name as any)) {
      return {
        success: false,
        error:
          "account must be one of: checkings, short term savings, bills, freedom unlimited, sapphire, brokerage, roth ira, spaxx.",
      };
    }

    // resolve relations
    const account_page_id = await find_account_page_by_title(account_name);
    if (!account_page_id) {
      return {
        success: false,
        error: `account page '${account_name}' not found in Notion Accounts DB.`,
      };
    }

    const category_page_id =
      input.transaction_type === "expense"
        ? await ensure_category_page(category_name)
        : null;

    // default to today if missing
    const today = new Date();
    const iso_date = input.date || today.toISOString().slice(0, 10); // "YYYY-MM-DD"

    const title = build_title({
      amount: input.amount,
      transaction_type: input.transaction_type,
      account: account_name,
      category: category_name,
      date: iso_date,
      budget: input.budget,
    });

    let response;

    if (input.transaction_type === "expense") {
      // --- EXPENSES DB ---
      const properties: any = {
        title: {
          title: [
            {
              text: { content: title },
            },
          ],
        },
        date: {
          date: {
            start: iso_date,
          },
        },
        amount: {
          number: input.amount,
        },
        accounts: {
          relation: [{ id: account_page_id }],
        },
        categories: {
          relation: [{ id: category_page_id! }],
        },
      };

      if (input.note) {
        properties.note = {
          rich_text: [
            {
              text: { content: input.note },
            },
          ],
        };
      }

      response = await notion.pages.create({
        parent: { database_id: EXPENSES_DB_ID },
        properties,
      });
    } else {
      // --- INCOME DB ---
      // Look up the budget page by name (default to "default")
      const budget_name = input.budget || "default";
      const budget_pages = await find_budget_rule_pages_by_title(budget_name);

      // Find the budget page that matches this account
      let budget_page_id: string | null = null;
      for (const page of budget_pages) {
        const relation = page.properties?.account?.relation?.[0];
        if (relation?.id === account_page_id) {
          budget_page_id = page.id;
          break;
        }
      }

      if (!budget_page_id) {
        return {
          success: false,
          error: `No budget rule '${budget_name}' found for account '${account_name}'.`,
        };
      }

      // pre_breakdown defaults to amount if not provided (for single income, not split)
      const pre_breakdown =
        typeof input.pre_breakdown === "number"
          ? input.pre_breakdown
          : input.amount;

      response = await notion.pages.create({
        parent: { database_id: INCOME_DB_ID },
        properties: {
          title: {
            title: [
              {
                text: { content: title },
              },
            ],
          },
          date: {
            date: {
              start: iso_date,
            },
          },
          amount: {
            number: input.amount,
          },
          pre_breakdown: {
            number: pre_breakdown,
          },
          // budget is a relation, percentage is a rollup (auto-calculated)
          budget: {
            relation: [{ id: budget_page_id }],
          },
          accounts: {
            relation: [{ id: account_page_id }],
          },
        },
      });
    }

    const base_msg = `added ${input.transaction_type} of $${input.amount} to ${account_name}`;

    const message =
      input.transaction_type === "expense"
        ? `${base_msg} (category: ${category_name}).`
        : `${base_msg}.`;

    return {
      success: true,
      transactionId: response.id,
      message,
    };
  } catch (err: any) {
    console.error("error adding transaction to Notion:", err);
    return {
      success: false,
      error: err?.message || "unknown error while adding transaction.",
    };
  }
}
