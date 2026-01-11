// src/agent/mcp_client.ts
import "dotenv/config";
import crypto from "crypto";

const MCP_BASE_URL = process.env.MCP_BASE_URL ?? "http://localhost:3000";

export interface add_transaction_args {
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
  // Income-specific fields
  pre_breakdown?: number;
  budget?: string;
}

export interface add_transaction_batch_args {
  transactions: Array<add_transaction_args>;
}

export interface set_budget_rule_args {
  budget_name: string;
  budgets: Array<{
    account: string;
    percentage: number;
  }>;
}

export interface split_paycheck_args {
  gross_amount: number;
  budget_name?: string;
  date?: string;
  description?: string;
}

export interface update_transaction_category_args {
  expense_id: string;
  category: string;
}

export interface update_transaction_categories_batch_args {
  updates: Array<{
    expense_id: string;
    category: string;
  }>;
}

async function call_mcp_tool<T extends object>(
  tool_name: string,
  args: T,
  fallback_message: string
): Promise<{ raw: any; message: string }> {
  const body = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "tools/call",
    params: {
      name: tool_name,
      arguments: args,
    },
  };

  const res = await fetch(`${MCP_BASE_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Streamable HTTP transport may respond with SSE
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MCP HTTP error: ${res.status} ${res.statusText} ${text}`);
  }

  const content_type = res.headers.get("content-type") ?? "";
  let data: any;

  if (content_type.includes("text/event-stream")) {
    const text = await res.text();
    const data_lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((line) => line.startsWith("data:"));

    if (data_lines.length === 0) {
      throw new Error("No data events in SSE response from MCP");
    }

    const lastLine = data_lines[data_lines.length - 1];
    if (!lastLine) {
      throw new Error("No valid data line found in SSE response from MCP");
    }
    const last = lastLine.slice("data:".length).trim();
    data = JSON.parse(last);
  } else {
    data = await res.json();
  }

  if (data.error) {
    throw new Error(
      `MCP JSON-RPC error: ${data.error.code} ${data.error.message}`
    );
  }

  const text_result =
    data.result?.content?.[0]?.text ??
    data.result?.content?.find?.((c: any) => c?.type === "text")?.text ??
    fallback_message;

  return { raw: data, message: text_result as string };
}

/* ──────────────────────────────
 * Transactions
 * ────────────────────────────── */

export async function call_add_transaction_tool(args: add_transaction_args) {
  return call_mcp_tool(
    "add_transaction",
    args,
    "Transaction recorded, but no detailed message."
  );
}

export async function call_add_transaction_batch_tool(
  args: add_transaction_batch_args
) {
  return call_mcp_tool(
    "add_transactions_batch",
    args,
    "Transactions recorded, but no detailed message."
  );
}

/* ──────────────────────────────
 * Budgets
 * ────────────────────────────── */

export async function call_set_budget_rule_tool(args: set_budget_rule_args) {
  return call_mcp_tool(
    "set_budget_rule",
    args,
    "Budget rule set, but no detailed message."
  );
}

export async function call_split_paycheck_tool(args: split_paycheck_args) {
  return call_mcp_tool(
    "split_paycheck",
    args,
    "Paycheck split, but no detailed message."
  );
}

/* ──────────────────────────────
 * Categories
 * ────────────────────────────── */

export async function call_get_uncategorized_transactions_tool() {
  return call_mcp_tool(
    "get_uncategorized_transactions",
    {},
    "Retrieved uncategorized transactions."
  );
}

export async function call_get_categories_tool() {
  return call_mcp_tool("get_categories", {}, "Retrieved available categories.");
}

export async function call_update_transaction_category_tool(
  args: update_transaction_category_args
) {
  return call_mcp_tool(
    "update_transaction_category",
    args,
    "Transaction category updated."
  );
}

export async function call_update_transaction_categories_batch_tool(
  args: update_transaction_categories_batch_args
) {
  return call_mcp_tool(
    "update_transaction_categories_batch",
    args,
    "Batch transaction category updates applied."
  );
}
