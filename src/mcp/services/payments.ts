// src/mcp/services/payments.ts
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

export interface create_payment_input {
  amount: number;
  from_account?: string | undefined; // e.g., "checkings", "bills" - defaults to "checkings"
  to_account?: string | undefined; // e.g., "sapphire", "freedom unlimited" - defaults to "sapphire"
  date?: string | undefined; // ISO date, defaults to today
  note?: string | undefined;
  category?: string | undefined; // optional category for the payment
}

export interface cleared_expense_info {
  expense_id: string;
  amount: number;
  note?: string | undefined;
}

export interface create_payment_result {
  success: boolean;
  payment_id?: string | undefined;
  cleared_expenses: cleared_expense_info[];
  cleared_total: number;
  remaining_unapplied: number;
  message?: string | undefined;
  error?: string | undefined;
}

/**
 * Create a payment (transfer) and automatically clear matching expenses.
 *
 * Flow:
 * 1. Create the payment page in Payments DB
 * 2. Query Expenses DB for uncleared expenses matching to_account + funding_account
 * 3. Walk through expenses (oldest first) until payment amount is exhausted
 * 4. Mark each expense as cleared and link to the payment
 * 5. Return summary
 */
export async function create_payment(
  input: create_payment_input
): Promise<create_payment_result> {
  try {
    // Validate amount
    if (typeof input.amount !== "number" || input.amount <= 0) {
      return {
        success: false,
        error: "amount must be a positive number.",
        cleared_expenses: [],
        cleared_total: 0,
        remaining_unapplied: 0,
      };
    }

    // Default accounts: from_account defaults to checkings, to_account defaults to sapphire
    const from_account = input.from_account || "checkings";
    const to_account = input.to_account || "sapphire";

    // Validate accounts
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

    // Default date to today
    const today = new Date();
    const iso_date = input.date || today.toISOString().slice(0, 10);

    // Handle optional category
    const category_name = input.category
      ? validate_category(input.category)
      : null;
    let category_page_id: string | null = null;
    if (category_name) {
      category_page_id = await ensure_category_page(category_name);
    }

    // Build title
    const title = `payment $${input.amount} ${from_account} → ${to_account}`;

    // Step 1: Create the payment page
    const payment_properties: any = {
      title: {
        title: [{ text: { content: title } }],
      },
      amount: {
        number: input.amount,
      },
      date: {
        date: { start: iso_date },
      },
      from_account: {
        relation: [{ id: from_account_page_id }],
      },
      to_account: {
        relation: [{ id: to_account_page_id }],
      },
    };

    if (input.note) {
      payment_properties.note = {
        rich_text: [{ text: { content: input.note } }],
      };
    }

    // Add category if provided
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

    // Step 2: Query uncleared expenses matching to_account + funding_account
    const expenses_results = await query_data_source_with_filter(
      EXPENSES_DB_ID,
      {
        and: [
          {
            property: "accounts",
            relation: {
              contains: to_account_page_id,
            },
          },
          {
            property: "funding_account",
            relation: {
              contains: from_account_page_id,
            },
          },
          {
            property: "cleared",
            checkbox: {
              equals: false,
            },
          },
        ],
      },
      [
        { property: "date", direction: "ascending" },
        { timestamp: "created_time", direction: "ascending" },
      ]
    );

    // Step 3: Walk expenses until payment runs out
    let remaining = input.amount;
    const cleared_expenses: cleared_expense_info[] = [];
    const expense_ids_to_link: string[] = [];

    for (const page of expenses_results) {
      if (remaining <= 0) break;

      const props = (page as any).properties;
      const expense_amount = props.amount?.number;

      if (typeof expense_amount !== "number" || expense_amount <= 0) continue;

      // Get owed_amount from Notion formula, or calculate from paid_amount
      // owed_amount formula in Notion: max(amount - paid_amount, 0)
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

        // Mark expense as cleared and link to payment
        await notion.pages.update({
          page_id: page.id,
          properties: {
            cleared: {
              checkbox: true,
            },
            cleared_by: {
              relation: [{ id: payment_id }],
            },
            paid_amount: {
              number: expense_amount, // Fully paid
            },
          },
        });
      } else {
        // Partial payment - apply what we have left and continue
        const new_paid_amount = existing_paid + remaining;

        cleared_expenses.push({
          expense_id: page.id,
          amount: remaining,
          note: `${
            expense_note || "expense"
          } (partial: $${remaining} of $${expense_amount})`,
        });

        expense_ids_to_link.push(page.id);

        // Update paid_amount but don't mark as cleared yet
        await notion.pages.update({
          page_id: page.id,
          properties: {
            paid_amount: {
              number: new_paid_amount,
            },
            cleared_by: {
              relation: [{ id: payment_id }],
            },
          },
        });

        remaining = 0; // Payment fully used
        break;
      }
    }

    // Update payment with cleared_expenses relation
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
