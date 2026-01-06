// src/agent/agentServer.ts
import "dotenv/config";
import express, { Request, Response } from "express";
import { infer_action } from "./llm/gemini_client";
import {
  call_add_transaction_batch_tool,
  call_add_transaction_tool,
  call_set_budget_rule_tool,
  call_split_paycheck_tool,
  call_update_last_expense_category_tool,
  call_update_expense_category_tool,
  call_create_payment_tool,
} from "./mcp_client";
import { run_inbox_cleanup } from "./flows/inbox_cleanup";

const PORT = Number(process.env.AGENT_PORT ?? 4000);

const app = express();
app.use(express.json());

app.post("/chat", async (req: Request, res: Response) => {
  try {
    const { message } = req.body as { message?: string };

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing 'message' string field" });
    }

    console.log("[Agent] User message:", message);

    // 1) Ask Gemini what to do
    const action = await infer_action(message);
    console.log("[Agent] Parsed action:", action);

    if (action.action === "unknown") {
      return res.json({
        reply: "I couldn't confidently map that to a transaction command. ",
        meta: action,
      });
    }

    // 2) Call the appropriate MCP tool
    let mcp_result;

    if (action.action === "add_transaction") {
      mcp_result = await call_add_transaction_tool(action.args);
    } else if (action.action === "add_transaction_batch") {
      mcp_result = await call_add_transaction_batch_tool(action.args);
    } else if (action.action === "set_budget_rule") {
      mcp_result = await call_set_budget_rule_tool(action.args);
    } else if (action.action === "split_paycheck") {
      mcp_result = await call_split_paycheck_tool(action.args);
    } else if (action.action === "update_last_expense_category") {
      mcp_result = await call_update_last_expense_category_tool(action.args);
    } else if (action.action === "get_uncategorized_expenses") {
      const result = await run_inbox_cleanup();
      return res.json({
        reply: result.message,
        meta: { action, ...result },
      });
    } else if (action.action === "update_expense_category_batch") {
      const updates: string[] = [];
      for (const update of action.args.updates) {
        await call_update_expense_category_tool(update);
        updates.push(`${update.expense_id} → ${update.category}`);
      }
      return res.json({
        reply: `Updated ${updates.length} expense(s).`,
        meta: { action, updates },
      });
    } else if (action.action === "create_payment") {
      mcp_result = await call_create_payment_tool(action.args);
    } else {
      return res.json({
        reply: "Unhandled action type.",
        meta: action,
      });
    }

    return res.json({
      reply: mcp_result.message,
      meta: {
        action,
        mcp: mcp_result.raw,
      },
    });
  } catch (err: any) {
    console.error("[Agent] Error handling /chat:", err);
    return res.status(500).json({
      error: "Internal server error",
      details: err?.message ?? String(err),
    });
  }
});

app.listen(PORT, () => {
  console.log(`Agent server listening on http://localhost:${PORT}/chat`);
});
