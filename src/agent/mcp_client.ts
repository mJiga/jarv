// src/agent/mcp_client.ts
// Client for calling MCP tools via JSON-RPC.
// Handles both JSON and SSE (Server-Sent Events) response formats.

import "dotenv/config";
import crypto from "crypto";
import type {
  account_type,
  funding_account_type,
  credit_card_account_type,
  transaction_type,
} from "../mcp/constants";

const MCP_BASE_URL = process.env.MCP_BASE_URL ?? "http://localhost:3000";

// -----------------------------------------------------------------------------
// Types — derived from constants to prevent drift
// -----------------------------------------------------------------------------

export interface add_transaction_args {
  amount: number;
  transaction_type: transaction_type;
  account?: account_type;
  category?: string;
  date?: string;
  note?: string;
  funding_account?: funding_account_type;
  from_account?: funding_account_type;
  to_account?: credit_card_account_type;
  pre_breakdown?: number;
  budget?: string;
}

export interface add_transaction_batch_args {
  transactions: Array<add_transaction_args>;
}

export interface set_budget_rule_args {
  budget_name: string;
  budgets: Array<{ account: string; percentage: number }>;
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
  updates: Array<{ expense_id: string; category: string }>;
}

// -----------------------------------------------------------------------------
// Core Client
// -----------------------------------------------------------------------------

interface mcp_tool_result {
  raw: Record<string, unknown>;
  message: string;
}

/**
 * Calls an MCP tool via JSON-RPC.
 * Handles SSE responses (text/event-stream) by parsing data lines.
 */
async function call_mcp_tool<T extends object>(
  tool_name: string,
  args: T,
  fallback_message: string
): Promise<mcp_tool_result> {
  const body = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "tools/call",
    params: { name: tool_name, arguments: args },
  };

  const res = await fetch(`${MCP_BASE_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MCP HTTP error: ${res.status} ${res.statusText} ${text}`);
  }

  const content_type = res.headers.get("content-type") ?? "";
  let data: Record<string, unknown>;

  if (content_type.includes("text/event-stream")) {
    // Parse SSE: extract last "data:" line
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
    data = JSON.parse(lastLine.slice("data:".length).trim()) as Record<string, unknown>;
  } else {
    data = (await res.json()) as Record<string, unknown>;
  }

  const error = data.error as { code?: number; message?: string } | undefined;
  if (error) {
    throw new Error(`MCP JSON-RPC error: ${error.code} ${error.message}`);
  }

  // Extract text content from response
  const result = data.result as Record<string, unknown> | undefined;
  const content = result?.content as Array<{ type?: string; text?: string }> | undefined;
  const text_result =
    content?.[0]?.text ??
    content?.find?.((c) => c?.type === "text")?.text ??
    fallback_message;

  return { raw: data, message: text_result as string };
}

// -----------------------------------------------------------------------------
// Tool Wrappers
// -----------------------------------------------------------------------------

export async function call_add_transaction_tool(args: add_transaction_args) {
  return call_mcp_tool("add_transaction", args, "Transaction recorded.");
}

export async function call_add_transaction_batch_tool(args: add_transaction_batch_args) {
  return call_mcp_tool("add_transactions_batch", args, "Transactions recorded.");
}

export async function call_set_budget_rule_tool(args: set_budget_rule_args) {
  return call_mcp_tool("set_budget_rule", args, "Budget rule set.");
}

export async function call_split_paycheck_tool(args: split_paycheck_args) {
  return call_mcp_tool("split_paycheck", args, "Paycheck split.");
}

export async function call_get_uncategorized_transactions_tool(): Promise<mcp_tool_result> {
  const result = await call_mcp_tool("get_uncategorized_transactions", {}, "Retrieved uncategorized transactions.");

  // Extract structured content to include expense details in message
  const mcp_result = result.raw?.result as Record<string, unknown> | undefined;
  const structured = mcp_result?.structuredContent as { expenses?: Array<{ id: string; amount: number; note: string; date: string }> } | undefined;
  const expenses = structured?.expenses;

  if (expenses && expenses.length > 0) {
    const expense_list = expenses
      .map((e) => `- ID: ${e.id} | $${e.amount.toFixed(2)} | ${e.note || "(no note)"} | ${e.date}`)
      .join("\n");
    result.message = `Found ${expenses.length} uncategorized expense(s):\n${expense_list}`;
  }

  return result;
}

export async function call_get_categories_tool() {
  return call_mcp_tool("get_categories", {}, "Retrieved available categories.");
}

export async function call_update_transaction_category_tool(args: update_transaction_category_args) {
  return call_mcp_tool("update_transaction_category", args, "Transaction category updated.");
}

export async function call_update_transaction_categories_batch_tool(
  args: update_transaction_categories_batch_args
) {
  return call_mcp_tool("update_transaction_categories_batch", args, "Batch category updates applied.");
}
