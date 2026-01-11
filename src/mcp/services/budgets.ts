// src/mcp/services/budgets.ts
// Budget rule management and paycheck splitting.
// Budget rules define how income is distributed across accounts.

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

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface budget_allocation {
  account: string; // Account title (e.g., "checkings")
  percentage: number; // Fraction of gross income (0-1)
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

// -----------------------------------------------------------------------------
// Set Budget Rule
// -----------------------------------------------------------------------------

/**
 * Creates or updates a budget rule.
 * Archives existing rules with the same name before creating new ones.
 * Percentages must sum to 1.0 (100%).
 */
export async function set_budget_rule(
  input: set_budget_rule_input
): Promise<set_budget_rule_result> {
  try {
    const { budget_name, budgets } = input;

    if (!budgets?.length) {
      return { success: false, error: "budgets array must not be empty." };
    }

    // Validate percentages sum to 100%
    const sum = budgets.reduce((acc, b) => acc + b.percentage, 0);
    if (Math.abs(sum - 1) > 0.001) {
      return {
        success: false,
        error: `percentages must sum to 1.0. current sum: ${sum}`,
      };
    }

    // Validate all accounts exist
    for (const b of budgets) {
      const account_page_id = await find_account_page_by_title(b.account);
      if (!account_page_id) {
        return {
          success: false,
          error: `account '${b.account}' not found in Accounts DB.`,
        };
      }
    }

    // Archive existing rules with this name
    const existing = await find_budget_rule_pages_by_title(budget_name);
    for (const page of existing) {
      await notion.pages.update({ page_id: page.id, archived: true });
    }

    // Create new rule pages (one per account allocation)
    for (const b of budgets) {
      const account_page_id = await find_account_page_by_title(b.account);
      if (!account_page_id) continue;

      await notion.pages.create({
        parent: { database_id: BUDGET_RULES_DB_ID },
        properties: {
          title: { title: [{ text: { content: budget_name } }] },
          account: { relation: [{ id: account_page_id }] },
          percentage: { number: b.percentage },
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

// -----------------------------------------------------------------------------
// Split Paycheck
// -----------------------------------------------------------------------------

export interface split_paycheck_input {
  gross_amount: number;
  budget_name?: string | undefined; // Default: "default"
  date?: string | undefined; // ISO date
  description?: string | undefined;
}

export interface split_paycheck_entry extends income_db_fields {
  percentage: number;
  portion: number;
  transaction_id?: string | undefined;
  error?: string | undefined;
}

export type split_paycheck_result =
  | {
      success: true;
      gross_amount: number;
      budget_name: string;
      entries: split_paycheck_entry[];
    }
  | {
      success: false;
      error: string;
    };

/**
 * Splits a paycheck across accounts according to a budget rule.
 * Creates one income transaction per account allocation.
 * Each transaction stores the original gross_amount as pre_breakdown.
 */
export async function split_paycheck(
  input: split_paycheck_input
): Promise<split_paycheck_result> {
  try {
    const { gross_amount } = input;

    if (typeof gross_amount !== "number" || gross_amount <= 0) {
      return {
        success: false,
        error: "gross_amount must be a positive number.",
      };
    }

    const budget_name = input.budget_name || "default";
    const date = input.date || new Date().toISOString().slice(0, 10);

    const rule_pages = await find_budget_rule_pages_by_title(budget_name);
    if (!rule_pages?.length) {
      return {
        success: false,
        error: `no budget rule found with name '${budget_name}'.`,
      };
    }

    const entries: split_paycheck_entry[] = [];

    for (const page of rule_pages) {
      const props: any = page.properties;
      const percentage: number = props.percentage?.number ?? 0;
      const relation = props.account?.relation?.[0];

      if (!relation || percentage <= 0) continue;

      // Resolve account title from relation
      const account_page = await notion.pages.retrieve({
        page_id: relation.id,
      });
      const account_title = get_page_title_text(account_page) || "checkings";

      const portion = Number((gross_amount * percentage).toFixed(2));

      const tx_input: add_transaction_input = {
        amount: portion,
        transaction_type: "income",
        account: account_title,
        date,
        pre_breakdown: gross_amount,
        budget: budget_name,
      };

      const tx_result: add_transaction_result = await add_transaction(tx_input);

      entries.push({
        amount: portion,
        account: account_title,
        date,
        pre_breakdown: gross_amount,
        percentage,
        portion,
        transaction_id: tx_result.transaction_id,
        error: tx_result.error,
      });
    }

    return { success: true, gross_amount, budget_name, entries };
  } catch (err: any) {
    console.error("error splitting paycheck:", err);
    return {
      success: false,
      error: err?.message || "unknown error while splitting paycheck.",
    };
  }
}
