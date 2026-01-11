// src/mcp/services/transactions.ts
// Transaction creation logic for expenses, income, and payments.
// Unified entry point: add_transaction handles all three types.

import { notion, EXPENSES_DB_ID, INCOME_DB_ID } from "../notion/client";
import {
  find_account_page_by_title,
  ensure_category_page,
  find_budget_rule_pages_by_title,
  transaction_type,
  income_db_fields,
  validate_category,
} from "../notion/utils";
import {
  ACCOUNTS,
  FUNDING_ACCOUNTS,
  CATEGORY_FUNDING_MAP,
  is_valid_account,
  is_valid_funding_account,
  is_valid_credit_card_account,
} from "../constants";
import {
  create_payment,
  create_payment_result,
  cleared_expense_info,
} from "./payments";

export type { transaction_type, income_db_fields };

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface add_transaction_input extends Partial<income_db_fields> {
  amount: number;
  transaction_type: transaction_type;
  account?: string | undefined;
  date?: string | undefined;
  category?: string | undefined;
  note?: string | undefined;
  funding_account?: string | undefined; // Which account funds credit card expenses
  from_account?: string | undefined; // Payment source (for payments)
  to_account?: string | undefined; // Payment destination (for payments)
}

export interface add_transaction_result {
  success: boolean;
  transaction_id?: string | undefined;
  message?: string | undefined;
  error?: string | undefined;
  // Payment-specific: details about cleared expenses
  cleared_expenses?: cleared_expense_info[] | undefined;
  cleared_total?: number | undefined;
  remaining_unapplied?: number | undefined;
}

// -----------------------------------------------------------------------------
// Core Logic
// -----------------------------------------------------------------------------

/** Generates a descriptive title for Notion page */
function build_title(input: add_transaction_input): string {
  const amount_str = `$${input.amount}`;
  const acc = input.account;

  if (input.transaction_type === "expense") {
    const cat = input.category || "other";
    return `expense ${amount_str} ${cat} (${acc})`;
  }

  // Income: prefer budget name in title if provided
  if (input.budget) {
    return `${input.budget} ${amount_str} (${acc})`;
  }
  return `income ${amount_str} (${acc})`;
}

/**
 * Creates a transaction in Notion.
 * Routes to appropriate handler based on transaction_type:
 * - "payment" -> create_payment (handles auto-clearing)
 * - "expense" -> Expenses DB
 * - "income" -> Income DB (requires matching budget rule)
 */
export async function add_transaction(
  input: add_transaction_input
): Promise<add_transaction_result> {
  try {
    // Input validation
    if (typeof input.amount !== "number" || input.amount <= 0) {
      return { success: false, error: "amount must be a positive number." };
    }

    if (!["expense", "income", "payment"].includes(input.transaction_type)) {
      return {
        success: false,
        error: "transaction_type must be 'expense', 'income', or 'payment'.",
      };
    }

    // Delegate payments to specialized handler
    if (input.transaction_type === "payment") {
      const payment_result = await create_payment({
        amount: input.amount,
        from_account: input.from_account,
        to_account: input.to_account,
        date: input.date,
        note: input.note,
        category: input.category,
      });

      return {
        success: payment_result.success,
        transaction_id: payment_result.payment_id,
        message: payment_result.message,
        error: payment_result.error,
        cleared_expenses: payment_result.cleared_expenses,
        cleared_total: payment_result.cleared_total,
        remaining_unapplied: payment_result.remaining_unapplied,
      };
    }

    // Resolve account (defaults: sapphire for expenses, checkings for income)
    const default_account =
      input.transaction_type === "expense" ? "sapphire" : "checkings";
    const account_name = input.account || default_account;

    // Validate category - unknown values become "other"
    const category_name = validate_category(input.category ?? "");

    if (!is_valid_account(account_name)) {
      return {
        success: false,
        error: `account must be one of: ${ACCOUNTS.join(", ")}.`,
      };
    }

    const account_page_id = await find_account_page_by_title(account_name);
    if (!account_page_id) {
      return {
        success: false,
        error: `account page '${account_name}' not found in Notion Accounts DB.`,
      };
    }

    const category_page_id = await ensure_category_page(category_name);

    // Credit card expenses need a funding account
    const is_credit_card = is_valid_credit_card_account(account_name);
    let funding_account_page_id: string | null = null;

    if (input.transaction_type === "expense" && is_credit_card) {
      // Priority: explicit input > category mapping > default checkings
      const funding_account_name =
        input.funding_account ||
        CATEGORY_FUNDING_MAP[category_name] ||
        "checkings";

      if (!is_valid_funding_account(funding_account_name)) {
        return {
          success: false,
          error: `funding_account must be one of: ${FUNDING_ACCOUNTS.join(
            ", "
          )}.`,
        };
      }

      funding_account_page_id = await find_account_page_by_title(
        funding_account_name
      );
      if (!funding_account_page_id) {
        return {
          success: false,
          error: `funding account '${funding_account_name}' not found in Notion Accounts DB.`,
        };
      }
    }

    const today = new Date();
    const iso_date = input.date || today.toISOString().slice(0, 10);

    const title = build_title({
      amount: input.amount,
      transaction_type: input.transaction_type,
      account: account_name,
      category: category_name,
      budget: input.budget,
    });

    let response;

    if (input.transaction_type === "expense") {
      // Create expense page
      const properties: any = {
        title: { title: [{ text: { content: title } }] },
        date: { date: { start: iso_date } },
        amount: { number: input.amount },
        accounts: { relation: [{ id: account_page_id }] },
        categories: { relation: [{ id: category_page_id }] },
      };

      if (input.note) {
        properties.note = { rich_text: [{ text: { content: input.note } }] };
      }

      if (funding_account_page_id) {
        properties.funding_account = {
          relation: [{ id: funding_account_page_id }],
        };
      }

      response = await notion.pages.create({
        parent: { database_id: EXPENSES_DB_ID },
        properties,
      });
    } else {
      // Create income page - requires matching budget rule for this account
      const budget_name = input.budget || "default";
      const budget_pages = await find_budget_rule_pages_by_title(budget_name);

      // Find the budget rule that links to this account
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

      const pre_breakdown =
        typeof input.pre_breakdown === "number"
          ? input.pre_breakdown
          : input.amount;

      const base_properties: any = {
        title: { title: [{ text: { content: title } }] },
        date: { date: { start: iso_date } },
        amount: { number: input.amount },
        pre_breakdown: { number: pre_breakdown },
        budget: { relation: [{ id: budget_page_id }] },
        accounts: { relation: [{ id: account_page_id }] },
        ...(input.note && {
          note: { rich_text: [{ text: { content: input.note } }] },
        }),
      };

      // Try "categories" first, fall back to "category" (schema varies)
      const try_create = async (cat_prop: "category" | "categories") => {
        return await notion.pages.create({
          parent: { database_id: INCOME_DB_ID },
          properties: {
            ...base_properties,
            [cat_prop]: { relation: [{ id: category_page_id }] },
          },
        });
      };

      try {
        response = await try_create("categories");
      } catch {
        response = await try_create("category");
      }
    }

    return {
      success: true,
      transaction_id: response.id,
      message: `added ${input.transaction_type} of $${input.amount} to ${account_name} (category: ${category_name}).`,
    };
  } catch (err: any) {
    console.error("error adding transaction to Notion:", err);
    return {
      success: false,
      error: err?.message || "unknown error while adding transaction.",
    };
  }
}

// -----------------------------------------------------------------------------
// Batch Processing
// -----------------------------------------------------------------------------

export interface batch_transaction_result {
  index: number;
  success: boolean;
  transaction_id?: string | undefined;
  message?: string | undefined;
  error?: string | undefined;
}

export interface add_transactions_batch_input {
  transactions: add_transaction_input[];
}

export interface add_transactions_batch_result {
  success: boolean;
  results: batch_transaction_result[];
  success_count: number;
  error?: string;
}

/**
 * Processes multiple transactions sequentially.
 * Each transaction is independent - failures don't block others.
 */
export async function add_transactions_batch(
  input: add_transactions_batch_input
): Promise<add_transactions_batch_result> {
  const results: batch_transaction_result[] = [];

  for (const [index, tx] of input.transactions.entries()) {
    try {
      const tx_result = await add_transaction(tx);
      results.push({
        index,
        success: tx_result.success,
        transaction_id: tx_result.transaction_id,
        message: tx_result.message,
        error: tx_result.error,
      });
    } catch (err: any) {
      results.push({
        index,
        success: false,
        error: err?.message ?? "unknown error while processing batch item.",
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
