// src/mcp/services/payments.ts
// Payment creation with automatic expense clearing.
// When a payment is made, matching uncleared expenses are marked as cleared.

import { notion, PAYMENTS_DB_ID, EXPENSES_DB_ID } from "../notion/client";
import {
  find_account_page_by_title,
  query_data_source_with_filter,
  find_recent_duplicate_payment,
  validate_category,
  ensure_category_page,
} from "../notion/utils";
import {
  FUNDING_ACCOUNTS,
  CREDIT_CARD_ACCOUNTS,
  DEFAULT_PAYMENT_FROM,
  DEFAULT_PAYMENT_TO,
  is_valid_funding_account,
  is_valid_credit_card_account,
} from "../constants";
import {
  get_number_prop,
  get_rich_text_prop,
  get_formula_number_prop,
  get_date_prop,
  get_relation_prop,
  notion_page,
} from "../notion/types";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface create_payment_input {
  amount: number;
  from_account?: string | undefined; // Source: checkings, bills, etc.
  to_account?: string | undefined; // Destination: sapphire, freedom unlimited.
  date?: string | undefined; // ISO date. Default: today
  note?: string | undefined;
  category?: string | undefined;
  expense_ids?: string[] | undefined; // Target specific expenses instead of FIFO auto-clearing
}

export interface uncleared_expense_info {
  expense_id: string;
  amount: number;
  owed_amount: number;
  date: string;
  note: string;
}

export interface get_uncleared_expenses_result {
  success: boolean;
  expenses: uncleared_expense_info[];
  total_owed: number;
  error?: string | undefined;
}

export interface cleared_expense_info {
  expense_id: string;
  amount: number; // Amount applied to this expense
  note?: string | undefined;
}

export interface create_payment_result {
  success: boolean;
  payment_id?: string | undefined;
  cleared_expenses: cleared_expense_info[];
  cleared_total: number;
  remaining_unapplied: number; // Payment amount that couldn't be matched to expenses
  message?: string | undefined;
  error?: string | undefined;
}

// -----------------------------------------------------------------------------
// Query: Uncleared Expenses
// -----------------------------------------------------------------------------

/**
 * Returns uncleared expenses on a credit card, optionally filtered by funding account.
 * Used to discover which expenses can be targeted for payment clearing.
 */
export async function get_uncleared_expenses(
  account: string,
  from_account?: string
): Promise<get_uncleared_expenses_result> {
  try {
    if (!is_valid_credit_card_account(account)) {
      return {
        success: false,
        expenses: [],
        total_owed: 0,
        error: `account must be one of: ${CREDIT_CARD_ACCOUNTS.join(", ")}`,
      };
    }

    const account_page_id = await find_account_page_by_title(account);
    if (!account_page_id) {
      return {
        success: false,
        expenses: [],
        total_owed: 0,
        error: `account '${account}' not found in Notion Accounts DB.`,
      };
    }

    // Build filter: uncleared expenses on this CC
    const filter_conditions: Record<string, unknown>[] = [
      { property: "accounts", relation: { contains: account_page_id } },
      { property: "cleared", checkbox: { equals: false } },
    ];

    // Optionally filter by funding account
    if (from_account) {
      if (!is_valid_funding_account(from_account)) {
        return {
          success: false,
          expenses: [],
          total_owed: 0,
          error: `from_account must be one of: ${FUNDING_ACCOUNTS.join(", ")}`,
        };
      }
      const from_page_id = await find_account_page_by_title(from_account);
      if (!from_page_id) {
        return {
          success: false,
          expenses: [],
          total_owed: 0,
          error: `from_account '${from_account}' not found in Notion Accounts DB.`,
        };
      }
      filter_conditions.push({
        property: "funding_account",
        relation: { contains: from_page_id },
      });
    }

    const results = await query_data_source_with_filter(
      EXPENSES_DB_ID,
      { and: filter_conditions },
      [
        { property: "date", direction: "ascending" },
        { timestamp: "created_time", direction: "ascending" },
      ]
    );

    let total_owed = 0;
    const expenses: uncleared_expense_info[] = results.map((page) => {
      const props = page.properties;
      const amount = get_number_prop(props, "amount") || 0;
      const existing_paid = get_number_prop(props, "paid_amount") || 0;
      const owed_formula = get_formula_number_prop(props, "owed_amount");
      const owed =
        typeof owed_formula === "number" ? owed_formula : amount - existing_paid;

      total_owed = Math.round((total_owed + owed) * 100) / 100;

      return {
        expense_id: page.id,
        amount,
        owed_amount: owed,
        date: get_date_prop(props, "date"),
        note: get_rich_text_prop(props, "note"),
      };
    });

    return { success: true, expenses, total_owed };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "unknown error fetching uncleared expenses.";
    console.error("[payments] Error in get_uncleared_expenses:", err);
    return { success: false, expenses: [], total_owed: 0, error: message };
  }
}

// -----------------------------------------------------------------------------
// Core Logic
// -----------------------------------------------------------------------------

/**
 * Creates a payment and clears matching expenses.
 *
 * When expense_ids is provided, only those specific expenses are cleared (targeted mode).
 * When expense_ids is omitted, auto-clears using FIFO (oldest first).
 *
 * Flow:
 * 1. Validate accounts
 * 2. Create payment page in Payments DB
 * 3. Fetch targeted expenses by ID, or query uncleared FIFO
 * 4. Apply payment amount across expenses
 * 5. Mark expenses as cleared and link to payment
 * 6. Handle partial payments (updates paid_amount but doesn't mark cleared)
 */
export async function create_payment(
  input: create_payment_input
): Promise<create_payment_result> {
  try {
    if (typeof input.amount !== "number" || input.amount <= 0) {
      return {
        success: false,
        error: "amount must be a positive number.",
        cleared_expenses: [],
        cleared_total: 0,
        remaining_unapplied: 0,
      };
    }

    const from_account = input.from_account || DEFAULT_PAYMENT_FROM;
    const to_account = input.to_account || DEFAULT_PAYMENT_TO;

    // Validate account types
    if (!is_valid_funding_account(from_account)) {
      return {
        success: false,
        error: `from_account must be one of: ${FUNDING_ACCOUNTS.join(", ")}`,
        cleared_expenses: [],
        cleared_total: 0,
        remaining_unapplied: 0,
      };
    }

    if (!is_valid_credit_card_account(to_account)) {
      return {
        success: false,
        error: `to_account must be one of: ${CREDIT_CARD_ACCOUNTS.join(", ")}`,
        cleared_expenses: [],
        cleared_total: 0,
        remaining_unapplied: 0,
      };
    }

    // Resolve account page IDs
    const from_account_page_id = await find_account_page_by_title(from_account);
    if (!from_account_page_id) {
      return {
        success: false,
        error: `from_account '${from_account}' not found in Notion Accounts DB.`,
        cleared_expenses: [],
        cleared_total: 0,
        remaining_unapplied: 0,
      };
    }

    const to_account_page_id = await find_account_page_by_title(to_account);
    if (!to_account_page_id) {
      return {
        success: false,
        error: `to_account '${to_account}' not found in Notion Accounts DB.`,
        cleared_expenses: [],
        cleared_total: 0,
        remaining_unapplied: 0,
      };
    }

    const iso_date = input.date || new Date().toISOString().slice(0, 10);

    // Check for duplicate payment before creating
    const duplicate_id = await find_recent_duplicate_payment(
      PAYMENTS_DB_ID,
      input.amount,
      from_account_page_id,
      to_account_page_id,
      iso_date
    );

    if (duplicate_id) {
      return {
        success: true,
        payment_id: duplicate_id,
        cleared_expenses: [],
        cleared_total: 0,
        remaining_unapplied: 0,
        message: `Duplicate detected: payment of $${input.amount} from ${from_account} to ${to_account} already exists (created within last 5 minutes).`,
      };
    }

    // Handle optional category
    const category_name = input.category
      ? await validate_category(input.category)
      : null;
    let category_page_id: string | null = null;
    if (category_name) {
      category_page_id = await ensure_category_page(category_name);
    }

    const title = `payment $${input.amount} ${from_account} -> ${to_account}`;

    // Step 1: Create payment page
    const payment_properties: Record<string, unknown> = {
      title: { title: [{ text: { content: title } }] },
      amount: { number: input.amount },
      date: { date: { start: iso_date } },
      from_account: { relation: [{ id: from_account_page_id }] },
      to_account: { relation: [{ id: to_account_page_id }] },
    };

    if (input.note) {
      payment_properties.note = {
        rich_text: [{ text: { content: input.note } }],
      };
    }

    if (category_page_id) {
      payment_properties.categories = {
        relation: [{ id: category_page_id }],
      };
    }

    const payment_response = await notion.pages.create({
      parent: { database_id: PAYMENTS_DB_ID },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      properties: payment_properties as any,
    });

    const payment_id = payment_response.id;

    // Step 2: Get expenses to clear
    let expenses_results: notion_page[];

    if (input.expense_ids && input.expense_ids.length > 0) {
      // Targeted mode: fetch specific expenses by ID
      const pages = await Promise.all(
        input.expense_ids.map(async (id) => {
          try {
            const page = await notion.pages.retrieve({ page_id: id });
            return page as unknown as notion_page;
          } catch {
            return null;
          }
        })
      );
      expenses_results = pages.filter((p): p is notion_page => p !== null);
    } else {
      // Auto-clear mode: FIFO query for uncleared expenses
      expenses_results = await query_data_source_with_filter(
        EXPENSES_DB_ID,
        {
          and: [
            { property: "accounts", relation: { contains: to_account_page_id } },
            {
              property: "funding_account",
              relation: { contains: from_account_page_id },
            },
            { property: "cleared", checkbox: { equals: false } },
          ],
        },
        [
          { property: "date", direction: "ascending" },
          { timestamp: "created_time", direction: "ascending" },
        ]
      );
    }

    // Step 3: Apply payment to expenses (oldest first)
    let remaining = input.amount;
    const cleared_expenses: cleared_expense_info[] = [];
    const expense_ids_to_link: string[] = [];

    for (const page of expenses_results) {
      if (remaining <= 0) break;

      const props = page.properties;
      const expense_amount = get_number_prop(props, "amount");

      if (typeof expense_amount !== "number" || expense_amount <= 0) continue;

      // Calculate what's still owed on this expense
      const owed_amount_prop = get_formula_number_prop(props, "owed_amount");
      const existing_paid = get_number_prop(props, "paid_amount") || 0;
      const owed_amount =
        typeof owed_amount_prop === "number"
          ? owed_amount_prop
          : expense_amount - existing_paid;

      if (owed_amount <= 0) continue; // Already fully paid

      const expense_note = get_rich_text_prop(props, "note") || undefined;

      if (remaining >= owed_amount) {
        // Fully clear this expense
        cleared_expenses.push({
          expense_id: page.id,
          amount: owed_amount,
          note: expense_note,
        });
        expense_ids_to_link.push(page.id);
        remaining = Math.round((remaining - owed_amount) * 100) / 100;

        await notion.pages.update({
          page_id: page.id,
          properties: {
            cleared: { checkbox: true },
            cleared_by: { relation: [{ id: payment_id }] },
            paid_amount: { number: expense_amount },
          },
        });
      } else {
        // Partial payment - apply remaining and stop
        const new_paid_amount = Math.round((existing_paid + remaining) * 100) / 100;

        cleared_expenses.push({
          expense_id: page.id,
          amount: remaining,
          note: `${expense_note || "expense"} (partial: $${remaining} of $${expense_amount})`,
        });
        expense_ids_to_link.push(page.id);

        await notion.pages.update({
          page_id: page.id,
          properties: {
            paid_amount: { number: new_paid_amount },
            cleared_by: { relation: [{ id: payment_id }] },
          },
        });

        remaining = 0;
        break;
      }
    }

    // Step 4: Link cleared expenses to payment
    if (expense_ids_to_link.length > 0) {
      await notion.pages.update({
        page_id: payment_id,
        properties: {
          cleared_expenses: {
            relation: expense_ids_to_link.map((id) => ({ id })),
          },
        },
      });
    }

    const cleared_total = input.amount - remaining;

    return {
      success: true,
      payment_id,
      cleared_expenses,
      cleared_total,
      remaining_unapplied: remaining,
      message: `Created payment of $${input.amount}. Cleared ${cleared_expenses.length} expense(s) totaling $${cleared_total}. Remaining unapplied: $${remaining}.`,
    };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "unknown error while creating payment.";
    console.error("[payments] Error in create_payment:", err);
    return {
      success: false,
      error: message,
      cleared_expenses: [],
      cleared_total: 0,
      remaining_unapplied: 0,
    };
  }
}
