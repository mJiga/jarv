// src/agent/mcp_client.ts
import "dotenv/config";

const MCP_BASE_URL = process.env.MCP_BASE_URL ?? "http://localhost:3000";

if (!MCP_BASE_URL) {
  throw new Error("MCP_BASE_URL is not set in .env");
}

export interface add_transaction_args {
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

/**
 * helper to call any MCP tool.
 */
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
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`MCP HTTP error: ${res.status} ${res.statusText}`);
  }

  const content_type = res.headers.get("content-type") ?? "";
  let data: any;

  if (content_type.includes("text/event-stream")) {
    const text = await res.text();
    const data_lines = text
      .split("\n")
      .filter((line) => line.startsWith("data:"));

    if (data_lines.length === 0) {
      throw new Error("No data events in SSE response from MCP");
    }

    const last =
      data_lines[data_lines.length - 1]?.slice("data:".length).trim() ?? "";
    data = JSON.parse(last);
  } else {
    data = await res.json();
  }

  if (data.error) {
    throw new Error(
      `MCP JSON-RPC error: ${data.error.code} ${data.error.message}`
    );
  }

  const text_result = data.result?.content?.[0]?.text ?? fallback_message;

  return {
    raw: data,
    message: text_result as string,
  };
}

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

export interface update_last_expense_category_args {
  category: string;
}

export async function call_update_last_expense_category_tool(
  args: update_last_expense_category_args
) {
  return call_mcp_tool(
    "update_last_expense_category",
    args,
    "Category updated, but no detailed message."
  );
}

export async function call_get_uncategorized_expenses_tool() {
  return call_mcp_tool(
    "get_uncategorized_expenses",
    {},
    "Retrieved uncategorized expenses."
  );
}

export interface update_expense_category_args {
  expense_id: string;
  category: string;
}

export async function call_update_expense_category_tool(
  args: update_expense_category_args
) {
  return call_mcp_tool(
    "update_expense_category",
    args,
    "Expense category updated."
  );
}

export interface create_payment_args {
  amount: number;
  from_account?: "checkings" | "bills" | "short term savings";
  to_account?: "sapphire" | "freedom unlimited";
  date?: string;
  note?: string;
}

export async function call_create_payment_tool(args: create_payment_args) {
  return call_mcp_tool("create_payment", args, "Payment created.");
}
