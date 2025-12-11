// src/server.ts
import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
// import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  add_transaction,
  add_transactions_batch,
  add_transaction_input,
  add_transactions_batch_input,
  transaction_type,
} from "./services/transactions";
import { set_budget_rule, split_paycheck } from "./services/budgets";

const server = new McpServer({
  name: "jarvis",
  version: "0.1.0",
});

/* ──────────────────────────────
 * add_transaction tool
 * ────────────────────────────── */

const transaction_type_values: [transaction_type, transaction_type] = [
  "expense",
  "income",
];

const add_transaction_schema = z.object({
  amount: z
    .number()
    .positive()
    .describe("The amount of the transaction, positive number."),
  transaction_type: z
    .enum(transaction_type_values)
    .describe('"expense" for money going out, "income" for money coming in.'),
  account: z
    .enum([
      "checkings",
      "short term savings",
      "freedom unlimited",
      "brokerage",
      "roth ira",
      "spaxx",
    ])
    .optional()
    .describe("Account to add the transaction to."),
  category: z
    .string()
    .optional()
    .describe('Category of the transaction. Fallback to "other".'),
  date: z
    .string()
    .optional()
    .describe("ISO date (YYYY-MM-DD). Fallback to today in handler."),
  // You *can* expose these if you want to manually attach to a budget rule,
  // but they’re mainly used by split_paycheck / internal flows.
  pre_breakdown: z
    .number()
    .optional()
    .describe("Optional gross/original amount (for income)."),
  budget: z
    .string()
    .optional()
    .describe('Optional budget rule name (e.g., "default").'),
});

server.registerTool(
  "add_transaction",
  {
    title: "add a transaction",
    description: "Add an income or expense to the Notion DB.",
    inputSchema: add_transaction_schema,
  },
  async (args) => {
    console.log(
      "[MCP] add_transaction called",
      new Date().toISOString(),
      JSON.stringify(args)
    );

    const parsed = add_transaction_schema.parse(args) as add_transaction_input;

    const result = await add_transaction(parsed);

    if (!result.success) {
      return {
        content: [
          {
            type: "text",
            text: `MCP error: ${result.error ?? "Failed to add transaction."}`,
          },
        ],
        isError: true,
      };
    }

    return {
      structuredContent: {
        transactionId: result.transactionId,
        amount: parsed.amount,
        transaction_type: parsed.transaction_type,
        account: parsed.account ?? "(default)",
        category: parsed.category ?? "other",
      },
      content: [
        {
          type: "text",
          text:
            result.message ??
            `Added ${parsed.transaction_type} of $${parsed.amount} to Notion.`,
        },
      ],
      _meta: {},
    };
  }
);

/* ──────────────────────────────
 * add_transactions_batch tool
 * ────────────────────────────── */

const add_transactions_batch_schema = z.object({
  transactions: z
    .array(add_transaction_schema)
    .nonempty()
    .describe("List of transactions to add in a single batch."),
});

server.registerTool(
  "add_transactions_batch",
  {
    title: "add multiple transactions",
    description:
      "Add multiple income/expense transactions in one call. Each entry uses the same shape as add_transaction.",
    inputSchema: add_transactions_batch_schema,
  },
  async (args) => {
    console.log(
      "[MCP] add_transactions_batch called",
      new Date().toISOString(),
      JSON.stringify(args)
    );

    const parsed = add_transactions_batch_schema.parse(
      args
    ) as add_transactions_batch_input;

    const result = await add_transactions_batch(parsed);

    // We never treat the whole batch as an MCP-level failure
    // unless something catastrophic happens; individual items
    // carry their own success/error fields.
    return {
      structuredContent: {
        results: result.results,
      },
      content: [
        {
          type: "text",
          text: `Processed ${result.results.length} transactions in batch.`,
        },
      ],
      _meta: {},
    };
  }
);

/* ──────────────────────────────
 * set_budget_rule tool
 * ────────────────────────────── */

const set_budget_rule_schema = z.object({
  budget_name: z
    .string()
    .describe('Name of the budget rule (e.g., "default", "paycheck").'),
  budgets: z
    .array(
      z.object({
        account: z
          .string()
          .describe('Account name (e.g., "checkings", "spaxx").'),
        percentage: z
          .number()
          .min(0)
          .max(1)
          .describe("Fraction 0–1 (e.g., 0.5 for 50%)."),
      })
    )
    .nonempty()
    .describe("List of budget allocations. Percentages must sum to 1.0."),
});

server.registerTool(
  "set_budget_rule",
  {
    title: "set a budget rule",
    description:
      "Create or update a named budget rule with account allocations.",
    inputSchema: set_budget_rule_schema,
  },
  async (args) => {
    console.log(
      "[MCP] set_budget_rule called",
      new Date().toISOString(),
      JSON.stringify(args)
    );
    const parsed = set_budget_rule_schema.parse(args);

    const result = await set_budget_rule({
      budget_name: parsed.budget_name,
      budgets: parsed.budgets,
    });

    if (!result.success) {
      return {
        content: [
          {
            type: "text",
            text: `MCP error: ${result.error}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: result.message ?? `budget rule '${parsed.budget_name}' set.`,
        },
      ],
    };
  }
);

/* ──────────────────────────────
 * split_paycheck tool
 * ────────────────────────────── */

const split_paycheck_schema = z.object({
  gross_amount: z
    .number()
    .positive()
    .describe("Total paycheck amount before splitting."),
  rule_name: z
    .string()
    .optional()
    .describe('Budget rule to use (default: "default").'),
  date: z
    .string()
    .optional()
    .describe("ISO date (YYYY-MM-DD), defaults to today."),
  description: z
    .string()
    .optional()
    .describe("Optional memo/note for the paycheck."),
});

server.registerTool(
  "split_paycheck",
  {
    title: "split a paycheck",
    description:
      "Split a paycheck across accounts according to a budget rule. Creates income entries for each allocation.",
    inputSchema: split_paycheck_schema,
  },
  async (args) => {
    console.log(
      "[MCP] split_paycheck called",
      new Date().toISOString(),
      JSON.stringify(args)
    );
    const parsed = split_paycheck_schema.parse(args);

    const result = await split_paycheck({
      gross_amount: parsed.gross_amount,
      rule_name: parsed.rule_name,
      date: parsed.date,
      description: parsed.description,
    });

    if (!result.success) {
      return {
        content: [
          {
            type: "text",
            text: `MCP error: ${result.error}`,
          },
        ],
        isError: true,
      };
    }

    const entries_summary = result.entries
      .map((e) => `${e.account}: $${e.amount}`)
      .join(", ");

    return {
      structuredContent: {
        gross_amount: result.gross_amount,
        rule_name: result.rule_name,
        entries: result.entries,
      },
      content: [
        {
          type: "text",
          text: `Split $${result.gross_amount} paycheck using '${result.rule_name}' rule: ${entries_summary}`,
        },
      ],
    };
  }
);

/* ──────────────────────────────
 * HTTP MCP transport
 * ────────────────────────────── */

// If you ever want stdio MCP instead of HTTP:
// const transport = new StdioServerTransport();
// server.connect(transport);

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
