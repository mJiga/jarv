// src/mcp/services/payments.ts
import { notion, PAYMENTS_DB_ID, EXPENSES_DB_ID } from "../notion/client";
import {
  find_account_page_by_title,
  query_data_source_with_filter,
} from "../notion/utils";

export interface create_payment_input {
  amount: number;
  from_account?: string | undefined; // e.g., "checkings", "bills" - defaults to "checkings"
  to_account?: string | undefined; // e.g., "sapphire", "freedom unlimited" - defaults to "sapphire"
  date?: string | undefined; // ISO date, defaults to today
  note?: string | undefined;
}

export interface cleared_expense_info {
  expense_id: string;
  amount: number;
  note?: string | undefined;
}

export interface create_payment_result {
  success: boolean;
  payment_id?: string;
  cleared_expenses: cleared_expense_info[];
  cleared_total: number;
  remaining_unapplied: number;
  message?: string;
  error?: string;
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
    const allowed_from_accounts = [
      "checkings",
      "bills",
      "short term savings",
    ] as const;
    const allowed_to_accounts = ["sapphire", "freedom unlimited"] as const;

    if (!allowed_from_accounts.includes(from_account as any)) {
      return {
        success: false,
        error: `from_account must be one of: ${allowed_from_accounts.join(
          ", "
        )}`,
        cleared_expenses: [],
        cleared_total: 0,
        remaining_unapplied: 0,
      };
    }

    if (!allowed_to_accounts.includes(to_account as any)) {
      return {
        success: false,
        error: `to_account must be one of: ${allowed_to_accounts.join(", ")}`,
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

/**
 * Get summary of uncleared expenses by funding account.
 * Useful to see how much is owed from each account.
 */
export interface uncleared_summary {
  from_account: string;
  to_account: string;
  total_uncleared: number;
  expense_count: number;
}

export async function get_uncleared_expenses_summary(): Promise<{
  success: boolean;
  summaries: uncleared_summary[];
  error?: string;
}> {
  try {
    // Query all uncleared expenses
    const results = await query_data_source_with_filter(EXPENSES_DB_ID, {
      property: "cleared",
      checkbox: {
        equals: false,
      },
    });

    // Group by funding_account + accounts
    const groups: Map<
      string,
      { total: number; count: number; from: string; to: string }
    > = new Map();

    for (const page of results) {
      const props = (page as any).properties;
      const amount = props.amount?.number || 0;

      // Get account name (to_account)
      const account_rel = props.accounts?.relation?.[0]?.id;
      // Get funding_account name (from_account)
      const funding_rel = props.funding_account?.relation?.[0]?.id;

      if (!account_rel || !funding_rel) continue;

      const key = `${funding_rel}→${account_rel}`;

      const existing = groups.get(key);
      if (existing) {
        existing.total += amount;
        existing.count += 1;
      } else {
        groups.set(key, {
          total: amount,
          count: 1,
          from: funding_rel,
          to: account_rel,
        });
      }
    }

    // We'd need to resolve IDs to names, but for now return IDs
    // TODO: resolve page IDs to account names

    const summaries: uncleared_summary[] = [];
    for (const [, value] of groups) {
      summaries.push({
        from_account: value.from,
        to_account: value.to,
        total_uncleared: value.total,
        expense_count: value.count,
      });
    }

    return { success: true, summaries };
  } catch (err: any) {
    console.error("[payments] Error in get_uncleared_expenses_summary:", err);
    return {
      success: false,
      summaries: [],
      error: err?.message || "unknown error",
    };
  }
}
