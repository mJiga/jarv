import { notion, TRANSACTIONS_DB_ID } from "../notion_client";

export type transaction_type = "expense" | "income";

export interface add_transaction_input {
  amount: number;
  transaction_type: transaction_type;
  account?: string; // e.g. "Cash"
  category?: string; // e.g. "Food"
  date?: string; // ISO date "2025-12-04"
}

export interface add_transaction_result {
  success: boolean;
  transactionId?: string;
  message?: string;
  error?: string;
}

function buildTitle(input: add_transaction_input): string {
  const transaction_type_label =
    input.transaction_type === "expense" ? "expense" : "income";
  const amountStr = `$${input.amount}`;
  const cat = input.category || "other";
  const acc = input.account || "cash";

  return `${transaction_type_label} ${amountStr} ${cat} (${acc})`;
}

export async function add_transaction(
  input: add_transaction_input
): Promise<add_transaction_result> {
  try {
    // Basic validation
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

    const account = input.account || "cash";
    const category = input.category || "other";

    // If date is omitted, use today's date in ISO (YYYY-MM-DD)
    const today = new Date();
    const isoDate = input.date || today.toISOString().slice(0, 10); // "YYYY-MM-DD"

    const title = buildTitle({
      ...input,
      account,
      category,
      date: isoDate,
    });

    const response = await notion.pages.create({
      parent: { database_id: TRANSACTIONS_DB_ID },
      properties: {
        // Title property
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
        transaction_type: {
          select: {
            // Must match your Notion select options exactly
            name: input.transaction_type === "expense" ? "expense" : "income",
          },
        },
        account: {
          select: {
            name: account,
          },
        },
        category: {
          select: {
            name: category,
          },
        },
      },
    });

    return {
      success: true,
      transactionId: response.id,
      message: `added ${input.transaction_type} of $${input.amount} to ${account} (category: ${category}).`,
    };
  } catch (err: any) {
    console.error("Error adding transaction to Notion:", err);
    return {
      success: false,
      error: err?.message || "Unknown error while adding transaction.",
    };
  }
}
