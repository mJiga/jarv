# Jarvis — Personal Finance MCP Server + Agent

A Model Context Protocol (MCP) server for personal finance tracking, backed by Notion databases. Includes an LLM-powered agent (Gemini) that parses natural language into structured tool calls.

> **Important:** This project is tightly coupled to a specific Notion workspace:  
> **[Jarvis Notion Site](https://memoo0.notion.site/jarv-2c44abe19ef580d4a728c3bb2509558e)**
>
> The database schemas, relations, and formulas are configured within Notion itself. To use this project, in order to procede, duplicate the notion template

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           USER INPUT                                │
│              "spent $12 on groceries at Trader Joes"                │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────┐
│                      AGENT SERVER (port 4000)                      │
│                         POST /chat                                 │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Gemini Client (gemini_client.ts) or LLM Provider           │   │
│  │  - Parses natural language → structured action              │   │
│  │  - Infers: action type, amount, category, account, etc.     │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                     │
│                              ▼                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  MCP Client (mcp_client.ts)                                 │   │
│  │  - Calls MCP tools via JSON-RPC                             │   │
│  └─────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────   ┐
│                       MCP SERVER (port 3000)                            │
│                         POST /mcp                                       │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  Registered Tools (server.ts)                                    │   │
│  │  - add_transaction         - get_categories                      │   │
│  │  - add_transactions_batch  - get_uncategorized_transactions      │   │
│  │  - set_budget_rule         - update_transaction_category         │   │
│  │  - split_paycheck          - update_transaction_categories_batch │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                      │
│                              ▼                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Services Layer                                             │   │
│  │  - transactions.ts  (add_transaction, batch)                │   │
│  │  - payments.ts      (create_payment, auto-clear expenses)   │   │
│  │  - categories.ts    (get/update uncategorized)              │   │
│  │  - budgets.ts       (set_budget_rule, split_paycheck)       │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                      │
│                              ▼                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Notion Layer (notion/client.ts, notion/utils.ts)           │   │
│  │  - API client + DB IDs                                      │   │
│  │  - Category caching + validation                            │   │
│  │  - Account/budget rule lookups                              │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         NOTION DATABASES                            │
│  - Expenses DB       - Income DB        - Payments DB              │
│  - Accounts DB       - Categories DB    - Budget Rules DB          │
└─────────────────────────────────────────────────────────────────────┘
```

> **Note:** If using the MCP server through ChatGPT, Claude, or other LLM clients with native MCP support, the entire `src/agent/` directory is not necessary. Those clients call the MCP tools directly at `POST /mcp`. The agent is only needed if you want a standalone `/chat` endpoint with Gemini-based parsing.

---

## Project Structure

```
jarvis/
├── src/
│   ├── mcp/                        # MCP Server (port 3000)
│   │   ├── server.ts               # Express + MCP tool registration
│   │   ├── constants.ts            # Shared account enums + validators
│   │   ├── notion/
│   │   │   ├── client.ts           # Notion API client + DB IDs
│   │   │   └── utils.ts            # Helpers: category cache, lookups
│   │   └── services/
│   │       ├── transactions.ts     # add_transaction, batch
│   │       ├── payments.ts         # create_payment, auto-clear
│   │       ├── categories.ts       # uncategorized + updates
│   │       └── budgets.ts          # budget rules + paycheck split
│   │
│   └── agent/                      # Agent Server (port 4000)
│       ├── agent_server.ts         # Express /chat endpoint
│       ├── mcp_client.ts           # JSON-RPC client for MCP
│       └── llm/
│           └── gemini_client.ts    # Gemini prompt + action parser
│
├── package.json
├── tsconfig.json
├── .env                            # Environment variables (not committed)
└── README.md
```

---

## Setup

### 1. Prerequisites

- Node.js 18+
- Notion account with API integration
- Gemini API key

### 2. Notion Database Setup

Create 6 databases in Notion with these schemas:

| Database         | Required Properties                                                                                                                                                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Expenses**     | `title`, `amount` (number), `date` (date), `accounts` (relation→Accounts), `categories` (relation→Categories), `funding_account` (relation→Accounts), `cleared` (checkbox), `cleared_by` (relation→Payments), `paid_amount` (number), `note` (rich_text) |
| **Income**       | `title`, `amount` (number), `date` (date), `accounts` (relation→Accounts), `categories` (relation→Categories), `pre_breakdown` (number), `budget` (relation→Budget Rules), `note` (rich_text)                                                            |
| **Payments**     | `title`, `amount` (number), `date` (date), `from_account` (relation→Accounts), `to_account` (relation→Accounts), `cleared_expenses` (relation→Expenses), `note` (rich_text)                                                                              |
| **Accounts**     | `title` (account name: checkings, bills, sapphire, etc.)                                                                                                                                                                                                 |
| **Categories**   | `title` (category name: groceries, out, lyft, etc.)                                                                                                                                                                                                      |
| **Budget Rules** | `title` (rule name), `account` (relation→Accounts), `percentage` (number 0-1)                                                                                                                                                                            |

### 3. Environment Variables

Copy `.env.example` to `.env` and fill in:

```bash
# Notion
NOTION_API_KEY=secret_xxx
EXPENSES_DB_ID=xxx
INCOME_DB_ID=xxx
PAYMENTS_DB_ID=xxx
ACCOUNTS_DB_ID=xxx
CATEGORIES_DB_ID=xxx
BUDGET_RULES_DB_ID=xxx

# Gemini (for Agent)
GEMINI_API_KEY=xxx

# Optional: Credit card last-4 digits (for LLM card matching)
SAPPHIRE_LAST4=xxxx
FREEDOM_LAST4=xxxx

# Optional: custom ports
PORT=3000           # MCP server
AGENT_PORT=4000     # Agent server
MCP_BASE_URL=http://localhost:3000
```

### 4. Install & Run

```bash
npm install

# Terminal 1: MCP Server
npm run mcp

# Terminal 2: Agent Server
npm run agent
```

---

## MCP Tools Reference

### Transactions

| Tool                     | Description                     | Key Args                                                                                                             |
| ------------------------ | ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `add_transaction`        | Add expense, income, or payment | `amount`, `transaction_type`, `account`, `category`, `date`, `note`, `funding_account`, `from_account`, `to_account` |
| `add_transactions_batch` | Batch add multiple transactions | `transactions[]`                                                                                                     |

### Categories

| Tool                                  | Description                        | Key Args                 |
| ------------------------------------- | ---------------------------------- | ------------------------ |
| `get_categories`                      | List valid categories (cached)     | —                        |
| `get_uncategorized_transactions`      | Get expenses with category "other" | —                        |
| `update_transaction_category`         | Update one expense's category      | `expense_id`, `category` |
| `update_transaction_categories_batch` | Batch update categories            | `updates[]`              |

### Budgets

| Tool              | Description                     | Key Args                                          |
| ----------------- | ------------------------------- | ------------------------------------------------- |
| `set_budget_rule` | Create/update budget allocation | `budget_name`, `budgets[]` (account + percentage) |
| `split_paycheck`  | Split gross paycheck by rule    | `gross_amount`, `budget_name`, `date`             |

---

## API Endpoints

### MCP Server (`localhost:3000`)

```
POST /mcp
Content-Type: application/json
Accept: application/json, text/event-stream

{
  "jsonrpc": "2.0",
  "id": "1",
  "method": "tools/call",
  "params": {
    "name": "add_transaction",
    "arguments": {
      "amount": 12.34,
      "transaction_type": "expense",
      "account": "sapphire",
      "funding_account": "checkings",
      "category": "groceries",
      "date": "2026-01-10",
      "note": "Trader Joes"
    }
  }
}
```

### Agent Server (`localhost:4000`)

```
POST /chat
Content-Type: application/json

{
  "message": "spent $12.34 on groceries at Trader Joes yesterday"
}
```

Response:

```json
{
  "reply": "added expense of $12.34 to sapphire (category: groceries).",
  "meta": {
    "action": { "action": "add_transaction", "args": {...} },
    "mcp": {...}
  }
}
```

---

## Valid Accounts

| Type             | Values                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| All accounts     | `checkings`, `short term savings`, `bills`, `freedom unlimited`, `sapphire`, `brokerage`, `roth ira`, `spaxx` |
| Funding accounts | `checkings`, `bills`, `short term savings`                                                                    |
| Credit cards     | `sapphire`, `freedom unlimited`                                                                               |

---

## Key Features

- **Unified `add_transaction`**: Handles expenses, income, and payments in one tool
- **Auto-clear payments**: When adding a payment, automatically marks matching uncleared expenses as cleared
- **Category validation**: Unknown categories are coerced to "other"
- **Category caching**: Fetched from Notion with 5-minute TTL
- **LLM-agnostic design**: Agent layer can swap Gemini for any LLM
- **Batch operations**: Efficient bulk transaction and category updates

---

## Example Natural Language Inputs (Agent)

| Input                        | Inferred Action                  |
| ---------------------------- | -------------------------------- |
| "spent $12 on groceries"     | `add_transaction` (expense)      |
| "hunt paid 2500"             | `split_paycheck` (budget: hunt)  |
| "paid $300 to sapphire"      | `add_transaction` (payment)      |
| "what categories can I use?" | `get_categories`                 |
| "show me uncategorized"      | `get_uncategorized_transactions` |

---

## Development

```bash
# Type check
npx tsc --noEmit

# Run MCP server (hot reload)
npm run mcp

# Run Agent server (hot reload)
npm run agent
```

---

## License

MIT
