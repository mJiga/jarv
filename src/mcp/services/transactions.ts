// src/services/transactions.ts
import {
  notion,
  EXPENSES_DB_ID,
  INCOME_DB_ID,
  ACCOUNTS_DB_ID,
  CATEGORIES_DB_ID,
} from "../notion_client";

export type transaction_type = "expense" | "income";

export interface add_transaction_input {
  amount: number;
  transaction_type: transaction_type;
  account?: string;
  category?: string | undefined;
  date?: string | undefined;
}

export interface add_transaction_result {
  success: boolean;
  transactionId?: string;
  message?: string;
  error?: string;
}

function build_title(input: add_transaction_input): string {
  const isExpense = input.transaction_type === "expense";
  const transaction_type = isExpense ? "expense" : "income";
  const amount_str = `$${input.amount}`;
  const acc = input.account || "cash";

  if (isExpense) {
    const cat = input.category || "other";
    return `${transaction_type} ${amount_str} ${cat} (${acc})`;
  } else {
    return `${transaction_type} ${amount_str} (${acc})`;
  }
}

// --- Notion helpers ---

async function getDataSourceIdForDatabase(databaseId: string): Promise<string> {
  const db: any = await notion.databases.retrieve({ database_id: databaseId });
  const ds = db.data_sources?.[0];
  if (!ds) {
    throw new Error(
      `No data source attached to database ${databaseId}. Check Notion setup.`
    );
  }
  return ds.id;
}

async function find_account_page_by_title(
  title: string
): Promise<string | null> {
  const dataSourceId = await getDataSourceIdForDatabase(ACCOUNTS_DB_ID);

  const res = await (notion as any).dataSources.query({
    data_source_id: dataSourceId,
    filter: {
      // if your first column in Accounts is literally called "title" (Aa icon),
      // this is correct. If it's "Name", change to property: "Name".
      property: "title",
      title: { equals: title },
    },
    page_size: 1,
  });

  const first = res.results[0];
  if (!first) return null;
  return first.id;
}

async function find_category_page_by_title(
  title: string
): Promise<string | null> {
  const dataSourceId = await getDataSourceIdForDatabase(CATEGORIES_DB_ID);

  const res = await (notion as any).dataSources.query({
    data_source_id: dataSourceId,
    filter: {
      // matches your screenshot: first column is literally "title"
      property: "title",
      title: { equals: title },
    },
    page_size: 1,
  });

  const first = res.results[0];
  if (!first) return null;
  return first.id;
}

async function ensure_category_page(title: string): Promise<string> {
  const existing_id = await find_category_page_by_title(title);
  if (existing_id) return existing_id;

  // Auto-create new category page, using the real title property
  const created = await notion.pages.create({
    parent: { database_id: CATEGORIES_DB_ID },
    properties: {
      title: {
        title: [
          {
            text: { content: title },
          },
        ],
      },
    },
  });

  return created.id;
}

// --- tool ---

export async function add_transaction(
  input: add_transaction_input
): Promise<add_transaction_result> {
  try {
    // validation
    if (typeof input.amount !== "number" || input.amount <= 0) {
      return { success: false, error: "Amount must be a positive number." };
    }

    if (
      input.transaction_type !== "expense" &&
      input.transaction_type !== "income"
    ) {
      return {
        success: false,
        error: "Transaction type must be 'expense' or 'income'.",
      };
    }

    const account_name = input.account || "freedom unlimited";
    const category_name = input.category || "other";

    // allowed accounts guard
    const allowed_accounts = [
      "checkings",
      "savings",
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
        error: `Account page '${account_name}' not found in Notion Accounts DB.`,
      };
    }

    const category_page_id = await ensure_category_page(category_name);

    // default to today if missing
    const today = new Date();
    const isoDate = input.date || today.toISOString().slice(0, 10); // "YYYY-MM-DD"

    const title = build_title({
      amount: input.amount,
      transaction_type: input.transaction_type,
      account: account_name,
      category: category_name,
      date: isoDate,
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
              start: isoDate,
            },
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
        },
      });
    } else {
      // --- INCOME DB ---
      // For now, we treat amount as the net amount hitting the account.
      // pre_breakdown = gross; budget = fraction of gross that actually goes in.
      const pre_breakdown = input.amount; // later we can let this differ
      const budget = 1; // 100% for now

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
              start: isoDate,
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

    const baseMsg = `added ${input.transaction_type} of $${input.amount} to ${account_name}`;

    const message =
      input.transaction_type === "expense"
        ? `${baseMsg} (category: ${category_name}).`
        : `${baseMsg}.`;

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
