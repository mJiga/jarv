// src/services/budgets.ts
import { notion, BUDGET_RULES_DB_ID } from "../notion/client";
import {
  find_budget_rule_pages_by_title,
  get_page_title_text,
  find_account_page_by_title,
} from "../notion/utils";

import {
  add_transaction,
  add_transaction_input,
  add_transaction_result,
  income_db_fields,
} from "./transactions";

export interface budget_allocation {
  account: string; // account title ("checkings", "savings", ...)
  percentage: number; // 0–1
}

export interface set_budget_rule_input {
  budget_name: string;
  budgets: budget_allocation[];
}

export interface set_budget_rule_result {
  success: boolean;
  message?: string;
  error?: string;
}

/**
 * Create/update a named budget rule.
 * For a given rule_name, old rows are archived and replaced.
 */
export async function set_budget_rule(
  input: set_budget_rule_input
): Promise<set_budget_rule_result> {
  try {
    const { budget_name, budgets } = input;

    if (!budgets || budgets.length === 0) {
      return {
        success: false,
        error: "budgets array must not be empty.",
      };
    }

    const sum = budgets.reduce((acc, b) => acc + b.percentage, 0);
    if (Math.abs(sum - 1) > 0.001) {
      return {
        success: false,
        error: `percentages must sum to 1.0. current sum: ${sum}`,
      };
    }

    // Validate accounts exist in the Accounts DB
    for (const b of budgets) {
      const account_page_id = await find_account_page_by_title(b.account);
      if (!account_page_id) {
        return {
          success: false,
          error: `account '${b.account}' not found in Accounts DB.`,
        };
      }
    }

    // Archive existing pages for this rule
    const existing = await find_budget_rule_pages_by_title(budget_name);
    for (const page of existing) {
      await notion.pages.update({
        page_id: page.id,
        archived: true,
      });
    }

    // Create new pages
    for (const b of budgets) {
      const account_page_id = await find_account_page_by_title(b.account);
      if (!account_page_id) {
        // Shouldn't happen because we validated above, but guard anyway
        continue;
      }

      await notion.pages.create({
        parent: { database_id: BUDGET_RULES_DB_ID },
        properties: {
          title: {
            title: [
              {
                text: { content: budget_name },
              },
            ],
          },
          account: {
            relation: [{ id: account_page_id }],
          },
          percentage: {
            number: b.percentage,
          },
        },
      });
    }

    return {
      success: true,
      message: `set budget rule '${budget_name}' with ${budgets.length} allocations.`,
    };
  } catch (err: any) {
    console.error("error setting budget rule:", err);
    return {
      success: false,
      error: err?.message || "unknown error while setting budget rule.",
    };
  }
}

/* ──────────────────────────────
 * split_paycheck
 * ────────────────────────────── */

export interface split_paycheck_input {
  gross_amount: number;
  rule_name?: string | undefined; // default 'default'
  date?: string | undefined; // ISO 'YYYY-MM-DD'
  description?: string | undefined; // optional memo text
}

/**
 * A single paycheck split entry, shaped like an income DB row + extras.
 * amount/account/date/pre_breakdown/budget come from income_db_fields.
 */
export interface split_paycheck_entry extends income_db_fields {
  percentage: number; // rule share (0–1)
  portion: number; // same as amount, explicit
  transaction_id?: string | undefined;
  error?: string | undefined;
}

export type split_paycheck_result =
  | {
      success: true;
      gross_amount: number;
      rule_name: string;
      entries: split_paycheck_entry[];
    }
  | {
      success: false;
      error: string;
    };

/**
 * Split a paycheck according to a named budget rule.
 * Writes income rows via add_transaction, using pre_breakdown + budget.
 */
export async function split_paycheck(
  input: split_paycheck_input
): Promise<split_paycheck_result> {
  try {
    const gross_amount = input.gross_amount;
    if (typeof gross_amount !== "number" || gross_amount <= 0) {
      return {
        success: false,
        error: "gross_amount must be a positive number.",
      };
    }

    const rule_name = input.rule_name || "default";
    const today = new Date().toISOString().slice(0, 10);
    const date = input.date || today;

    const rule_pages = await find_budget_rule_pages_by_title(rule_name);
    if (!rule_pages || rule_pages.length === 0) {
      return {
        success: false,
        error: `no budget rule found with name '${rule_name}'.`,
      };
    }

    const entries: split_paycheck_entry[] = [];

    for (const page of rule_pages) {
      const props: any = page.properties;

      const percentage: number = props.percentage?.number ?? 0;
      const relation = props.account?.relation?.[0];

      if (!relation || percentage <= 0) {
        // malformed entry, skip
        continue;
      }

      const account_page = await notion.pages.retrieve({
        page_id: relation.id,
      });

      const account_title = get_page_title_text(account_page) || "checkings";
      const portion_raw = gross_amount * percentage;
      const portion = Number(portion_raw.toFixed(2));

      const memo_parts = [
        `paycheck split (${rule_name})`,
        input.description,
      ].filter(Boolean);

      const tx_input: add_transaction_input = {
        amount: portion,
        transaction_type: "income",
        account: account_title,
        date,
        pre_breakdown: gross_amount,
        budget: rule_name,
      };

      const tx_result: add_transaction_result = await add_transaction(tx_input);

      entries.push({
        amount: portion,
        account: account_title,
        date,
        pre_breakdown: gross_amount,
        percentage,
        portion,
        transaction_id: tx_result.transactionId,
        error: tx_result.error,
      });
    }

    return {
      success: true,
      gross_amount,
      rule_name,
      entries,
    };
  } catch (err: any) {
    console.error("error splitting paycheck:", err);
    return {
      success: false,
      error: err?.message || "unknown error while splitting paycheck.",
    };
  }
}
