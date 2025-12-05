// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { add_transaction } from "./services/transactions";

const server = new McpServer({
  name: "jarvis",
  version: "0.1.0",
});

// Define the input schema for the tool
const add_transaction_schema = z.object({
  amount: z.number(),
  transaction_type: z.enum(["expense", "income"]), // "expense" means negative, "income" means positive
  account: z.enum([
    "checkings",
    "savings",
    "freedom unlimited",
    "brokerage",
    "roth ira",
    "spaxx",
  ]),
  category: z.string().optional(), // fallback to "other" in handler
  date: z.string().optional(), // ISO date, fallback to today in handler
});

// Register the tool with the MCP server
server.registerTool(
  "add_transaction",
  {
    title: "add a transaction",
    description: "add an income or expense to the db.",
    inputSchema: add_transaction_schema,
  },
  async (args) => {
    const parsed = add_transaction_schema.parse(args);

    // Map to your existing add_transaction() signature
    const result = await add_transaction({
      amount: parsed.amount,
      transaction_type: parsed.transaction_type,
      account: parsed.account,
      category: parsed.category,
      date: parsed.date,
    });

    if (!result.success) {
      throw new Error(result.error ?? "Failed to add transaction");
    }

    return {
      structuredContent: {
        transactionId: result.transactionId,
        amount: parsed.amount,
        transaction_type: parsed.transaction_type,
        account: parsed.account ?? "Other",
        category: parsed.category ?? "Other",
      },
      content: [
        {
          type: "text",
          text: `Added ${parsed.transaction_type} of $${parsed.amount} to Notion.`,
        },
      ],
      _meta: {},
    };
  }
);

// For now, export the server so you can hook it to a transport later
export default server;
