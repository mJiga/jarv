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
        transactions: Array<
          | {
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
            }
          | {
              amount: number;
              transaction_type: "payment";
              from_account?: "checkings" | "bills" | "short term savings";
              to_account?: "sapphire" | "freedom unlimited";
              date?: string;
              note?: string;
            }
        >;
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
      action: "stage_expense_category_updates";
      args: {
        batch_id?: string;
        updates: Array<{
          expense_id: string;
          category: string;
          amount?: number;
          note?: string;
          date?: string;
        }>;
      };
    }
  | {
      action: "confirm_expense_category_updates";
      args: {
        batch_id: string;
        confirm: boolean;
      };
    }
  | {
      action: "stage_statement_transactions";
      args: {
        statement_id?: string;
        source?: {
          bank_name?: string;
          statement_period?: string;
          account_last4?: string;
          currency?: string;
        };
        transactions: Array<
          | {
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
            }
          | {
              amount: number;
              transaction_type: "payment";
              from_account?: "checkings" | "bills" | "short term savings";
              to_account?: "sapphire" | "freedom unlimited";
              date?: string;
              note?: string;
            }
        >;
      };
    }
  | {
      action: "confirm_statement_import";
      args: {
        statement_id: string;
        confirm: boolean;
        import_now?: boolean;
      };
    }
  | {
      action: "finalize_statement_import";
      args: {
        statement_id: string;
        imported_transaction_count?: number;
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
- "add_transaction": when the user clearly wants to add a SINGLE expense or income. This is the DEFAULT for most messages.
- "add_transaction_batch": when the user clearly wants to add MULTIPLE transactions at once.
- NOTE: "add_transaction_batch" MAY include credit card payments when importing statements/images. In that case, each payment item MUST set "transaction_type": "payment" and use the payment fields (amount, from_account?, to_account?, date?, note?) and MUST OMIT expense/income fields like category, account, and funding_account.
- "set_budget_rule": ONLY when the user wants to CREATE or UPDATE budget allocation percentages (e.g., "set my budget to 50% checkings, 30% savings").
- "split_paycheck": ONLY when the user mentions a SPECIFIC EMPLOYER/INCOME SOURCE name. Known budget names: "hunt", "msft", "default". Patterns:
  * "<employer> paid <amount>" (e.g., "hunt paid 440", "msft paid 1200")
  * "got <amount> from <employer>" (e.g., "got 500 from hunt")
  * "<employer> <amount>" ONLY if <employer> is a known budget name above (e.g., "msft 1500", "hunt 440")
  * DO NOT use split_paycheck for generic phrases like "i got paid", "got paid today" without a specific employer name - use "default" instead.
- "update_last_expense_category": when the user wants to change/fix the category of the last added expense (e.g., "actually that was groceries", "change it to shopping").
- "get_uncategorized_expenses": when user asks to review/clean up the inbox, see what's in "other", or sort uncategorized expenses.
- "update_expense_category_batch": when given a list of expenses with IDs to categorize. INFER the best category for each based on its note.
- "create_payment": ONLY for credit card payments. Must mention a credit card name (sapphire, freedom) OR explicitly say "credit card payment". Patterns:
  * "pay <amount> to sapphire/freedom"
  * "credit card payment <amount>"
  * "pay off sapphire/freedom <amount>"
  * "cc payment <amount>"
  * DO NOT use create_payment for "paid <person> <amount>" - that's a zelle expense (add_transaction with category "zelle").

STAGING / CONFIRMATION ACTIONS (NO WRITES UNTIL CONFIRM):
- "stage_expense_category_updates": use when you want to PREVIEW a batch of category edits first (no writes). Returns a batch_id to confirm later.
- "confirm_expense_category_updates": use ONLY after staging; applies the staged category updates using the batch_id. Requires a boolean confirm.
- "stage_statement_transactions": use when transactions have already been extracted (e.g., from an image/statement) and you want to stage them for user review (no writes). Returns a statement_id to confirm later.
- "confirm_statement_import": confirms a staged statement. If confirm=true, it may import immediately (import_now defaults true). If import_now=false, it confirms without importing.
- "finalize_statement_import": clears pending statement state (housekeeping). Provide statement_id and optionally imported_transaction_count.

JSON schema:

{
  "action": "add_transaction",
  "args": {
    "amount": number,
    "transaction_type": "expense" | "income",
    "account": string,                // one of: "checkings", "short term savings", "bills", "freedom unlimited", "sapphire", "brokerage", "roth ira", "spaxx". Otherwise OMIT if not specified.
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
        "transaction_type": "expense" | "income" | "payment",
        "account": string,          // optional, OMIT if not specified
        "category": string,         // optional
        "date": "YYYY-MM-DD",       // optional, OMIT if not specified
        "note": string,             // optional, extra context
        "funding_account": "checkings" | "bills" | "short term savings"  // REQUIRED for expenses. Same rules as add_transaction.
      }
    ]
  }
}

IMPORTANT (batch payments): If a batch item has "transaction_type": "payment", the object MUST look like this (and MUST NOT include category/account/funding_account):

{
  "amount": number,
  "transaction_type": "payment",
  "from_account": "checkings" | "bills" | "short term savings",   // optional, defaults to "checkings" if not specified
  "to_account": "sapphire" | "freedom unlimited",                 // the credit card being paid, defaults to "sapphire" if not specified
  "date": "YYYY-MM-DD",                                            // optional
  "note": string                                                    // optional
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

IMPORTANT (valid JSON): The example above may contain formatting artifacts (e.g., extra braces). Your output MUST be valid JSON.
Here is a correct shape for set_budget_rule (copy this structure):

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

STAGING SCHEMAS:

1) Stage expense category updates (NO WRITES):
{
  "action": "stage_expense_category_updates",
  "args": {
    "batch_id": string,        // optional; OMIT unless you are continuing a known batch
    "updates": [
      {
        "expense_id": string,  // REQUIRED
        "category": string,    // REQUIRED
        "amount": number,      // optional
        "note": string,        // optional
        "date": "YYYY-MM-DD"  // optional
      }
    ]
  }
}

2) Confirm expense category updates (APPLIES WRITES):
{
  "action": "confirm_expense_category_updates",
  "args": {
    "batch_id": string,        // REQUIRED; must come from stage_expense_category_updates response
    "confirm": boolean         // REQUIRED
  }
}

3) Stage statement transactions (NO OCR HERE, NO WRITES):
{
  "action": "stage_statement_transactions",
  "args": {
    "statement_id": string,    // optional; OMIT unless you are continuing a known staged statement
    "source": {                // optional metadata
      "bank_name": string,
      "statement_period": string,
      "account_last4": string,
      "currency": string
    },
    "transactions": [
      {
        "amount": number,
        "transaction_type": "expense" | "income",
        "account": string,
        "category": string,
        "date": "YYYY-MM-DD",
        "note": string,
        "funding_account": "checkings" | "bills" | "short term savings"
      },
      OR
      {
        "amount": number,
        "transaction_type": "payment",
        "from_account": "checkings" | "bills" | "short term savings",
        "to_account": "sapphire" | "freedom unlimited",
        "date": "YYYY-MM-DD",
        "note": string
      }
    ]
  }
}

4) Confirm statement import:
{
  "action": "confirm_statement_import",
  "args": {
    "statement_id": string,    // REQUIRED; must come from stage_statement_transactions response
    "confirm": boolean,        // REQUIRED
    "import_now": boolean      // optional; defaults to true
  }
}

5) Finalize statement import (cleanup):
{
  "action": "finalize_statement_import",
  "args": {
    "statement_id": string,                 // REQUIRED
    "imported_transaction_count": number    // optional
  }
}

Rules:
- Respond with JSON ONLY. No code fences, no Markdown, no explanations.
- IMPORTANT: If message matches "<name> paid <amount>" or "<name> <amount>", use "split_paycheck" with budget_name = <name>.
- If the user says a generic paycheck like "got paid" / "i got paid" without an employer, STILL use "split_paycheck" with budget_name = "default".
- If the message is clearly about adding a single expense or income (not a paycheck), pick "add_transaction".
- If the message mentions "investments" assume accounts "brokerage" and "roth ira".
- INFER the category from context: "lunch", "dinner", "restaurant" → "out"; "groceries", "supermarket", "trader joes", "costco" → "groceries"; "uber", "lyft", "taxi" → "lyft"; "amazon", "clothes" → "shopping"; "zelle" → "zelle"; "paid <person>" or "sent <person>" → "zelle" (these are personal payments, NOT credit card payments). Only use "other" if the category is truly unclear.
- ALWAYS extract the note: capture the descriptive part of the user's message (vendor, person, item). E.g., "15 starbucks with ana" → note: "starbucks with ana", category: "out".
- For zelle/personal payments (category "zelle"), ALWAYS set account to "checkings". For other categories, OMIT account if not specified.
- Funding account guidance: Only include "funding_account" when the expense is on a credit card account ("sapphire" or "freedom unlimited") or when the user explicitly says which account funds it. Otherwise OMIT funding_account.
- Credit card identification: If the user includes a credit card's last 4 digits, map it to the correct card/account:
  * If the message contains the Sapphire last4 (${process.env.SAPPHIRE_LAST4}), treat the card/account as "sapphire".
  * If the message contains the Freedom Unlimited last4 (${process.env.FREEDOM_LAST4}), treat the card/account as "freedom unlimited".
  This applies to both expenses (account) and payments (to_account).
- Amount parsing: Extract numeric amounts from formats like "$12.34", "12", "12.00", "1,234.56". Amounts must be positive numbers.
- If no date is specified, OMIT the date field entirely (do not use "today" or any placeholder).
- Staging IDs: For stage_* actions, OMIT batch_id/statement_id unless you are continuing an existing staged item. For confirm_* actions, batch_id/statement_id is REQUIRED and must be the one returned by the corresponding stage tool.

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

          if (t.transaction_type === "payment") {
            return {
              amount: t.amount,
              transaction_type: "payment" as const,
              from_account:
                typeof t.from_account === "string" ? t.from_account : undefined,
              to_account:
                typeof t.to_account === "string" ? t.to_account : undefined,
              date: is_valid_date ? t.date : undefined,
              note: typeof t.note === "string" ? t.note : undefined,
            };
          }

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

    if (parsed.action === "stage_expense_category_updates" && parsed.args) {
      const a = parsed.args;
      if (Array.isArray(a.updates) && a.updates.length > 0) {
        const valid_updates = a.updates.filter(
          (u: any) =>
            typeof u.expense_id === "string" &&
            typeof u.category === "string" &&
            u.expense_id.length > 0 &&
            u.category.length > 0
        );

        if (valid_updates.length > 0) {
          const cleaned_updates = valid_updates.map((u: any) => {
            const is_valid_date =
              typeof u.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(u.date);
            return {
              expense_id: u.expense_id,
              category: u.category,
              amount: typeof u.amount === "number" ? u.amount : undefined,
              note: typeof u.note === "string" ? u.note : undefined,
              date: is_valid_date ? u.date : undefined,
            };
          });

          return {
            action: "stage_expense_category_updates",
            args: {
              batch_id: typeof a.batch_id === "string" ? a.batch_id : undefined,
              updates: cleaned_updates,
            },
          };
        }
      }
    }

    if (parsed.action === "confirm_expense_category_updates" && parsed.args) {
      const a = parsed.args;
      if (typeof a.batch_id === "string" && typeof a.confirm === "boolean") {
        return {
          action: "confirm_expense_category_updates",
          args: {
            batch_id: a.batch_id,
            confirm: a.confirm,
          },
        };
      }
    }

    if (parsed.action === "stage_statement_transactions" && parsed.args) {
      const a = parsed.args;
      if (Array.isArray(a.transactions) && a.transactions.length > 0) {
        const validated_transactions = a.transactions.map((t: any) => {
          const is_valid_date =
            typeof t.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.date);

          if (t.transaction_type === "payment") {
            return {
              amount: t.amount,
              transaction_type: "payment" as const,
              from_account:
                typeof t.from_account === "string" ? t.from_account : undefined,
              to_account:
                typeof t.to_account === "string" ? t.to_account : undefined,
              date: is_valid_date ? t.date : undefined,
              note: typeof t.note === "string" ? t.note : undefined,
            };
          }

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

        const source =
          a.source && typeof a.source === "object"
            ? {
                bank_name:
                  typeof a.source.bank_name === "string"
                    ? a.source.bank_name
                    : undefined,
                statement_period:
                  typeof a.source.statement_period === "string"
                    ? a.source.statement_period
                    : undefined,
                account_last4:
                  typeof a.source.account_last4 === "string"
                    ? a.source.account_last4
                    : undefined,
                currency:
                  typeof a.source.currency === "string"
                    ? a.source.currency
                    : undefined,
              }
            : undefined;

        const args: any = {
          statement_id:
            typeof a.statement_id === "string" ? a.statement_id : undefined,
          transactions: validated_transactions,
        };
        if (source) {
          args.source = source;
        }
        return {
          action: "stage_statement_transactions",
          args,
        };
      }
    }

    if (parsed.action === "confirm_statement_import" && parsed.args) {
      const a = parsed.args;
      if (
        typeof a.statement_id === "string" &&
        typeof a.confirm === "boolean"
      ) {
        return {
          action: "confirm_statement_import",
          args: {
            statement_id: a.statement_id,
            confirm: a.confirm,
            import_now:
              typeof a.import_now === "boolean" ? a.import_now : undefined,
          },
        };
      }
    }

    if (parsed.action === "finalize_statement_import" && parsed.args) {
      const a = parsed.args;
      if (typeof a.statement_id === "string" && a.statement_id.length > 0) {
        return {
          action: "finalize_statement_import",
          args: {
            statement_id: a.statement_id,
            imported_transaction_count:
              typeof a.imported_transaction_count === "number"
                ? a.imported_transaction_count
                : undefined,
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
