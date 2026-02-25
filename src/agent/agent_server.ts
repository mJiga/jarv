// src/agent/agent_server.ts
// Agent server: receives natural language, infers action via LLM, calls MCP tools.
// Acts as the bridge between user input and the MCP tool layer.

import "dotenv/config";
import express, { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { infer_action, parsed_action } from "./llm/gemini_client";
import {
  call_add_transaction_batch_tool,
  call_add_transaction_tool,
  call_set_budget_rule_tool,
  call_split_paycheck_tool,
  call_get_uncategorized_transactions_tool,
  call_get_categories_tool,
  call_update_transaction_category_tool,
  call_update_transaction_categories_batch_tool,
  call_check_balance_tool,
  call_get_uncleared_expenses_tool,
} from "./mcp_client";
import { REQUEST_BODY_LIMIT } from "../mcp/constants";

const PORT = Number(process.env.AGENT_PORT ?? 4000);

const app = express();
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));
app.use(rateLimit({ windowMs: 60_000, max: 30 }));

// Auth middleware — skip if API_SECRET not set (dev mode)
const API_SECRET = process.env.API_SECRET;
if (API_SECRET) {
  app.use((req, res, next) => {
    const auth = req.headers["authorization"];
    if (auth !== `Bearer ${API_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  });
}

/**
 * POST /chat
 * Receives { message: string }, infers action, executes MCP tool, returns result.
 */
app.post("/chat", async (req: Request, res: Response) => {
  try {
    const message = req.body?.message;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing 'message' string field" });
    }

    console.log("[Agent] User message:", message);

    const action = await infer_action(message);
    console.log("[Agent] Parsed action:", action);

    if (!action?.action || action.action === "unknown") {
      return res.json({
        reply: "I couldn't confidently map that to a tool call.",
        meta: action,
      });
    }

    let mcp_result: { raw: Record<string, unknown>; message: string } | null = null;

    // Route to appropriate MCP tool
    switch (action.action) {
      case "add_transaction":
        mcp_result = await call_add_transaction_tool(action.args);
        break;

      case "add_transaction_batch":
        mcp_result = await call_add_transaction_batch_tool(action.args);
        break;

      case "set_budget_rule":
        mcp_result = await call_set_budget_rule_tool(action.args);
        break;

      case "split_paycheck":
        mcp_result = await call_split_paycheck_tool(action.args);
        break;

      case "get_uncategorized_transactions":
        mcp_result = await call_get_uncategorized_transactions_tool();
        break;

      case "get_categories":
        mcp_result = await call_get_categories_tool();
        break;

      case "update_transaction_category":
        mcp_result = await call_update_transaction_category_tool(action.args);
        break;

      case "update_transaction_categories_batch":
        mcp_result = await call_update_transaction_categories_batch_tool(action.args);
        break;

      case "check_balance":
        mcp_result = await call_check_balance_tool(action.args);
        break;

      case "get_uncleared_expenses":
        mcp_result = await call_get_uncleared_expenses_tool(action.args);
        break;

      default: {
        const _exhaustive: never = action;
        return res.json({
          reply: `Unhandled action type: ${(_exhaustive as parsed_action).action}`,
          meta: _exhaustive,
        });
      }
    }

    return res.json({
      reply: mcp_result?.message ?? "Done.",
      meta: { action, mcp: mcp_result?.raw ?? null },
    });
  } catch (err: unknown) {
    console.error("[Agent] Error handling /chat:", err);
    // Don't leak internal error details to the client
    return res.status(500).json({
      error: "Internal server error",
    });
  }
});

const http_server = app.listen(PORT, () => {
  console.log(`Agent server listening on http://localhost:${PORT}/chat`);
});

// Graceful shutdown
const shutdown = () => {
  console.log("[Agent] Shutting down gracefully...");
  http_server.close(() => {
    console.log("[Agent] HTTP server closed.");
    process.exit(0);
  });
  setTimeout(() => {
    console.error("[Agent] Forced shutdown after timeout.");
    process.exit(1);
  }, 10_000);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
