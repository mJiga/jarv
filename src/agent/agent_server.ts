// src/agent/agent_server.ts
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
  call_stage_expense_category_updates_tool,
  call_confirm_expense_category_updates_tool,
  call_stage_statement_transactions_tool,
  call_confirm_statement_import_tool,
  call_finalize_statement_import_tool,
  call_create_payment_tool,
} from "./mcp_client";
import { run_inbox_cleanup } from "./flows/inbox_cleanup";

const PORT = Number(process.env.AGENT_PORT ?? 4000);

type any_action = {
  action: string;
  args?: any;
};

const app = express();
app.use(express.json());

app.post("/chat", async (req: Request, res: Response) => {
  try {
    const message = req.body?.message;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing 'message' string field" });
    }

    console.log("[Agent] User message:", message);

    // IMPORTANT: cast to loose type to avoid TS "never" when you add new actions.
    const action = (await infer_action(message)) as any_action;
    console.log("[Agent] Parsed action:", action);

    // If your infer_action sometimes returns { action: "unknown" }
    if (!action?.action || action.action === "unknown") {
      return res.json({
        reply: "I couldn't confidently map that to a tool call.",
        meta: action,
      });
    }

    let mcp_result: { raw: any; message: string } | null = null;

    switch (action.action) {
      case "add_transaction":
        mcp_result = await call_add_transaction_tool(action.args);
        break;

      // NOTE: your Gemini might call this "add_transactions_batch" or "add_transaction_batch"
      case "add_transactions_batch":
      case "add_transaction_batch":
        mcp_result = await call_add_transaction_batch_tool(action.args);
        break;

      case "set_budget_rule":
        mcp_result = await call_set_budget_rule_tool(action.args);
        break;

      case "split_paycheck":
        mcp_result = await call_split_paycheck_tool(action.args);
        break;

      case "update_last_expense_category":
        mcp_result = await call_update_last_expense_category_tool(action.args);
        break;

      case "get_uncategorized_expenses": {
        // Runs your Gemini categorization flow and stages the updates
        const result = await run_inbox_cleanup();
        return res.json({
          reply: result.message,
          meta: { action, ...result },
        });
      }

      case "update_expense_category":
        mcp_result = await call_update_expense_category_tool(action.args);
        break;

      case "update_expense_category_batch": {
        // Stage instead of auto-apply
        const stage = await call_stage_expense_category_updates_tool({
          updates: action.args?.updates ?? [],
        });

        const batch_id =
          stage.raw?.result?.structuredContent?.batch_id ?? "unknown";

        return res.json({
          reply:
            `I staged ${
              (action.args?.updates ?? []).length
            } category update(s) (batch_id=${batch_id}). ` +
            `Say "confirm ${batch_id}" to apply, or tell me what to change.`,
          meta: {
            action,
            batch_id,
            staged: stage.raw?.result?.structuredContent,
          },
        });
      }

      case "stage_expense_category_updates":
        mcp_result = await call_stage_expense_category_updates_tool(
          action.args
        );
        break;

      case "confirm_expense_category_updates":
        mcp_result = await call_confirm_expense_category_updates_tool(
          action.args
        );
        break;

      case "create_payment":
        mcp_result = await call_create_payment_tool(action.args);
        break;

      // Bank statement tools (passthrough)
      case "stage_statement_transactions":
        mcp_result = await call_stage_statement_transactions_tool(action.args);
        break;

      case "confirm_statement_import":
        mcp_result = await call_confirm_statement_import_tool(action.args);
        break;

      case "finalize_statement_import":
        mcp_result = await call_finalize_statement_import_tool(action.args);
        break;

      default:
        return res.json({
          reply: `Unhandled action type: ${action.action}`,
          meta: action,
        });
    }

    return res.json({
      reply: mcp_result?.message ?? "Done.",
      meta: { action, mcp: mcp_result?.raw ?? null },
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
