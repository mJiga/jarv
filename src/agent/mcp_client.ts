// src/agent/mcp_client.ts
import "dotenv/config";

const MCP_BASE_URL = process.env.MCP_BASE_URL ?? "http://localhost:3000";

if (!MCP_BASE_URL) {
  throw new Error("MCP_BASE_URL is not set in .env");
}

export interface AddTransactionArgs {
  amount: number;
  transaction_type: "expense" | "income";
  account:
    | "checkings"
    | "savings"
    | "freedom unlimited"
    | "brokerage"
    | "roth ira"
    | "spaxx";
  category?: string;
  date?: string;
}

export async function callAddTransactionTool(args: AddTransactionArgs) {
  const body = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "tools/call",
    params: {
      name: "add_transaction",
      arguments: args,
    },
  };

  const res = await fetch(`${MCP_BASE_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // advertise we can handle both
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`MCP HTTP error: ${res.status} ${res.statusText}`);
  }

  const contentType = res.headers.get("content-type") ?? "";

  let data: any;

  if (contentType.includes("text/event-stream")) {
    // --- SSE RESPONSE ---
    const text = await res.text();
    // Each event looks like:
    // event: message
    // data: { ...json... }
    // (blank line)
    const dataLines = text
      .split("\n")
      .filter((line) => line.startsWith("data:"));

    if (dataLines.length === 0) {
      throw new Error("No data events in SSE response from MCP");
    }

    const last =
      dataLines.length > 0 && dataLines[dataLines.length - 1]
        ? dataLines[dataLines.length - 1]?.slice("data:".length).trim() ?? ""
        : "";

    data = JSON.parse(last);
  } else {
    // --- Normal JSON response ---
    data = await res.json();
  }

  if (data.error) {
    throw new Error(
      `MCP JSON-RPC error: ${data.error.code} ${data.error.message}`
    );
  }

  const textResult =
    data.result?.content?.[0]?.text ??
    "Transaction recorded, but no detailed message.";

  return {
    raw: data,
    message: textResult as string,
  };
}
