// src/agent/llm/claude_client.ts
// Claude LLM client for parsing natural language into structured actions.
// Drop-in replacement for gemini_client.ts with optimized prompt structure.

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
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

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY is not set in .env");
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// -----------------------------------------------------------------------------
// Action Types (shared with gemini_client.ts)
// -----------------------------------------------------------------------------

export type parsed_action =
  | {
      action: "add_transaction";
      args: {
        amount: number;
        transaction_type: transaction_type;
        account?: account_type;
        category?: string;
        date?: string;
        note?: string;
        funding_account?: funding_account_type;
        from_account?: funding_account_type;
        to_account?: credit_card_account_type;
      };
    }
  | {
      action: "add_transaction_batch";
      args: {
        transactions: Array<{
          amount: number;
          transaction_type: transaction_type;
          account?: account_type;
          category?: string;
          date?: string;
          note?: string;
          funding_account?: funding_account_type;
          from_account?: funding_account_type;
          to_account?: credit_card_account_type;
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
        budget_name?: string;
        date?: string;
        description?: string;
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
  | { action: "unknown"; reason?: string };

// -----------------------------------------------------------------------------
// System Prompt
// -----------------------------------------------------------------------------

function build_system_prompt(): string {
  const accounts_list = ACCOUNTS.join(", ");
  const funding_accounts_list = FUNDING_ACCOUNTS.join(", ");
  const cc_accounts_list = CREDIT_CARD_ACCOUNTS.join(", ");
  const auto_funding = Object.entries(CATEGORY_FUNDING_MAP)
    .map(([cat, fund]) => `${cat}->${fund}`)
    .join(", ");

  return `You are Jarv, a personal finance command parser. Convert natural language to structured JSON actions.

# ACCOUNTS
all: [${accounts_list}]
funding: [${funding_accounts_list}]
credit_cards: [${cc_accounts_list}]
auto_funding: {${auto_funding}} (others->checkings)

# CARDS
sapphire(${process.env.SAPPHIRE_LAST4 || "????"}), freedom(${process.env.FREEDOM_LAST4 || "????"})

# OUTPUT FORMAT
Respond with ONLY a single JSON object. No markdown, no explanation, no code fences.

# ACTIONS

## add_transaction
Single expense/income/payment.
{"action":"add_transaction","args":{"amount":number,"transaction_type":"expense"|"income"|"payment","account?":string,"category?":string,"date?":"YYYY-MM-DD","note?":string,"funding_account?":string,"from_account?":string,"to_account?":string}}

Rules:
- expense: spending (default). Use account=card, funding_account=source
- income: money received (not paychecks with employer name)
- payment: CC bill payment. Use from_account=source, to_account=card

## add_transaction_batch
Multiple transactions: {"action":"add_transaction_batch","args":{"transactions":[...]}}

## split_paycheck
ONLY for paychecks WITH employer name (hunt, msft) or "got paid":
{"action":"split_paycheck","args":{"gross_amount":number,"budget_name":"hunt"|"msft"|"default","date?":"YYYY-MM-DD"}}
- "hunt 2500" -> budget_name="hunt"
- "got paid 2000" -> budget_name="default"

## set_budget_rule
{"action":"set_budget_rule","args":{"budget_name":string,"budgets":[{"account":string,"percentage":number}]}}

## get_uncategorized_transactions / get_categories
{"action":"<name>","args":{}}

## update_transaction_category
{"action":"update_transaction_category","args":{"expense_id":string,"category":string}}

## update_transaction_categories_batch
{"action":"update_transaction_categories_batch","args":{"updates":[{"expense_id":string,"category":string}]}}

# CATEGORY INFERENCE
lunch/dinner/restaurant->"out", groceries/costco/trader joes->"groceries", uber/lyft->"lyft", amazon->"shopping", paid <person>/zelle/venmo->"zelle"(account=checkings), gas/shell->"gas", netflix/spotify->"subscriptions"

# CARD MATCHING (priority order)
1. 4-digit match -> that card
2. Name mention -> that card
3. Conflict -> trust 4-digit
4. Default -> sapphire

# RULES
- OMIT date if not specified
- OMIT optional fields if not inferable
- note = merchant/description from message`;
}

// -----------------------------------------------------------------------------
// User Message Construction
// -----------------------------------------------------------------------------

function build_user_message(user_input: string): string {
  const today = new Date();
  const today_str = today.toISOString().slice(0, 10);

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterday_str = yesterday.toISOString().slice(0, 10);

  return `today=${today_str} yesterday=${yesterday_str}

INPUT: ${user_input}`;
}

// -----------------------------------------------------------------------------
// JSON Extraction
// -----------------------------------------------------------------------------

function extract_json(text: string): any {
  const trimmed = text.trim();
  // Handle potential code fences
  const code_fence_match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const json_text = code_fence_match ? code_fence_match[1].trim() : trimmed;

  if (!json_text) {
    throw new Error("Invalid JSON: input is undefined");
  }
  return JSON.parse(json_text);
}

// -----------------------------------------------------------------------------
// Action Inference
// -----------------------------------------------------------------------------

export async function infer_action(
  user_message: string
): Promise<parsed_action> {
  const system_prompt = build_system_prompt();
  const user_content = build_user_message(user_message);

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: system_prompt,
    messages: [{ role: "user", content: user_content }],
  });

  const text_block = response.content.find((block) => block.type === "text");
  const text = text_block && "text" in text_block ? text_block.text : "";

  console.log("[Claude] Raw response:", text);

  try {
    const parsed = extract_json(text);
    console.log("[Claude] Parsed JSON:", JSON.stringify(parsed, null, 2));

    // Validate and return typed action
    if (parsed.action === "add_transaction" && parsed.args) {
      const a = parsed.args;
      if (
        typeof a.amount === "number" &&
        TRANSACTION_TYPES.includes(a.transaction_type)
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
          args: { transactions: validated_transactions },
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
          args: { budget_name: a.budget_name, budgets: a.budgets },
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
      return { action: "get_uncategorized_transactions", args: {} };
    }

    if (parsed.action === "get_categories") {
      return { action: "get_categories", args: {} };
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
          args: { expense_id: a.expense_id, category: a.category },
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
    console.error("[Claude] Failed to parse JSON:", err);
    return {
      action: "unknown",
      reason: "Failed to parse model output as JSON.",
    };
  }
}
