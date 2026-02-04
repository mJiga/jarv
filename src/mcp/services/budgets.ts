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
import { DEFAULT_BUDGET_NAME, DEFAULT_INCOME_ACCOUNT } from "../constants";
import { get_number_prop, get_relation_prop } from "../notion/types";

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
 * Creates new rules first, then archives old ones only on success (atomic).
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

    // Validate all accounts exist and cache their page IDs for reuse
    const account_ids = new Map<string, string>();
    for (const b of budgets) {
      const account_page_id = await find_account_page_by_title(b.account);
      if (!account_page_id) {
        return {
          success: false,
          error: `account '${b.account}' not found in Accounts DB.`,
        };
      }
      account_ids.set(b.account, account_page_id);
    }

    // Create new rule pages first (one per account allocation)
    // This is done before archiving to ensure atomicity — if creation fails,
    // old rules remain intact and no data is lost.
    const created_page_ids: string[] = [];
    for (const b of budgets) {
      const account_page_id = account_ids.get(b.account);
      if (!account_page_id) continue;

      const page = await notion.pages.create({
        parent: { database_id: BUDGET_RULES_DB_ID },
        properties: {
          title: { title: [{ text: { content: budget_name } }] },
          account: { relation: [{ id: account_page_id }] },
          percentage: { number: b.percentage },
        },
      });
      created_page_ids.push(page.id);
    }

    // Only archive old rules after all new ones are successfully created
    const existing = await find_budget_rule_pages_by_title(budget_name);
    for (const page of existing) {
      // Don't archive the pages we just created
      if (!created_page_ids.includes(page.id)) {
        await notion.pages.update({ page_id: page.id, archived: true });
      }
    }

    return {
      success: true,
      message: `set budget rule '${budget_name}' with ${budgets.length} allocations.`,
    };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "unknown error while setting budget rule.";
    console.error("error setting budget rule:", err);
    return {
      success: false,
      error: message,
    };
  }
}

// -----------------------------------------------------------------------------
// Split Paycheck
// -----------------------------------------------------------------------------

export interface split_paycheck_input {
  gross_amount: number;
  budget_name?: string | undefined; // Default from constants
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

    const budget_name = input.budget_name || DEFAULT_BUDGET_NAME;
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
      const props = page.properties;
      const percentage: number = get_number_prop(props, "percentage") ?? 0;
      const relation = get_relation_prop(props, "account");
      const first_relation = relation[0];

      if (!first_relation || percentage <= 0) continue;

      // Resolve account title from relation — reuse the ID we already have
      const account_page = await notion.pages.retrieve({
        page_id: first_relation.id,
      });
      const account_title =
        get_page_title_text(account_page as Record<string, unknown>) ||
        DEFAULT_INCOME_ACCOUNT;

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
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "unknown error while splitting paycheck.";
    console.error("error splitting paycheck:", err);
    return {
      success: false,
      error: message,
    };
  }
}
