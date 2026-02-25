// src/agent/llm/gemini_client.ts
// Gemini LLM client for parsing natural language into structured actions.
// Outputs JSON matching MCP tool schemas. LLM-agnostic design allows swapping providers.

import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  ACCOUNTS,
  FUNDING_ACCOUNTS,
  CREDIT_CARD_ACCOUNTS,
  TRANSACTION_TYPES,
  CATEGORY_FUNDING_MAP,
  account_type,
  funding_account_type,
  credit_card_account_type,
  transaction_type,
} from "../../mcp/constants";

let _model: ReturnType<GoogleGenerativeAI["getGenerativeModel"]> | null = null;

function get_model() {
  if (!_model) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY is not set in .env");
    _model = new GoogleGenerativeAI(key).getGenerativeModel({ model: "gemini-2.0-flash" });
  }
  return _model;
}

// -----------------------------------------------------------------------------
// Action Types
// -----------------------------------------------------------------------------

export type parsed_action =
  | {
      action: "add_transaction";
      args: {
        amount: number;
        transaction_type: transaction_type;
        account?: account_type | undefined;
        category?: string | undefined;
        date?: string | undefined;
        note?: string | undefined;
        funding_account?: funding_account_type | undefined;
        from_account?: funding_account_type | undefined;
        to_account?: credit_card_account_type | undefined;
        expense_ids?: string[] | undefined;
      };
    }
  | {
      action: "add_transaction_batch";
      args: {
        transactions: Array<{
          amount: number;
          transaction_type: transaction_type;
          account?: account_type | undefined;
          category?: string | undefined;
          date?: string | undefined;
          note?: string | undefined;
          funding_account?: funding_account_type | undefined;
          from_account?: funding_account_type | undefined;
          to_account?: credit_card_account_type | undefined;
        }>;
      };
    }
  | {
      action: "set_budget_rule";
      args: {
        budget_name: string;
        budgets: Array<{ account: string; percentage: number }>;
      };
    }
  | {
      action: "split_paycheck";
      args: {
        gross_amount: number;
        budget_name?: string | undefined;
        date?: string | undefined;
        description?: string | undefined;
      };
    }
  | { action: "get_uncategorized_transactions"; args: Record<string, never> }
  | { action: "get_categories"; args: Record<string, never> }
  | {
      action: "update_transaction_category";
      args: { expense_id: string; category: string };
    }
  | {
      action: "update_transaction_categories_batch";
      args: { updates: Array<{ expense_id: string; category: string }> };
    }
  | { action: "check_balance"; args: { account: account_type } }
  | {
      action: "get_uncleared_expenses";
      args: {
        account: credit_card_account_type;
        from_account?: funding_account_type | undefined;
      };
    }
  | { action: "unknown"; reason?: string | undefined };

// -----------------------------------------------------------------------------
// Prompt Construction
// -----------------------------------------------------------------------------

/**
 * Builds the system prompt for action inference.
 * Uses global constants for account lists and budget names to stay in sync.
 */
function build_prompt(user_message: string): string {
  const today = new Date();
  const today_str = today.toISOString().slice(0, 10);

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterday_str = yesterday.toISOString().slice(0, 10);

  // Build account lists from constants
  const accounts_list = ACCOUNTS.join(", ");
  const funding_accounts_list = FUNDING_ACCOUNTS.join(", ");
  const cc_accounts_list = CREDIT_CARD_ACCOUNTS.join(", ");

  // Build category-to-funding mapping for prompt
  const category_funding_entries = Object.entries(CATEGORY_FUNDING_MAP)
    .map(([cat, fund]) => `"${cat}"->"${fund}"`)
    .join(", ");

  return `# ROLE
Finance command parser. Convert natural language to structured JSON for expense tracking.

# CONTEXT
today=${today_str} | yesterday=${yesterday_str}
accounts: [${accounts_list}]
funding_accounts: [${funding_accounts_list}]
credit_cards: [${cc_accounts_list}]
auto_funding: {${category_funding_entries}} (others->checkings)

# OUTPUT
Respond with ONLY valid JSON. No markdown, no explanation, no code fences.

# ACTIONS (choose exactly one)

## 1. add_transaction
Single expense/income/payment.
\`{"action":"add_transaction","args":{...}}\`

Required: amount(number), transaction_type("expense"|"income"|"payment")
Optional: account, category, date(YYYY-MM-DD), note, funding_account, from_account, to_account, expense_ids(array of expense ID strings, for targeted payment clearing)

Transaction type rules:
- DEFAULT to "expense" for spending/purchases
- "income" only for money received (not paychecks with employer names)
- "payment" only for credit card payments (must mention card name or "credit card payment")

For payments: use from_account (source) + to_account (credit card)
For CC expenses: use account (the card) + funding_account (which bucket pays)

## 2. add_transaction_batch
Multiple transactions at once.
\`{"action":"add_transaction_batch","args":{"transactions":[...]}}\`

## 3. split_paycheck
ONLY when employer/income source name mentioned: hunt, msft, or generic paycheck.
\`{"action":"split_paycheck","args":{"gross_amount":number,"budget_name":"hunt"|"msft"|"default","date?":"YYYY-MM-DD","description?":string}}\`

Triggers: "<employer> paid <amount>", "<employer> <amount>", "got paid <amount>"
- "hunt 2500" -> budget_name="hunt"
- "msft paid 3000" -> budget_name="msft"
- "got paid 2000" (no employer) -> budget_name="default"

## 4. set_budget_rule
Create/update budget allocation percentages.
\`{"action":"set_budget_rule","args":{"budget_name":string,"budgets":[{"account":string,"percentage":number}]}}\`

## 5. get_uncategorized_transactions
User wants to review inbox/uncategorized/"other" items.
\`{"action":"get_uncategorized_transactions","args":{}}\`

## 6. get_categories
User asks what categories exist.
\`{"action":"get_categories","args":{}}\`

## 7. update_transaction_category
Change category of one transaction by ID.
\`{"action":"update_transaction_category","args":{"expense_id":string,"category":string}}\`

## 8. update_transaction_categories_batch
Batch categorize multiple transactions.
\`{"action":"update_transaction_categories_batch","args":{"updates":[{"expense_id":string,"category":string}]}}\`

## 9. check_balance
Check the current ledger balance of an account.
\`{"action":"check_balance","args":{"account":"sapphire"|"checkings"|...}}\`

## 10. get_uncleared_expenses
List unpaid expenses on a credit card. Use when user asks what they owe or wants to pay off a specific expense.
\`{"action":"get_uncleared_expenses","args":{"account":"sapphire"|"freedom unlimited","from_account?":"checkings"|"bills"|...}}\`

For targeted payment clearing: first call get_uncleared_expenses, identify the expense, then add_transaction with expense_ids.

# CATEGORY INFERENCE (for expenses)
lunch|dinner|restaurant|eating out -> "out"
groceries|costco|trader joes|safeway|walmart -> "groceries"
uber|lyft|taxi -> "lyft"
amazon|online shopping -> "shopping"
paid <person>|venmo|zelle -> "zelle" (use account="checkings")
gas|shell|chevron -> "gas"
netflix|spotify|subscription -> "subscriptions"
If unclear, omit category (will default to "other")

# CARD MATCHING
1. Card name (sapphire, freedom) -> use that card
2. No card mentioned -> default to sapphire for expenses

# FIELD RULES
- OMIT date if not specified (don't guess)
- OMIT optional fields if not inferable
- note: capture merchant/description from user message
- amount: extract number, handle "$" prefix

# INPUT
${user_message}`;
}

// -----------------------------------------------------------------------------
// JSON Extraction
// -----------------------------------------------------------------------------

/** Extracts JSON from model response, handling code fences */
function extract_json(text: string): unknown {
  const trimmed = text.trim();
  const code_fence_match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const json_text = code_fence_match?.[1] ?? trimmed;

  if (!json_text) {
    throw new Error("Invalid JSON: input is undefined");
  }
  return JSON.parse(json_text) as unknown;
}

// -----------------------------------------------------------------------------
// Action Inference
// -----------------------------------------------------------------------------

/**
 * Sends user message to Gemini, parses response into structured action.
 * Validates response matches expected schema before returning.
 */
export async function infer_action(
  user_message: string,
): Promise<parsed_action> {
  const prompt = build_prompt(user_message);

  const result = await get_model().generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });

  const text = result.response.text();
  console.log("[Gemini] Raw response:", text);

  try {
    const parsed = extract_json(text) as Record<string, unknown>;
    console.log("[Gemini] Parsed JSON:", JSON.stringify(parsed, null, 2));

    // Validate and return typed action
    if (parsed.action === "add_transaction" && parsed.args) {
      const a = parsed.args as Record<string, unknown>;
      if (
        typeof a.amount === "number" &&
        typeof a.transaction_type === "string" &&
        TRANSACTION_TYPES.includes(a.transaction_type as transaction_type)
      ) {
        const date_str = typeof a.date === "string" ? a.date : "";
        const is_valid_date = /^\d{4}-\d{2}-\d{2}$/.test(date_str);

        return {
          action: "add_transaction",
          args: {
            amount: a.amount,
            transaction_type: a.transaction_type as transaction_type,
            account:
              typeof a.account === "string"
                ? (a.account as account_type)
                : undefined,
            category: typeof a.category === "string" ? a.category : undefined,
            date: is_valid_date ? date_str : undefined,
            note: typeof a.note === "string" ? a.note : undefined,
            funding_account:
              typeof a.funding_account === "string"
                ? (a.funding_account as funding_account_type)
                : undefined,
            from_account:
              typeof a.from_account === "string"
                ? (a.from_account as funding_account_type)
                : undefined,
            to_account:
              typeof a.to_account === "string"
                ? (a.to_account as credit_card_account_type)
                : undefined,
            expense_ids:
              Array.isArray(a.expense_ids) &&
              a.expense_ids.every((id: unknown) => typeof id === "string")
                ? (a.expense_ids as string[])
                : undefined,
          },
        };
      }
    }

    if (parsed.action === "add_transaction_batch" && parsed.args) {
      const a = parsed.args as Record<string, unknown>;
      if (Array.isArray(a.transactions) && a.transactions.length > 0) {
        const validated_transactions = (
          a.transactions as Array<Record<string, unknown>>
        ).map((t) => {
          const t_date_str = typeof t.date === "string" ? t.date : "";
          const is_valid_date = /^\d{4}-\d{2}-\d{2}$/.test(t_date_str);

          const entry: {
            amount: number;
            transaction_type: transaction_type;
            account?: account_type | undefined;
            category?: string | undefined;
            date?: string | undefined;
            note?: string | undefined;
            funding_account?: funding_account_type | undefined;
            from_account?: funding_account_type | undefined;
            to_account?: credit_card_account_type | undefined;
          } = {
            amount: t.amount as number,
            transaction_type: t.transaction_type as transaction_type,
          };
          if (typeof t.account === "string")
            entry.account = t.account as account_type;
          if (typeof t.category === "string") entry.category = t.category;
          if (is_valid_date) entry.date = t_date_str;
          if (typeof t.note === "string") entry.note = t.note;
          if (typeof t.funding_account === "string")
            entry.funding_account = t.funding_account as funding_account_type;
          if (typeof t.from_account === "string")
            entry.from_account = t.from_account as funding_account_type;
          if (typeof t.to_account === "string")
            entry.to_account = t.to_account as credit_card_account_type;
          return entry;
        });

        return {
          action: "add_transaction_batch",
          args: { transactions: validated_transactions },
        };
      }
    }

    if (parsed.action === "set_budget_rule" && parsed.args) {
      const a = parsed.args as Record<string, unknown>;
      if (
        typeof a.budget_name === "string" &&
        Array.isArray(a.budgets) &&
        a.budgets.length > 0
      ) {
        return {
          action: "set_budget_rule",
          args: {
            budget_name: a.budget_name,
            budgets: a.budgets as Array<{
              account: string;
              percentage: number;
            }>,
          },
        };
      }
    }

    if (parsed.action === "split_paycheck" && parsed.args) {
      const a = parsed.args as Record<string, unknown>;
      if (typeof a.gross_amount === "number" && a.gross_amount > 0) {
        const sp_date_str = typeof a.date === "string" ? a.date : "";
        const is_valid_date = /^\d{4}-\d{2}-\d{2}$/.test(sp_date_str);

        return {
          action: "split_paycheck",
          args: {
            gross_amount: a.gross_amount,
            budget_name:
              typeof a.budget_name === "string" ? a.budget_name : undefined,
            date: is_valid_date ? sp_date_str : undefined,
            description:
              typeof a.description === "string" ? a.description : undefined,
          },
        };
      }
    }

    if (parsed.action === "get_uncategorized_transactions") {
      return { action: "get_uncategorized_transactions", args: {} };
    }

    if (parsed.action === "get_categories") {
      return { action: "get_categories", args: {} };
    }

    if (parsed.action === "update_transaction_category" && parsed.args) {
      const a = parsed.args as Record<string, unknown>;
      if (
        typeof a.expense_id === "string" &&
        typeof a.category === "string" &&
        a.category.length > 0
      ) {
        return {
          action: "update_transaction_category",
          args: { expense_id: a.expense_id, category: a.category },
        };
      }
    }

    if (parsed.action === "check_balance" && parsed.args) {
      const a = parsed.args as Record<string, unknown>;
      if (typeof a.account === "string" && ACCOUNTS.includes(a.account as account_type)) {
        return {
          action: "check_balance",
          args: { account: a.account as account_type },
        };
      }
    }

    if (parsed.action === "get_uncleared_expenses" && parsed.args) {
      const a = parsed.args as Record<string, unknown>;
      if (
        typeof a.account === "string" &&
        CREDIT_CARD_ACCOUNTS.includes(a.account as credit_card_account_type)
      ) {
        return {
          action: "get_uncleared_expenses",
          args: {
            account: a.account as credit_card_account_type,
            from_account:
              typeof a.from_account === "string"
                ? (a.from_account as funding_account_type)
                : undefined,
          },
        };
      }
    }

    if (
      parsed.action === "update_transaction_categories_batch" &&
      parsed.args
    ) {
      const a = parsed.args as Record<string, unknown>;
      if (Array.isArray(a.updates) && a.updates.length > 0) {
        const valid_updates = (
          a.updates as Array<Record<string, unknown>>
        ).filter(
          (u) =>
            typeof u.expense_id === "string" && typeof u.category === "string",
        ) as Array<{ expense_id: string; category: string }>;
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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Gemini] Failed to parse JSON:", message);
    return {
      action: "unknown",
      reason: "Failed to parse model output as JSON.",
    };
  }
}
