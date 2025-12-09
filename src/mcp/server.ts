// src/server.ts
import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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
    console.log(
      "[MCP] add_transaction called",
      new Date().toISOString(),
      JSON.stringify(args)
    );
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
        account: parsed.account ?? "other",
        category: parsed.category ?? "other",
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

// ---- StdioServerTransport ----
// const transport = new StdioServerTransport();
// server.connect(transport);

// ---- StreamableHTTP transport ----
const PORT = Number(process.env.PORT ?? 3000);

async function main() {
  const app = express();
  app.use(express.json());

  // Stateless HTTP MCP transport
  const transport = new StreamableHTTPServerTransport({
    // `undefined` = stateless server; each request is independent
    sessionIdGenerator: undefined,
  });

  // Connect the MCP server to the transport
  await server.connect(transport);

  // Single HTTP endpoint for MCP
  app.post("/mcp", async (req: Request, res: Response) => {
    try {
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("Error handling MCP request:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: req.body?.id ?? null,
        });
      }
    }
  });

  app.listen(PORT, () => {
    console.log(`MCP server listening on http://localhost:${PORT}/mcp`);
  });
}

main().catch((err) => {
  console.error("Error starting MCP server:", err);
  process.exit(1);
});
