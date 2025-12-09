// src/agent/llm/geminiClient.ts
import "dotenv/config";
import { GoogleGenerativeAI } from "@google/generative-ai";

if (!process.env.GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is not set in .env");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

export type ParsedAction =
  | {
      action: "add_transaction";
      args: {
        amount: number;
        transaction_type: "expense" | "income";
        account:
          | "checkings"
          | "savings"
          | "freedom unlimited"
          | "brokerage"
          | "roth ira"
          | "spaxx";
        category?: string;
        date?: string;
      };
    }
  | {
      action: "unknown";
      reason?: string;
    };

function buildPrompt(userMessage: string): string {
  return `
You are a finance command parser for my personal expense tracker.

Your ONLY job is to read the user's message and output STRICT JSON (no extra text).
You can ONLY choose between these actions:
- "add_transaction": when the user clearly wants to add an expense or income.
- "unknown": when you are not sure what they want you to do.

JSON schema:

{
  "action": "add_transaction",
  "args": {
    "amount": number,
    "transaction_type": "expense" | "income",
    "account": string,                // one of: "checkings", "savings", "freedom unlimited", "brokerage", "roth ira", "spaxx"
    "category": string,               // optional, short label like "food", "transport"
    "date": "YYYY-MM-DD"              // optional, the date the request was made
  }
}

OR:

{
  "action": "unknown",
  "reason": "short explanation"
}
  
Rules:
- Respond with JSON ONLY. No code fences, no Markdown, no explanations.
- If the message is clearly about adding a transaction, pick "add_transaction".
- Default category to "other" if not specified.
- Default date to "today" if not specified.

User message:
${userMessage}
`;
}

function extractJson(text: string): any {
  // Sometimes models wrap JSON in ```...```
  const trimmed = text.trim();

  const codeFenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = codeFenceMatch ? codeFenceMatch[1] : trimmed;

  if (!jsonText) {
    throw new Error("Invalid JSON: input is undefined");
  }
  return JSON.parse(jsonText);
}

export async function inferAction(userMessage: string): Promise<ParsedAction> {
  const prompt = buildPrompt(userMessage);

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });

  const text = result.response.text();

  try {
    const parsed = extractJson(text);

    if (parsed.action === "add_transaction" && parsed.args) {
      const a = parsed.args;
      if (
        typeof a.amount === "number" &&
        (a.transaction_type === "expense" || "income") &&
        typeof a.account === "string"
      ) {
        return {
          action: "add_transaction",
          args: {
            amount: a.amount,
            transaction_type: a.transaction_type,
            account: a.account,
            category: a.category,
            date: a.date,
          },
        };
      }
    }

    return {
      action: "unknown",
      reason: "Parsed JSON did not match expected schema.",
    };
  } catch (err: any) {
    console.error("[Gemini] Failed to parse JSON:", err);
    return {
      action: "unknown",
      reason: "Failed to parse model output as JSON.",
    };
  }
}
