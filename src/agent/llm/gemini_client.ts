// src/agent/llm/geminiClient.ts
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
        transaction_type: "expense" | "income";
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
      };
    }
  | {
      action: "add_transaction_batch";
      args: {
        transactions: Array<{
          amount: number;
          transaction_type: "expense" | "income";
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
      action: "update_last_expense_category";
      args: {
        category: string;
      };
    }
  | {
      action: "get_uncategorized_expenses";
      args: Record<string, never>;
    }
  | {
      action: "update_expense_category_batch";
      args: {
        updates: Array<{
          expense_id: string;
          category: string;
        }>;
      };
    }
  | {
      action: "create_payment";
      args: {
        amount: number;
        from_account?: "checkings" | "bills" | "short term savings";
        to_account?: "sapphire" | "freedom unlimited";
        date?: string;
        note?: string;
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

  return `
You are a finance command parser for my personal expense tracker.

CURRENT DATE: ${today_str}
YESTERDAY: ${yesterday_str}

Your ONLY job is to read the user's message and output STRICT JSON (no extra text).
You can ONLY choose between these actions:
- "add_transaction": when the user clearly wants to add a SINGLE expense or income. This is the DEFAULT for most messages.
- "add_transaction_batch": when the user clearly wants to add MULTIPLE transactions at once.
- "set_budget_rule": ONLY when the user wants to CREATE or UPDATE budget allocation percentages (e.g., "set my budget to 50% checkings, 30% savings").
- "split_paycheck": ONLY when the user mentions a SPECIFIC EMPLOYER/INCOME SOURCE name. Known budget names: "hunt", "msft", "default". Patterns:
  * "<employer> paid <amount>" (e.g., "hunt paid 440", "msft paid 1200")
  * "got <amount> from <employer>" (e.g., "got 500 from hunt")
  * "<employer> <amount>" ONLY if <employer> is a known budget name above (e.g., "msft 1500", "hunt 440")
  * DO NOT use split_paycheck for generic phrases like "i got paid", "got paid today" without a specific employer name - use "default" instead.
- "update_last_expense_category": when the user wants to change/fix the category of the last added expense (e.g., "actually that was groceries", "change it to shopping").
- "get_uncategorized_expenses": when user asks to review/clean up the inbox, see what's in "other", or sort uncategorized expenses.
- "update_expense_category_batch": when given a list of expenses with IDs to categorize. INFER the best category for each based on its note.
- "create_payment": when user wants to pay off a credit card. Patterns:
  * "pay <amount> to sapphire from checkings"
  * "paid <amount> on sapphire"
  * "credit card payment <amount>"
  * "pay off sapphire <amount>"
JSON schema:

{
  "action": "add_transaction",
  "args": {
    "amount": number,
    "transaction_type": "expense" | "income",
    "account": string,                // optional, one of: "checkings", "short term savings" (if user says "savings" map to "short term savings"), "bills", "freedom unlimited", "sapphire", "brokerage", "roth ira", "spaxx". OMIT if not specified. For Zelle transactions, ALWAYS use "checkings".
    "category": string,               // one of: "out" (eating out/restaurants), "groceries", "att" (phone bill), "chatgpt" (AI subscriptions), "lyft" (rideshare/transport), "shopping", "health", "car", "house", "zelle", "other". INFER from context - only use "other" if truly unclear.
    "date": "YYYY-MM-DD",             // optional. For "yesterday" use YESTERDAY date above. For "today" or no date mentioned, OMIT this field.
    "note": string,                   // optional but IMPORTANT: capture the FULL original description from the user, but EXCLUDE date words like "yesterday". E.g., "$9 coffee yesterday" → note: "coffee". "$15 coffee with Ana" → note: "coffee with Ana".
    "funding_account": "checkings" | "bills" | "short term savings"  // REQUIRED for expenses. Determines which account funds this expense:
                                      // - "bills" for: groceries, att, chatgpt, utilities, subscriptions, health, car, house
                                      // - "checkings" for: out/restaurants, shopping, lyft, zelle
                                      // - "short term savings" ONLY if user explicitly says to fund from savings
  }
}

OR:

{
  "action": "add_transaction_batch",
  "args": {
    "transactions": [
      {
        "amount": number,
        "transaction_type": "expense" | "income",
        "account": string,          // optional, OMIT if not specified
        "category": string,         // optional
        "date": "YYYY-MM-DD",       // optional, OMIT if not specified
        "note": string,             // optional, extra context
        "funding_account": "checkings" | "bills" | "short term savings"  // REQUIRED for expenses. Same rules as add_transaction.
      }
    ]
  }
}
    
OR:

{
{
  "action": "set_budget_rule",
  "args": {
    "budget_name": string,            // name of the budget rule (e.g., "default", "paycheck")
    "budgets": [                    // list of budget allocations, percentages MUST sum to 1.0
      {
        "account": string,          // one of: "checkings", "short term savings", "bills", "freedom unlimited", "sapphire", "brokerage", "roth ira", "spaxx"
        "percentage": number        // fraction 0–1 (e.g., 0.5 for 50%)
      }
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
  "action": "update_last_expense_category",
  "args": {
    "category": string          // new category (e.g., "groceries", "out", "lyft")
  }
}

OR:

{
  "action": "get_uncategorized_expenses",
  "args": {}
}

OR:

{
  "action": "update_expense_category_batch",
  "args": {
    "updates": [
      { "expense_id": string, "category": string },
      ...
    ]
  }
}

OR:

{
  "action": "create_payment",
  "args": {
    "amount": number,               // payment amount
    "from_account": "checkings" | "bills" | "short term savings",  // optional, where the money comes from. Defaults to "checkings" if not specified.
    "to_account": "sapphire" | "freedom unlimited",  // the credit card being paid. Defaults to "sapphire" if not specified.
    "date": "YYYY-MM-DD",           // optional, OMIT if not specified
    "note": string                  // optional
  }
}

Rules:
- Respond with JSON ONLY. No code fences, no Markdown, no explanations.
- IMPORTANT: If message matches "<name> paid <amount>" or "<name> <amount>", use "split_paycheck" with budget_name = <name>.
- If the message is clearly about adding a single expense or income (not a paycheck), pick "add_transaction".
- If the message mentions "investments" assume accounts "brokerage" and "roth ira".
- INFER the category from context: "lunch", "dinner", "restaurant" → "out"; "groceries", "supermarket", "trader joes", "costco" → "groceries"; "uber", "lyft", "taxi" → "lyft"; "amazon", "clothes" → "shopping"; "zelle" → "zelle"; etc. Only use "other" if the category is truly unclear.
- ALWAYS extract the note: capture the descriptive part of the user's message (vendor, person, item). E.g., "15 starbucks with ana" → note: "starbucks with ana", category: "out".
- If no account is specified by the user, OMIT the account field entirely. Do NOT guess or default to any account.
- If no date is specified, OMIT the date field entirely (do not use "today" or any placeholder).

User message:
${user_message}
`;
}

function extract_json(text: string): any {
  // Sometimes models wrap JSON in ```...```
  const trimmed = text.trim();

  const code_fence_match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
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
        (a.transaction_type === "expense" || a.transaction_type === "income")
      ) {
        // Only include date if it's a valid ISO date (YYYY-MM-DD)
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

    if (parsed.action === "update_last_expense_category" && parsed.args) {
      const a = parsed.args;
      if (typeof a.category === "string" && a.category.length > 0) {
        return {
          action: "update_last_expense_category",
          args: {
            category: a.category,
          },
        };
      }
    }

    if (parsed.action === "get_uncategorized_expenses") {
      return {
        action: "get_uncategorized_expenses",
        args: {},
      };
    }

    if (parsed.action === "update_expense_category_batch" && parsed.args) {
      const a = parsed.args;
      if (Array.isArray(a.updates) && a.updates.length > 0) {
        const valid_updates = a.updates.filter(
          (u: any) =>
            typeof u.expense_id === "string" && typeof u.category === "string"
        );
        if (valid_updates.length > 0) {
          return {
            action: "update_expense_category_batch",
            args: { updates: valid_updates },
          };
        }
      }
    }

    if (parsed.action === "create_payment" && parsed.args) {
      const a = parsed.args;
      if (typeof a.amount === "number" && a.amount > 0) {
        const is_valid_date =
          typeof a.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(a.date);

        return {
          action: "create_payment",
          args: {
            amount: a.amount,
            from_account:
              typeof a.from_account === "string" ? a.from_account : undefined,
            to_account:
              typeof a.to_account === "string" ? a.to_account : undefined,
            date: is_valid_date ? a.date : undefined,
            note: typeof a.note === "string" ? a.note : undefined,
          },
        };
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
