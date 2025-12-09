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
    "amount": number,                 // positive
    "transaction_type": "expense" | "income",
    "account": string,                // one of: "checkings", "savings", "freedom unlimited", "brokerage", "roth ira", "spaxx"
    "category": string,               // optional, short label like "food", "transport"
    "date": "YYYY-MM-DD"              // optional, if user says "yesterday", you convert it to a date; otherwise omit
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
- Default date to today if not specified.

User message:
${userMessage}
`;
}
