// src/mcp/server.ts
import express, { Request, Response } from "express";
import crypto from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import {
  add_transaction,
  add_transaction_input,
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
 * Helpers
 * ────────────────────────────── */

function omit_undefined<T extends Record<string, any>>(obj: T): Partial<T> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

/* ──────────────────────────────
 * Schemas
 * ────────────────────────────── */

// add_transaction supports ONLY expense/income
const transaction_type_values: [
  Exclude<transaction_type, "payment">,
  Exclude<transaction_type, "payment">
] = ["expense", "income"];

const account_enum = z.enum([
  "checkings",
  "short term savings",
  "bills",
  "freedom unlimited",
  "sapphire",
  "brokerage",
  "roth ira",
  "spaxx",
]);

const funding_account_enum = z.enum([
  "checkings",
  "bills",
  "short term savings",
]);
const cc_account_enum = z.enum(["sapphire", "freedom unlimited"]);

const add_transaction_schema = z.object({
  amount: z.number().positive(),
  transaction_type: z.enum(transaction_type_values),
  account: account_enum.optional(),
  category: z.string().optional(),
  date: z.string().optional(), // YYYY-MM-DD
  note: z.string().optional(),
  funding_account: funding_account_enum.optional(),

  // income fields (optional)
  pre_breakdown: z.number().optional(),
  budget: z.string().optional(),
});

// Payment schema (batch/stmts; routed to create_payment)
const payment_schema = z.object({
  amount: z.number().positive(),
  transaction_type: z.literal("payment"),
  from_account: funding_account_enum.optional(),
  to_account: cc_account_enum.optional(),
  date: z.string().optional(),
  note: z.string().optional(),
});

const statement_transaction_schema = z.discriminatedUnion("transaction_type", [
  add_transaction_schema,
  payment_schema,
]);

type routed_tx = z.infer<typeof statement_transaction_schema>;

const add_transactions_batch_schema = z.object({
  transactions: z.array(statement_transaction_schema).min(1),
});

const set_budget_rule_schema = z.object({
  budget_name: z.string(),
  budgets: z
    .array(
      z.object({
        account: z.string(),
        percentage: z.number().min(0).max(1),
      })
    )
    .min(1),
});

const split_paycheck_schema = z.object({
  gross_amount: z.number().positive(),
  budget_name: z.string().optional(),
  date: z.string().optional(),
  description: z.string().optional(),
});

const update_last_expense_category_schema = z.object({
  category: z.string(),
});

const update_expense_category_schema = z.object({
  expense_id: z.string(),
  category: z.string(),
});

const update_expense_category_batch_schema = z.object({
  updates: z
    .array(
      z.object({
        expense_id: z.string(),
        category: z.string(),
      })
    )
    .min(1),
});

const create_payment_schema = z.object({
  amount: z.number().positive(),
  from_account: funding_account_enum.optional(),
  to_account: cc_account_enum.optional(),
  date: z.string().optional(),
  note: z.string().optional(),
});

/* ──────────────────────────────
 * Shared helper: routes batch items correctly
 * ────────────────────────────── */

type batch_item_result = {
  index: number;
  success: boolean;
  transaction_id?: string;
  message?: string;
  error?: string;
};

async function process_transactions_batch(
  transactions: routed_tx[]
): Promise<batch_item_result[]> {
  const results: batch_item_result[] = [];

  for (const [index, tx] of transactions.entries()) {
    try {
      if (tx.transaction_type === "payment") {
        const pay_res = await create_payment({
          amount: tx.amount,
          from_account: tx.from_account,
          to_account: tx.to_account,
          date: tx.date,
          note: tx.note,
        });

        results.push(
          omit_undefined({
            index,
            success: pay_res.success,
            transaction_id: pay_res.payment_id,
            message: pay_res.message,
            error: pay_res.error,
          }) as batch_item_result
        );
      } else {
        const tx_res = await add_transaction(tx as add_transaction_input);

        results.push(
          omit_undefined({
            index,
            success: tx_res.success,
            transaction_id: tx_res.transactionId,
            message: tx_res.message,
            error: tx_res.error,
          }) as batch_item_result
        );
      }
    } catch (err: any) {
      results.push({
        index,
        success: false,
        error: err?.message ?? "unknown error while processing batch item.",
      });
    }
  }

  return results;
}

/* ──────────────────────────────
 * Tools: base CRUD
 * ────────────────────────────── */

server.registerTool(
  "add_transaction",
  {
    title: "add a transaction",
    description: "Add an income or expense to Notion (no payments here).",
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
      content: [{ type: "text", text: result.message ?? "Transaction added." }],
      _meta: {},
    };
  }
);

server.registerTool(
  "add_transactions_batch",
  {
    title: "add multiple transactions",
    description:
      "Batch add expense/income and also payments. Payments are routed to create_payment and WILL write to Payments DB.",
    inputSchema: add_transactions_batch_schema,
  },
  async (args) => {
    console.log(
      "[MCP] add_transactions_batch called",
      new Date().toISOString(),
      JSON.stringify(args)
    );

    const parsed = add_transactions_batch_schema.parse(args);
    const results = await process_transactions_batch(parsed.transactions);

    const success_count = results.filter((r) => r.success).length;

    return {
      structuredContent: { results },
      content: [
        {
          type: "text",
          text: `Processed ${results.length} transactions in batch. ${success_count} succeeded.`,
        },
      ],
      _meta: {},
    };
  }
);

server.registerTool(
  "set_budget_rule",
  {
    title: "set a budget rule",
    description: "Create/update a budget rule.",
    inputSchema: set_budget_rule_schema,
  },
  async (args) => {
    console.log(
      "[MCP] set_budget_rule called",
      new Date().toISOString(),
      JSON.stringify(args)
    );

    const parsed = set_budget_rule_schema.parse(args);
    const result = await set_budget_rule(parsed);

    if (!result.success) {
      return {
        content: [{ type: "text", text: `MCP error: ${result.error}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: result.message ?? "Budget rule set." }],
      _meta: {},
    };
  }
);

server.registerTool(
  "split_paycheck",
  {
    title: "split a paycheck",
    description: "Split paycheck across accounts using a budget rule.",
    inputSchema: split_paycheck_schema,
  },
  async (args) => {
    console.log(
      "[MCP] split_paycheck called",
      new Date().toISOString(),
      JSON.stringify(args)
    );

    const parsed = split_paycheck_schema.parse(args);
    const result = await split_paycheck(parsed);

    if (!result.success) {
      return {
        content: [{ type: "text", text: `MCP error: ${result.error}` }],
        isError: true,
      };
    }

    const entries_summary = (result.entries ?? [])
      .map((e: any) => `${e.account}: $${e.amount}`)
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
          text: `Split $${result.gross_amount} using '${result.budget_name}': ${entries_summary}`,
        },
      ],
      _meta: {},
    };
  }
);

server.registerTool(
  "update_last_expense_category",
  {
    title: "update last expense category",
    description: "Update category of most recent expense.",
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
        content: [{ type: "text", text: `Failed: ${result.error}` }],
        isError: true,
      };
    }

    return {
      content: [
        { type: "text", text: `Updated last expense to "${result.category}".` },
      ],
      _meta: {},
    };
  }
);

server.registerTool(
  "get_uncategorized_expenses",
  {
    title: "get uncategorized expenses",
    description: 'Returns expenses with category "other" (the inbox).',
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
        content: [{ type: "text", text: `Failed: ${result.error}` }],
        isError: true,
      };
    }

    return {
      structuredContent: { expenses: result.expenses ?? [] },
      content: [
        {
          type: "text",
          text: `Found ${
            (result.expenses ?? []).length
          } uncategorized expense(s).`,
        },
      ],
      _meta: {},
    };
  }
);

server.registerTool(
  "update_expense_category",
  {
    title: "update expense category",
    description: "Update category of one expense by ID.",
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
        content: [{ type: "text", text: `Failed: ${result.error}` }],
        isError: true,
      };
    }

    return {
      content: [
        { type: "text", text: `Updated expense to "${result.category}".` },
      ],
      _meta: {},
    };
  }
);

server.registerTool(
  "update_expense_category_batch",
  {
    title: "update expense category batch",
    description: "Update categories for multiple expenses at once.",
    inputSchema: update_expense_category_batch_schema,
  },
  async (args) => {
    console.log(
      "[MCP] update_expense_category_batch called",
      new Date().toISOString(),
      JSON.stringify(args)
    );

    const parsed = update_expense_category_batch_schema.parse(args);

    const results: Array<{
      expense_id: string;
      category: string;
      ok: boolean;
      error?: string;
    }> = [];

    for (const u of parsed.updates) {
      try {
        const res = await update_expense_category({
          expense_id: u.expense_id,
          category: u.category,
        });
        results.push({
          expense_id: u.expense_id,
          category: u.category,
          ok: !!res.success,
        });
      } catch (e: any) {
        results.push({
          expense_id: u.expense_id,
          category: u.category,
          ok: false,
          error: e?.message ?? String(e),
        });
      }
    }

    const success_count = results.filter((r) => r.ok).length;

    return {
      structuredContent: { results },
      content: [
        {
          type: "text",
          text: `Applied ${success_count}/${results.length} category update(s).`,
        },
      ],
      _meta: {},
    };
  }
);

server.registerTool(
  "create_payment",
  {
    title: "create payment",
    description:
      "Create a payment record (transfer) and auto-clear matching expenses.",
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
        content: [{ type: "text", text: `Failed: ${result.error}` }],
        isError: true,
      };
    }

    return {
      structuredContent: {
        payment_id: result.payment_id,
        cleared_expenses: result.cleared_expenses,
        cleared_total: result.cleared_total,
        remaining_unapplied: result.remaining_unapplied,
      },
      content: [{ type: "text", text: result.message ?? "Payment created." }],
      _meta: {},
    };
  }
);

/* ──────────────────────────────
 * HTTP MCP Transport
 * ────────────────────────────── */

const PORT = Number(process.env.PORT ?? 3000);

async function main() {
  const app = express();
  app.use(express.json());

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  await server.connect(transport);

  // Handle POST requests (primary endpoint for ChatGPT/external clients)
  app.post("/mcp", async (req: Request, res: Response) => {
    try {
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("Error handling MCP request:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
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
