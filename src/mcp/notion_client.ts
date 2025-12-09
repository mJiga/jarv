import "dotenv/config";
import { Client } from "@notionhq/client";

const apiKey = process.env.NOTION_API_KEY;
const transactionsDbId = process.env.TRANSACTIONS_DB_ID;

if (!apiKey) {
  throw new Error("NOTION_API_KEY is not set in .env");
}

if (!transactionsDbId) {
  throw new Error("TRANSACTIONS_DB_ID is not set in .env");
}

export const notion = new Client({ auth: apiKey });
export const TRANSACTIONS_DB_ID = transactionsDbId;
