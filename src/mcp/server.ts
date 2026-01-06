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
import {
  update_last_expense_category,
  get_uncategorized_expenses,
  update_expense_category,
} from "./services/categories";
import { create_payment } from "./services/payments";

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
      "bills",
      "freedom unlimited",
      "sapphire",
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
  note: z
    .string()
    .optional()
    .describe(
      "Optional note/memo for the expense (e.g., 'Starbucks with Ana')."
    ),
  funding_account: z
    .enum(["checkings", "bills", "short term savings"])
    .optional()
    .describe(
      "For credit card expenses: which account funds this. Defaults to 'checkings', use 'bills' for recurring bills, use 'short term savings' for planned purchases."
    ),
  // You *can* expose these if you want to manually attach to a budget rule,
  // but they're mainly used by split_paycheck / internal flows.
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
  budget_name: z
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
      budget_name: parsed.budget_name,
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
        budget_name: result.budget_name,
        entries: result.entries,
      },
      content: [
        {
          type: "text",
          text: `Split $${result.gross_amount} paycheck using '${result.budget_name}' rule: ${entries_summary}`,
        },
      ],
    };
  }
);

/* ──────────────────────────────
 * update_last_expense_category tool
 * ────────────────────────────── */

const update_last_expense_category_schema = z.object({
  category: z
    .string()
    .describe("New category name (e.g., 'groceries', 'out', 'car')."),
});

server.registerTool(
  "update_last_expense_category",
  {
    title: "update last expense category",
    description:
      "Update the category of the most recently added expense. Useful to fix the category right after adding an expense.",
    inputSchema: update_last_expense_category_schema,
  },
  async (args) => {
    console.log(
      "[MCP] update_last_expense_category called",
      new Date().toISOString(),
      JSON.stringify(args)
    );

    const parsed = update_last_expense_category_schema.parse(args);
    const result = await update_last_expense_category(parsed);

    if (!result.success) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to update last expense: ${result.error}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Updated last expense to category "${result.category}"`,
        },
      ],
    };
  }
);

/* ──────────────────────────────
 * get_uncategorized_expenses tool
 * ────────────────────────────── */

server.registerTool(
  "get_uncategorized_expenses",
  {
    title: "get uncategorized expenses",
    description:
      'Returns all expenses with category "other" (the inbox). Returns id, amount, note, and date for each.',
    inputSchema: z.object({}),
  },
  async () => {
    console.log(
      "[MCP] get_uncategorized_expenses called",
      new Date().toISOString()
    );

    const result = await get_uncategorized_expenses();

    if (!result.success) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to get uncategorized expenses: ${result.error}`,
          },
        ],
        isError: true,
      };
    }

    const expenses = result.expenses || [];
    if (expenses.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No uncategorized expenses found. Inbox is clean!",
          },
        ],
      };
    }

    return {
      structuredContent: { expenses },
      content: [
        {
          type: "text" as const,
          text: `Found ${expenses.length} uncategorized expense(s):\n${expenses
            .map((e) => `- $${e.amount} "${e.note}" (${e.date}) [${e.id}]`)
            .join("\n")}`,
        },
      ],
    };
  }
);

/* ──────────────────────────────
 * update_expense_category tool
 * ────────────────────────────── */

const update_expense_category_schema = z.object({
  expense_id: z
    .string()
    .describe("The Notion page ID of the expense to update."),
  category: z
    .string()
    .describe("New category name (e.g., 'groceries', 'out', 'car')."),
});

server.registerTool(
  "update_expense_category",
  {
    title: "update expense category",
    description: "Update the category of a specific expense by its ID.",
    inputSchema: update_expense_category_schema,
  },
  async (args) => {
    console.log(
      "[MCP] update_expense_category called",
      new Date().toISOString(),
      JSON.stringify(args)
    );

    const parsed = update_expense_category_schema.parse(args);
    const result = await update_expense_category(parsed);

    if (!result.success) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to update expense: ${result.error}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Updated expense to category "${result.category}"`,
        },
      ],
    };
  }
);

/* ──────────────────────────────
 * create_payment tool
 * ────────────────────────────── */

const create_payment_schema = z.object({
  amount: z
    .number()
    .positive()
    .describe("The payment amount (e.g., credit card payment)."),
  from_account: z
    .enum(["checkings", "bills", "short term savings"])
    .optional()
    .describe(
      "The account the payment is coming from. Defaults to 'checkings'."
    ),
  to_account: z
    .enum(["sapphire", "freedom unlimited"])
    .optional()
    .describe("The credit card account being paid. Defaults to 'sapphire'."),
  date: z
    .string()
    .optional()
    .describe("ISO date (YYYY-MM-DD). Defaults to today."),
  note: z.string().optional().describe("Optional note for the payment."),
});

server.registerTool(
  "create_payment",
  {
    title: "create payment",
    description:
      "Create a credit card payment and automatically clear matching expenses. The payment will be applied to uncleared expenses (oldest first) from the specified credit card that were funded by the specified account.",
    inputSchema: create_payment_schema,
  },
  async (args) => {
    console.log(
      "[MCP] create_payment called",
      new Date().toISOString(),
      JSON.stringify(args)
    );

    const parsed = create_payment_schema.parse(args);
    const result = await create_payment(parsed);

    if (!result.success) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to create payment: ${result.error}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: result.message || `Payment created successfully.`,
        },
      ],
      structuredContent: {
        payment_id: result.payment_id,
        cleared_expenses: result.cleared_expenses,
        cleared_total: result.cleared_total,
        remaining_unapplied: result.remaining_unapplied,
      },
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
