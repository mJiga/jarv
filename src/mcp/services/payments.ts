// src/mcp/services/payments.ts
// Payment creation with automatic expense clearing.
// When a payment is made, matching uncleared expenses are marked as cleared.

import { notion, PAYMENTS_DB_ID, EXPENSES_DB_ID } from "../notion/client";
import {
  find_account_page_by_title,
  query_data_source_with_filter,
  validate_category,
  ensure_category_page,
} from "../notion/utils";
import {
  FUNDING_ACCOUNTS,
  CREDIT_CARD_ACCOUNTS,
  is_valid_funding_account,
  is_valid_credit_card_account,
} from "../constants";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface create_payment_input {
  amount: number;
  from_account?: string | undefined; // Source: checkings, bills, etc. Default: checkings
  to_account?: string | undefined; // Destination: sapphire, freedom unlimited. Default: sapphire
  date?: string | undefined; // ISO date. Default: today
  note?: string | undefined;
  category?: string | undefined;
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
// Core Logic
// -----------------------------------------------------------------------------

/**
 * Creates a payment and auto-clears matching expenses.
 *
 * Flow:
 * 1. Validate accounts
 * 2. Create payment page in Payments DB
 * 3. Query uncleared expenses on the credit card funded by the source account
 * 4. Walk through oldest expenses first, applying payment until exhausted
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

    const from_account = input.from_account || "checkings";
    const to_account = input.to_account || "sapphire";

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

    // Handle optional category
    const category_name = input.category
      ? validate_category(input.category)
      : null;
    let category_page_id: string | null = null;
    if (category_name) {
      category_page_id = await ensure_category_page(category_name);
    }

    const title = `payment $${input.amount} ${from_account} -> ${to_account}`;

    // Step 1: Create payment page
    const payment_properties: any = {
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
      properties: payment_properties,
    });

    const payment_id = payment_response.id;

    // Step 2: Find uncleared expenses matching this payment's accounts
    // Expenses must: be on the credit card, funded by the source account, not cleared
    const expenses_results = await query_data_source_with_filter(
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

    // Step 3: Apply payment to expenses (oldest first)
    let remaining = input.amount;
    const cleared_expenses: cleared_expense_info[] = [];
    const expense_ids_to_link: string[] = [];

    for (const page of expenses_results) {
      if (remaining <= 0) break;

      const props = (page as any).properties;
      const expense_amount = props.amount?.number;

      if (typeof expense_amount !== "number" || expense_amount <= 0) continue;

      // Calculate what's still owed on this expense
      const owed_amount_prop = props.owed_amount?.formula?.number;
      const existing_paid = props.paid_amount?.number || 0;
      const owed_amount =
        typeof owed_amount_prop === "number"
          ? owed_amount_prop
          : expense_amount - existing_paid;

      if (owed_amount <= 0) continue; // Already fully paid

      const expense_note =
        props.note?.rich_text?.[0]?.text?.content || undefined;

      if (remaining >= owed_amount) {
        // Fully clear this expense
        cleared_expenses.push({
          expense_id: page.id,
          amount: owed_amount,
          note: expense_note,
        });
        expense_ids_to_link.push(page.id);
        remaining -= owed_amount;

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
        const new_paid_amount = existing_paid + remaining;

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
  } catch (err: any) {
    console.error("[payments] Error in create_payment:", err);
    return {
      success: false,
      error: err?.message || "unknown error while creating payment.",
      cleared_expenses: [],
      cleared_total: 0,
      remaining_unapplied: 0,
    };
  }
}
