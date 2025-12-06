// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { add_transaction, transaction_type } from "./services/transactions";

const server = new McpServer({
  name: "jarvis",
  version: "0.1.0",
});

// Define the input schema for the tool
const add_transaction_schema = z.object({
  amount: z
    .number()
    .describe("The amount of the transaction, positive number."),
  transaction_type: z
    .enum(["expense", "income"] as [transaction_type, transaction_type])
    .describe('"expense" for money going out, "income" for money coming in.'), // "expense" means negative, "income" means positive
  account: z
    .enum([
      "checkings",
      "savings",
      "freedom unlimited",
      "brokerage",
      "roth ira",
      "spaxx",
    ])
    .describe("account to add the transaction to."),
  category: z
    .string()
    .optional()
    .describe('category of the transaction. Fallback to "other"'),
  date: z
    .string()
    .optional()
    .describe("ISO date, fallback to today in handler"),
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
const transport = new StdioServerTransport();
server.connect(transport);
