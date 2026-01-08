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
  funding_account?: string | undefined; // For credit card expenses: which account funds this (checkings, bills)
}

export interface add_transaction_result {
  success: boolean;
  transactionId?: string;
  message?: string;
  error?: string;
}

// If Gemini sends anything else, we force it to "other".
const ACCEPTED_CATEGORIES = [
  "paycheck",
  "out",
  "lyft",
  "shopping",
  "concerts",
  "zelle",
  "health",
  "groceries",
  "att",
  "chatgpt",
  "house",
  "car",
  "gas",
  "other",
] as const;

type AcceptedCategory = (typeof ACCEPTED_CATEGORIES)[number];

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

    // ✅ Enforce accepted categories so Gemini can't introduce new ones.
    // Unknown/blank categories get forced to "other".
    const raw_category = (input.category ?? "").trim().toLowerCase();

    const category_name: AcceptedCategory = (
      ACCEPTED_CATEGORIES as readonly string[]
    ).includes(raw_category)
      ? (raw_category as AcceptedCategory)
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

    // Resolve category page id for BOTH expenses and income.
    // Because category_name is whitelisted above, ensure_category_page cannot create random new categories.
    const category_page_id = await ensure_category_page(category_name);

    // Credit card accounts that need funding
    const credit_card_accounts = ["sapphire", "freedom unlimited"] as const;
    const is_credit_card = credit_card_accounts.includes(account_name as any);

    // Determine funding account for credit card expenses
    let funding_account_name: string | null = null;
    let funding_account_page_id: string | null = null;

    if (input.transaction_type === "expense" && is_credit_card) {
      funding_account_name = input.funding_account || "checkings";

      // Validate funding account
      const allowed_funding = [
        "checkings",
        "bills",
        "short term savings",
      ] as const;
      if (!allowed_funding.includes(funding_account_name as any)) {
        return {
          success: false,
          error:
            "funding_account must be one of: checkings, bills, short term savings.",
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
          title: [{ text: { content: title } }],
        },
        date: {
          date: { start: iso_date },
        },
        amount: {
          number: input.amount,
        },
        accounts: {
          relation: [{ id: account_page_id }],
        },
        categories: {
          relation: [{ id: category_page_id }],
        },
      };

      if (input.note) {
        properties.note = {
          rich_text: [{ text: { content: input.note } }],
        };
      }

      // Add funding_account relation for credit card expenses
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
      // --- INCOME DB ---
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

      const pre_breakdown =
        typeof input.pre_breakdown === "number"
          ? input.pre_breakdown
          : input.amount;

      // Income DB category relation property name can vary.
      // To mirror the Expenses DB behavior, we prefer "categories" first
      // and fall back to "category" if needed.
      const base_income_properties: any = {
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

      const try_create_income = async (
        category_prop_name: "category" | "categories"
      ) => {
        return await notion.pages.create({
          parent: { database_id: INCOME_DB_ID },
          properties: {
            ...base_income_properties,
            [category_prop_name]: { relation: [{ id: category_page_id }] },
          },
        });
      };

      try {
        response = await try_create_income("categories");
      } catch (e1: any) {
        // If "categories" doesn't exist in the Income DB, try "category".
        // We don't overfit to Notion's error message text because it can vary.
        try {
          response = await try_create_income("category");
        } catch (e2: any) {
          // Prefer surfacing the original failure (categories) since that's our primary intent.
          throw e1;
        }
      }
    }

    const base_msg = `added ${input.transaction_type} of $${input.amount} to ${account_name}`;

    return {
      success: true,
      transactionId: response.id,
      message:
        input.transaction_type === "expense"
          ? `${base_msg} (category: ${category_name}).`
          : `${base_msg} (category: ${category_name}).`,
    };
  } catch (err: any) {
    console.error("error adding transaction to Notion:", err);
    return {
      success: false,
      error: err?.message || "unknown error while adding transaction.",
    };
  }
}
