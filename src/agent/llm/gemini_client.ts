// src/agent/llm/gemini_client.ts
import "dotenv/config";
import { GoogleGenerativeAI } from "@google/generative-ai";

if (!process.env.GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is not set in .env");
}

const gen_ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const model = gen_ai.getGenerativeModel({ model: "gemini-2.0-flash" });

export type parsed_action =
  | {
      action: "add_transaction";
      args: {
        amount: number;
        transaction_type: "expense" | "income" | "payment";
        account?:
          | "checkings"
          | "short term savings"
          | "bills"
          | "freedom unlimited"
          | "sapphire"
          | "brokerage"
          | "roth ira"
          | "spaxx";
        category?: string;
        date?: string;
        note?: string;
        funding_account?: "checkings" | "bills" | "short term savings";
        // Payment-specific fields
        from_account?: "checkings" | "bills" | "short term savings";
        to_account?: "sapphire" | "freedom unlimited";
      };
    }
  | {
      action: "add_transaction_batch";
      args: {
        transactions: Array<{
          amount: number;
          transaction_type: "expense" | "income" | "payment";
          account?:
            | "checkings"
            | "short term savings"
            | "bills"
            | "freedom unlimited"
            | "sapphire"
            | "brokerage"
            | "roth ira"
            | "spaxx";
          category?: string;
          date?: string;
          note?: string;
          funding_account?: "checkings" | "bills" | "short term savings";
          from_account?: "checkings" | "bills" | "short term savings";
          to_account?: "sapphire" | "freedom unlimited";
        }>;
      };
    }
  | {
      action: "set_budget_rule";
      args: {
        budget_name: string;
        budgets: Array<{
          account: string;
          percentage: number;
        }>;
      };
    }
  | {
      action: "split_paycheck";
      args: {
        gross_amount: number;
        budget_name?: string;
        date?: string;
        description?: string;
      };
    }
  | {
      action: "get_uncategorized_transactions";
      args: Record<string, never>;
    }
  | {
      action: "get_categories";
      args: Record<string, never>;
    }
  | {
      action: "update_transaction_category";
      args: {
        expense_id: string;
        category: string;
      };
    }
  | {
      action: "update_transaction_categories_batch";
      args: {
        updates: Array<{
          expense_id: string;
          category: string;
        }>;
      };
    }
  | {
      action: "unknown";
      reason?: string;
    };

function build_prompt(user_message: string): string {
  // Get current date for relative date calculations
  const today = new Date();
  const today_str = today.toISOString().slice(0, 10); // YYYY-MM-DD

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterday_str = yesterday.toISOString().slice(0, 10);
  const card_info = `CREDIT CARD LAST 4 DIGITS:\n- Sapphire: ${process.env.SAPPHIRE_LAST4}\n- Freedom Unlimited: ${process.env.FREEDOM_LAST4}`;

  return `
You are a finance command parser for my personal expense tracker.

CURRENT DATE: ${today_str}
YESTERDAY: ${yesterday_str}
CC LAST 4 DIGITS: ${card_info}

CARD MATCHING RULES (IMPORTANT):
- If the user message includes a 4-digit number that matches one of the CC LAST 4 DIGITS above, treat that as the card used.
  * For expenses/income: set "account" to the matching card account ("sapphire" or "freedom unlimited") when appropriate.
  * For credit card payments: set "to_account" to the matching card ("sapphire" or "freedom unlimited").
- If both a card name and last-4 appear and they conflict, TRUST the last-4.

Your ONLY job is to read the user's message and output STRICT JSON (no extra text).
You can ONLY choose between these actions:
- "add_transaction": when the user wants to add a SINGLE expense, income, OR credit card payment. This is the unified entry point for all transaction types.
  * For expenses: set transaction_type to "expense"
  * For income: set transaction_type to "income"
  * For credit card payments: set transaction_type to "payment" (must mention a credit card name like sapphire/freedom OR say "credit card payment")
- "add_transaction_batch": when the user wants to add MULTIPLE transactions at once, OR when importing from a statement/image.
- "set_budget_rule": ONLY when the user wants to CREATE or UPDATE budget allocation percentages.
- "split_paycheck": ONLY when the user mentions a SPECIFIC EMPLOYER/INCOME SOURCE name. Known budget names: "hunt", "msft", "default".
- "get_uncategorized_transactions": when user asks to review/clean up the inbox, see what's in "other", or sort uncategorized transactions.
- "get_categories": when you need to know the valid expense categories. Returns the list of categories from the database.
- "update_transaction_category": when the user wants to change the category of a specific transaction by ID.
- "update_transaction_categories_batch": when given a list of transactions with IDs to categorize.

JSON schema:

{
  "action": "add_transaction",
  "args": {
    "amount": number,
    "transaction_type": "expense" | "income" | "payment",
    // For expense/income:
    "account": string,                // one of: "checkings", "short term savings", "bills", "freedom unlimited", "sapphire", "brokerage", "roth ira", "spaxx". Otherwise OMIT if not specified.
    "category": string,               // Call get_categories MCP tool to see valid options. Common ones: "out" (eating out), "groceries", "lyft", "shopping", "zelle", "health", "car", "house". INFER from context - only use "other" if truly unclear.
    "date": "YYYY-MM-DD",             // optional. For "yesterday" use YESTERDAY date above. For "today" or no date mentioned, OMIT this field.
    "note": string,                   // optional but IMPORTANT: capture the FULL original description from the user.
    "funding_account": "checkings" | "bills" | "short term savings",  // REQUIRED for credit card expenses.
    // For payment:
    "from_account": "checkings" | "bills" | "short term savings",     // optional, where the money comes from. Defaults to "checkings".
    "to_account": "sapphire" | "freedom unlimited"                    // the credit card being paid. Defaults to "sapphire".
  }
}

OR:

{
  "action": "add_transaction_batch",
  "args": {
    "transactions": [
      {
        "amount": number,
        "transaction_type": "expense" | "income" | "payment",
        "account": string,          // optional, for expense/income
        "category": string,         // optional, for expense/income
        "date": "YYYY-MM-DD",       // optional
        "note": string,             // optional
        "funding_account": "checkings" | "bills" | "short term savings",  // for credit card expenses
        "from_account": "checkings" | "bills" | "short term savings",     // for payments
        "to_account": "sapphire" | "freedom unlimited"                    // for payments
      }
    ]
  }
}

OR:

{
  "action": "set_budget_rule",
  "args": {
    "budget_name": string,
    "budgets": [
      { "account": string, "percentage": number }
    ]
  }
}

OR:

{
  "action": "split_paycheck",
  "args": {
    "gross_amount": number,         // total paycheck amount before splitting
    "budget_name": string,          // the budget rule name - extract from phrases like "hunt paid X" → budget_name: "hunt"
    "date": "YYYY-MM-DD",           // optional, OMIT if not specified
    "description": string           // optional, memo/note for the paycheck
  }
}

OR:

{
  "action": "get_uncategorized_transactions",
  "args": {}
}

OR:

{
  "action": "get_categories",
  "args": {}
}

OR:

{
  "action": "update_transaction_category",
  "args": {
    "expense_id": string,
    "category": string
  }
}

OR:

{
  "action": "update_transaction_categories_batch",
  "args": {
    "updates": [
      { "expense_id": string, "category": string },
      ...
    ]
  }
}


Rules:
- Respond with JSON ONLY. No code fences, no Markdown, no explanations.
- IMPORTANT: If message matches "<name> paid <amount>" or "<name> <amount>", use "split_paycheck" with budget_name = <name>.
- If the user says a generic paycheck like "got paid" / "i got paid" without an employer, STILL use "split_paycheck" with budget_name = "default".
- If the message is clearly about adding a single expense or income (not a paycheck), pick "add_transaction".
- For credit card payments (paying off a card), use "add_transaction" with transaction_type = "payment".
- If the message mentions "investments" assume accounts "brokerage" and "roth ira".
- INFER the category from context: "lunch", "dinner", "restaurant" → "out"; "groceries", "supermarket", "trader joes", "costco" → "groceries"; "uber", "lyft", "taxi" → "lyft"; "amazon", "clothes" → "shopping"; "zelle" → "zelle"; "paid <person>" or "sent <person>" → "zelle" (these are personal payments, NOT credit card payments). Only use "other" if the category is truly unclear.
- ALWAYS extract the note: capture the descriptive part of the user's message.
- For zelle/personal payments (category "zelle"), ALWAYS set account to "checkings".
- Funding account guidance: Only include "funding_account" when the expense is on a credit card account ("sapphire" or "freedom unlimited").
- Credit card identification: If the user includes a credit card's last 4 digits, map it to the correct card/account:
  * If the message contains the Sapphire last4 (${process.env.SAPPHIRE_LAST4}), treat the card/account as "sapphire".
  * If the message contains the Freedom Unlimited last4 (${process.env.FREEDOM_LAST4}), treat the card/account as "freedom unlimited".
- Amount parsing: Extract numeric amounts from formats like "$12.34", "12", "12.00", "1,234.56". Amounts must be positive numbers.
- If no date is specified, OMIT the date field entirely.

User message:
${user_message}
`;
}

function extract_json(text: string): any {
  // Sometimes models wrap JSON in \`\`\`...\`\`\`
  const trimmed = text.trim();

  const code_fence_match = trimmed.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/i);
  const json_text = code_fence_match ? code_fence_match[1] : trimmed;

  if (!json_text) {
    throw new Error("Invalid JSON: input is undefined");
  }
  return JSON.parse(json_text);
}

export async function infer_action(
  user_message: string
): Promise<parsed_action> {
  const prompt = build_prompt(user_message);

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });

  const text = result.response.text();
  console.log("[Gemini] Raw response:", text);

  try {
    const parsed = extract_json(text);
    console.log("[Gemini] Parsed JSON:", JSON.stringify(parsed, null, 2));

    if (parsed.action === "add_transaction" && parsed.args) {
      const a = parsed.args;
      if (
        typeof a.amount === "number" &&
        (a.transaction_type === "expense" ||
          a.transaction_type === "income" ||
          a.transaction_type === "payment")
      ) {
        const is_valid_date =
          typeof a.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(a.date);

        return {
          action: "add_transaction",
          args: {
            amount: a.amount,
            transaction_type: a.transaction_type,
            account: typeof a.account === "string" ? a.account : undefined,
            category: a.category,
            date: is_valid_date ? a.date : undefined,
            note: typeof a.note === "string" ? a.note : undefined,
            funding_account:
              typeof a.funding_account === "string"
                ? a.funding_account
                : undefined,
            from_account:
              typeof a.from_account === "string" ? a.from_account : undefined,
            to_account:
              typeof a.to_account === "string" ? a.to_account : undefined,
          },
        };
      }
    }

    if (parsed.action === "add_transaction_batch" && parsed.args) {
      const a = parsed.args;
      if (Array.isArray(a.transactions) && a.transactions.length > 0) {
        const validated_transactions = a.transactions.map((t: any) => {
          const is_valid_date =
            typeof t.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.date);

          return {
            amount: t.amount,
            transaction_type: t.transaction_type,
            account: typeof t.account === "string" ? t.account : undefined,
            category: t.category,
            date: is_valid_date ? t.date : undefined,
            note: typeof t.note === "string" ? t.note : undefined,
            funding_account:
              typeof t.funding_account === "string"
                ? t.funding_account
                : undefined,
            from_account:
              typeof t.from_account === "string" ? t.from_account : undefined,
            to_account:
              typeof t.to_account === "string" ? t.to_account : undefined,
          };
        });

        return {
          action: "add_transaction_batch",
          args: {
            transactions: validated_transactions,
          },
        };
      }
    }

    if (parsed.action === "set_budget_rule" && parsed.args) {
      const a = parsed.args;
      if (
        typeof a.budget_name === "string" &&
        Array.isArray(a.budgets) &&
        a.budgets.length > 0
      ) {
        return {
          action: "set_budget_rule",
          args: {
            budget_name: a.budget_name,
            budgets: a.budgets,
          },
        };
      }
    }

    if (parsed.action === "split_paycheck" && parsed.args) {
      const a = parsed.args;
      if (typeof a.gross_amount === "number" && a.gross_amount > 0) {
        const is_valid_date =
          typeof a.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(a.date);

        return {
          action: "split_paycheck",
          args: {
            gross_amount: a.gross_amount,
            budget_name:
              typeof a.budget_name === "string" ? a.budget_name : undefined,
            date: is_valid_date ? a.date : undefined,
            description:
              typeof a.description === "string" ? a.description : undefined,
          },
        };
      }
    }

    if (parsed.action === "get_uncategorized_transactions") {
      return {
        action: "get_uncategorized_transactions",
        args: {},
      };
    }

    if (parsed.action === "get_categories") {
      return {
        action: "get_categories",
        args: {},
      };
    }

    if (parsed.action === "update_transaction_category" && parsed.args) {
      const a = parsed.args;
      if (
        typeof a.expense_id === "string" &&
        typeof a.category === "string" &&
        a.category.length > 0
      ) {
        return {
          action: "update_transaction_category",
          args: {
            expense_id: a.expense_id,
            category: a.category,
          },
        };
      }
    }

    if (
      parsed.action === "update_transaction_categories_batch" &&
      parsed.args
    ) {
      const a = parsed.args;
      if (Array.isArray(a.updates) && a.updates.length > 0) {
        const valid_updates = a.updates.filter(
          (u: any) =>
            typeof u.expense_id === "string" && typeof u.category === "string"
        );
        if (valid_updates.length > 0) {
          return {
            action: "update_transaction_categories_batch",
            args: { updates: valid_updates },
          };
        }
      }
    }

    return {
      action: "unknown",
      reason: "Parsed JSON did not match expected schema.",
    };
  } catch (err: any) {
    console.error("[Gemini] Failed to parse JSON:", err);
    return {
      action: "unknown",
      reason: "Failed to parse model output as JSON.",
    };
  }
}
