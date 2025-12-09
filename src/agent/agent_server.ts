// src/agent/agentServer.ts
import "dotenv/config";
import express, { Request, Response } from "express";
import { inferAction } from "./llm/gemini_client";
import { callAddTransactionTool } from "./mcp_client";

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
    const action = await inferAction(message);
    console.log("[Agent] Parsed action:", action);

    if (action.action === "unknown") {
      return res.json({
        reply:
          "I couldn't confidently map that to a transaction command. " +
          "Try something like: 'Add 14 dollars for tacos from checkings.'",
        meta: action,
      });
    }

    // 2) Call MCP tool if it's an add_transaction
    const mcpResult = await callAddTransactionTool(action.args);

    return res.json({
      reply: mcpResult.message,
      meta: {
        action,
        mcp: mcpResult.raw,
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
