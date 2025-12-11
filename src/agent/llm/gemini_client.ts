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
          | "freedom unlimited"
          | "brokerage"
          | "roth ira"
          | "spaxx";
        category?: string;
        date?: string;
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
            | "freedom unlimited"
            | "brokerage"
            | "roth ira"
            | "spaxx";
          category?: string;
          date?: string;
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
        rule_name?: string;
        date?: string;
        description?: string;
      };
    }
  | {
      action: "unknown";
      reason?: string;
    };

function build_prompt(user_message: string): string {
  return `
You are a finance command parser for my personal expense tracker.

Your ONLY job is to read the user's message and output STRICT JSON (no extra text).
You can ONLY choose between these actions:
- "add_transaction": when the user clearly wants to add a SINGLE expense or income.
- "add_transaction_batch": when the user clearly wants to add MULTIPLE transactions at once.
- "set_budget_rule": ONLY when the user wants to CREATE or UPDATE budget allocation percentages (e.g., "set my budget to 50% checkings, 30% savings").
- "split_paycheck": when the user mentions "split", "paycheck", "got paid", or wants to DISTRIBUTE money across accounts using an existing budget rule.

JSON schema:

{
  "action": "add_transaction",
  "args": {
    "amount": number,
    "transaction_type": "expense" | "income",
    "account": string,                // optional, one of: "checkings", "short term savings" (if user says "savings" map to "short term savings"), "freedom unlimited", "brokerage", "roth ira", "spaxx". OMIT if not specified.
    "category": string,               // optional, short label like "food", "transport"
    "date": "YYYY-MM-DD"              // optional, the date the request was made
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
        "date": "YYYY-MM-DD"        // optional, OMIT if not specified
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
        "account": string,          // one of: "checkings", "short term savings" (if user says "savings" map to "short term savings"), "freedom unlimited", "brokerage", "roth ira", "spaxx"
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
    "rule_name": string,            // optional, budget rule to use (default: "default")
    "date": "YYYY-MM-DD",           // optional, OMIT if not specified
    "description": string           // optional, memo/note for the paycheck
  }
}

Rules:
- Respond with JSON ONLY. No code fences, no Markdown, no explanations.
- If the message is clearly about adding a transaction, pick "add_transaction".
- If the message mentions "investments" assume accounts "brokerage" and "roth ira".
- Default category to "other" if not specified.
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

  try {
    const parsed = extract_json(text);

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
            rule_name:
              typeof a.rule_name === "string" ? a.rule_name : undefined,
            date: is_valid_date ? a.date : undefined,
            description:
              typeof a.description === "string" ? a.description : undefined,
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
