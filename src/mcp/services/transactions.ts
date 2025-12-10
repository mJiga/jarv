// src/services/transactions.ts
import { notion, EXPENSES_DB_ID, INCOME_DB_ID } from "../notion/client";

import {
  find_account_page_by_title,
  ensure_category_page,
} from "../notion/utils";

export type transaction_type = "expense" | "income";

/**
 * This describes the fields that live on an income row in the notion income DB.
 */
export interface income_db_fields {
  amount: number; // net amount hitting this account
  account: string; // account title (e.g., "checkings")
  date: string; // ISO "YYYY-MM-DD"
  pre_breakdown?: number; // total gross paycheck / original amount
  budget?: number; // fraction (0–1) of gross going into this row
}

/**
 * Input payload for add_transaction.
 * For incomes, this overlaps with income_db_fields; for expenses, some
 * properties (pre_breakdown, budget) are unused.
 */
export interface add_transaction_input extends Partial<income_db_fields> {
  amount: number;
  transaction_type: transaction_type;
  category?: string | undefined;
  memo?: string | undefined; // optional label (e.g., rule_name for income splits)
}

export interface add_transaction_result {
  success: boolean;
  transactionId?: string;
  message?: string;
  error?: string;
}

function build_title(input: add_transaction_input): string {
  const is_expense = input.transaction_type === "expense";
  const transaction_type = is_expense ? "expense" : "income";
  const amount_str = `$${input.amount}`;
  const acc = input.account || "cash";

  if (is_expense) {
    const cat = input.category || "other";
    return `${transaction_type} ${amount_str} ${cat} (${acc})`;
  } else {
    // For income, use memo (e.g., rule_name) if provided
    if (input.memo) {
      return `${input.memo} ${amount_str} (${acc})`;
    }
    return `${transaction_type} ${amount_str} (${acc})`;
  }
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

    const account_name = input.account || "freedom unlimited";
    const category_name = input.category || "other";

    // allowed accounts guard
    const allowed_accounts = [
      "checkings",
      "short term savings",
      "freedom unlimited",
      "brokerage",
      "roth ira",
      "spaxx",
    ] as const;

    if (!allowed_accounts.includes(account_name as any)) {
      return {
        success: false,
        error:
          "account must be one of: checkings, savings, freedom unlimited, brokerage, roth ira, spaxx.",
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
      memo: input.memo,
    });

    let response;

    if (input.transaction_type === "expense") {
      // --- EXPENSES DB ---
      response = await notion.pages.create({
        parent: { database_id: EXPENSES_DB_ID },
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
          accounts: {
            relation: [{ id: account_page_id }],
          },
          categories: {
            relation: [{ id: category_page_id! }],
          },
        },
      });
    } else {
      // --- INCOME DB ---
      // If split_paycheck passes pre_breakdown/budget, use those; otherwise default.
      const pre_breakdown =
        typeof input.pre_breakdown === "number"
          ? input.pre_breakdown
          : input.amount;
      const budget = typeof input.budget === "number" ? input.budget : 1;

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
          budget: {
            number: budget,
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
