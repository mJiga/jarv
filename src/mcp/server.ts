// src/mcp/server.ts
// MCP server exposing finance tools via JSON-RPC over HTTP.
// Stateless design - each request is independent.

import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import {
  ACCOUNTS,
  FUNDING_ACCOUNTS,
  CREDIT_CARD_ACCOUNTS,
  REQUEST_BODY_LIMIT,
} from "./constants";
import {
  add_transaction,
  add_transactions_batch,
  add_transaction_input,
} from "./services/transactions";
import { set_budget_rule, split_paycheck } from "./services/budgets";
import {
  get_uncategorized_transactions,
  update_transaction_category,
  update_transaction_categories_batch,
} from "./services/categories";
import { get_available_categories } from "./notion/utils";

const server = new McpServer({
  name: "jarvis",
  version: "0.1.0",
});

// -----------------------------------------------------------------------------
// Input Schemas (Zod)
// -----------------------------------------------------------------------------

const account_enum = z.enum(ACCOUNTS);
const funding_account_enum = z.enum(FUNDING_ACCOUNTS);
const cc_account_enum = z.enum(CREDIT_CARD_ACCOUNTS);
const transaction_type_enum = z.enum(["expense", "income", "payment"]);

const add_transaction_schema = z.object({
  amount: z.number().positive(),
  transaction_type: transaction_type_enum,
  account: account_enum.optional(),
  category: z.string().optional(),
  date: z.string().optional(),
  note: z.string().optional(),
  funding_account: funding_account_enum.optional(),
  from_account: funding_account_enum.optional(),
  to_account: cc_account_enum.optional(),
  pre_breakdown: z.number().optional(),
  budget: z.string().optional(),
});

const add_transactions_batch_schema = z.object({
  transactions: z.array(add_transaction_schema).min(1),
});

const set_budget_rule_schema = z.object({
  budget_name: z.string(),
  budgets: z
    .array(z.object({ account: z.string(), percentage: z.number().min(0).max(1) }))
    .min(1),
});

const split_paycheck_schema = z.object({
  gross_amount: z.number().positive(),
  budget_name: z.string().optional(),
  date: z.string().optional(),
  description: z.string().optional(),
});

const update_category_schema = z.object({
  expense_id: z.string(),
  category: z.string(),
});

const update_categories_batch_schema = z.object({
  updates: z.array(z.object({ expense_id: z.string(), category: z.string() })).min(1),
});

// -----------------------------------------------------------------------------
// Tools: Transactions
// -----------------------------------------------------------------------------

server.registerTool(
  "add_transaction",
  {
    title: "add a transaction",
    description:
      "Add an expense, income, or payment to Notion. Payments auto-clear matching expenses.",
    inputSchema: add_transaction_schema,
  },
  async (args: Record<string, unknown>) => {
    console.log("[MCP] add_transaction", new Date().toISOString(), JSON.stringify(args));

    const parsed = add_transaction_schema.parse(args) as add_transaction_input;
    const result = await add_transaction(parsed);

    if (!result.success) {
      return {
        content: [{ type: "text", text: `MCP error: ${result.error ?? "Failed."}` }],
        isError: true,
      };
    }

    const structured: Record<string, unknown> = {
      transaction_id: result.transaction_id,
      amount: parsed.amount,
      transaction_type: parsed.transaction_type,
    };

    if (result.cleared_expenses) {
      structured.cleared_expenses = result.cleared_expenses;
      structured.cleared_total = result.cleared_total;
      structured.remaining_unapplied = result.remaining_unapplied;
    }

    return {
      structuredContent: structured,
      content: [{ type: "text", text: result.message ?? "Transaction added." }],
      _meta: {},
    };
  }
);

server.registerTool(
  "add_transactions_batch",
  {
    title: "add multiple transactions",
    description: "Batch add expense/income/payment transactions.",
    inputSchema: add_transactions_batch_schema,
  },
  async (args: Record<string, unknown>) => {
    console.log("[MCP] add_transactions_batch", new Date().toISOString(), JSON.stringify(args));

    const parsed = add_transactions_batch_schema.parse(args);
    const result = await add_transactions_batch({
      transactions: parsed.transactions as add_transaction_input[],
    });

    return {
      structuredContent: { results: result.results },
      content: [
        {
          type: "text",
          text: `Processed ${result.results.length} transactions in batch. ${result.success_count} succeeded.`,
        },
      ],
      _meta: {},
    };
  }
);

// -----------------------------------------------------------------------------
// Tools: Budgets
// -----------------------------------------------------------------------------

server.registerTool(
  "set_budget_rule",
  {
    title: "set a budget rule",
    description: "Create or update a budget rule for paycheck splitting.",
    inputSchema: set_budget_rule_schema,
  },
  async (args: Record<string, unknown>) => {
    console.log("[MCP] set_budget_rule", new Date().toISOString(), JSON.stringify(args));

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
  async (args: Record<string, unknown>) => {
    console.log("[MCP] split_paycheck", new Date().toISOString(), JSON.stringify(args));

    const parsed = split_paycheck_schema.parse(args);
    const result = await split_paycheck(parsed);

    if (!result.success) {
      return {
        content: [{ type: "text", text: `MCP error: ${result.error}` }],
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
          text: `Split $${result.gross_amount} using '${result.budget_name}': ${entries_summary}`,
        },
      ],
      _meta: {},
    };
  }
);

// -----------------------------------------------------------------------------
// Tools: Categories
// -----------------------------------------------------------------------------

server.registerTool(
  "get_uncategorized_transactions",
  {
    title: "get uncategorized transactions",
    description: 'Returns expenses with category "other" (the inbox).',
    inputSchema: z.object({}),
  },
  async () => {
    console.log("[MCP] get_uncategorized_transactions", new Date().toISOString());

    const result = await get_uncategorized_transactions();

    if (!result.success) {
      return {
        content: [{ type: "text", text: `Failed: ${result.error}` }],
        isError: true,
      };
    }

    return {
      structuredContent: { expenses: result.expenses ?? [] },
      content: [
        { type: "text", text: `Found ${(result.expenses ?? []).length} uncategorized expense(s).` },
      ],
      _meta: {},
    };
  }
);

server.registerTool(
  "get_categories",
  {
    title: "get available categories",
    description: "Returns the list of valid expense categories.",
    inputSchema: z.object({}),
  },
  async () => {
    console.log("[MCP] get_categories", new Date().toISOString());

    const categories = await get_available_categories();

    return {
      structuredContent: { categories },
      content: [{ type: "text", text: `Available categories: ${categories.join(", ")}` }],
      _meta: {},
    };
  }
);

server.registerTool(
  "update_transaction_category",
  {
    title: "update transaction category",
    description: "Update category of one expense by ID.",
    inputSchema: update_category_schema,
  },
  async (args: Record<string, unknown>) => {
    console.log("[MCP] update_transaction_category", new Date().toISOString(), JSON.stringify(args));

    const parsed = update_category_schema.parse(args);
    const result = await update_transaction_category(parsed);

    if (!result.success) {
      return {
        content: [{ type: "text", text: `Failed: ${result.error}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: `Updated expense to "${result.category}".` }],
      _meta: {},
    };
  }
);

server.registerTool(
  "update_transaction_categories_batch",
  {
    title: "update transaction categories batch",
    description: "Update categories for multiple expenses at once.",
    inputSchema: update_categories_batch_schema,
  },
  async (args: Record<string, unknown>) => {
    console.log("[MCP] update_transaction_categories_batch", new Date().toISOString(), JSON.stringify(args));

    const parsed = update_categories_batch_schema.parse(args);
    const result = await update_transaction_categories_batch(parsed);

    return {
      structuredContent: { results: result.results },
      content: [
        { type: "text", text: `Applied ${result.success_count}/${result.results.length} category update(s).` },
      ],
      _meta: {},
    };
  }
);

// -----------------------------------------------------------------------------
// HTTP Transport
// -----------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 3000);

// Check which env vars are set (for debugging)
function checkEnvVars(): { missing: string[]; set: string[] } {
  const required = [
    "NOTION_API_KEY",
    "EXPENSES_DB_ID",
    "INCOME_DB_ID",
    "PAYMENTS_DB_ID",
    "ACCOUNTS_DB_ID",
    "CATEGORIES_DB_ID",
    "BUDGET_RULES_DB_ID",
  ];
  const missing: string[] = [];
  const set: string[] = [];
  for (const name of required) {
    if (process.env[name]) {
      set.push(name);
    } else {
      missing.push(name);
    }
  }
  return { missing, set };
}

async function main() {
  const app = express();
  app.use(express.json({ limit: REQUEST_BODY_LIMIT }));

  // Health check endpoint
  app.get("/health", (_req: Request, res: Response) => {
    const envCheck = checkEnvVars();
    res.json({
      status: envCheck.missing.length === 0 ? "ok" : "misconfigured",
      timestamp: new Date().toISOString(),
      env: {
        set: envCheck.set,
        missing: envCheck.missing,
      },
    });
  });

  // Root endpoint for quick status
  app.get("/", (_req: Request, res: Response) => {
    const envCheck = checkEnvVars();
    res.json({
      name: "jarvis-mcp-server",
      version: "0.1.0",
      status: envCheck.missing.length === 0 ? "ready" : "missing env vars",
      endpoints: {
        mcp: "POST /mcp",
        health: "GET /health",
      },
      missing_env_vars: envCheck.missing,
    });
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // Stateless
  });

  await server.connect(transport);

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

  const http_server = app.listen(PORT, () => {
    console.log(`MCP server listening on http://localhost:${PORT}/mcp`);
    const envCheck = checkEnvVars();
    if (envCheck.missing.length > 0) {
      console.warn(`Missing env vars: ${envCheck.missing.join(", ")}`);
    } else {
      console.log("All required env vars are set");
    }
  });

  // Graceful shutdown — drain active requests on SIGTERM/SIGINT
  const shutdown = () => {
    console.log("Shutting down gracefully...");
    http_server.close(() => {
      console.log("HTTP server closed.");
      process.exit(0);
    });
    // Force exit after 10 seconds if connections don't close
    setTimeout(() => {
      console.error("Forced shutdown after timeout.");
      process.exit(1);
    }, 10_000);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Error starting MCP server:", err);
  process.exit(1);
});
