# Jarvis — Personal Finance MCP Server + Agent

A Model Context Protocol (MCP) server for personal finance tracking, backed by Notion databases. Includes an LLM-powered agent (Gemini) that parses natural language into structured tool calls.

> **Important:** This project is tightly coupled to a specific Notion workspace:  
> **[Jarvis Notion Site](https://memoo0.notion.site/jarv-template-2e54abe19ef5802fb3fcce0017006fc1)**
>
> The database schemas, relations, and formulas are configured within Notion itself. To use this project, duplicate the Notion template to proceed.

---

## Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│                           USER INPUT                              │
│              "spent $12 on groceries at Trader Joes"              │
└───────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌───────────────────────────────────────────────────────────────────┐
│                      AGENT SERVER (port 4000)                     │
│                         POST /chat                                │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  Gemini Client (gemini_client.ts) or LLM Provider           │  │
│  │  - Parses natural language → structured action              │  │
│  │  - Infers: action type, amount, category, account, etc.     │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                              │                                    │
│                              ▼                                    │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  MCP Client (mcp_client.ts)                                 │  │
│  │  - Calls MCP tools via JSON-RPC                             │  │
│  └─────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌───────────────────────────────────────────────────────────────────┐
│                       MCP SERVER (port 3000)                      │
│                         POST /mcp                                 │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  Registered Tools (server.ts)                               │  │
│  │  - add_transaction         - get_categories                 │  │
│  │  - add_transactions_batch  - get_uncategorized_transactions │  │
│  │  - set_budget_rule         - update_transaction_category    │  │
│  │  - split_paycheck     - update_transaction_categories_batch │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                              │                                    │
│                              ▼                                    │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  Services Layer                                             │  │
│  │  - transactions.ts  (add_transaction, batch)                │  │
│  │  - payments.ts      (create_payment, auto-clear expenses)   │  │
│  │  - categories.ts    (get/update uncategorized)              │  │
│  │  - budgets.ts       (set_budget_rule, split_paycheck)       │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                              │                                    │
│                              ▼                                    │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  Notion Layer (notion/client.ts, notion/utils.ts)           │  │
│  │  - API client + DB IDs                                      │  │
│  │  - Category caching + validation                            │  │
│  │  - Account/budget rule lookups                              │  │
│  └─────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌───────────────────────────────────────────────────────────────────┐
│                         NOTION DATABASES                          │
│  - Expenses DB       - Income DB        - Payments DB            │
│  - Accounts DB       - Categories DB    - Budget Rules DB        │
└───────────────────────────────────────────────────────────────────┘
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
│   │   │   ├── types.ts            # Typed wrappers for dataSources API
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
│           ├── gemini_client.ts    # Gemini prompt + action parser
│           └── claude_prompt.md    # Claude system prompt reference
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

| Database         | Required Properties                                                                                                                                                                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Expenses**     | `title`, `amount` (number), `date` (date), `accounts` (relation→Accounts), `categories` (relation→Categories), `funding_account` (relation→Accounts), `cleared` (checkbox), `cleared_by` (relation→Payments), `paid_amount` (number), `note` (rich_text)                                                    |
| **Income**       | `title`, `amount` (number), `date` (date), `accounts` (relation→Accounts), `categories` (relation→Categories), `pre_breakdown` (number), `budget` (relation→Budget Rules), `note` (rich_text)                                                                                                               |
| **Payments**     | `title`, `amount` (number), `date` (date), `from_account` (relation→Accounts), `to_account` (relation→Accounts), `cleared_expenses` (relation→Expenses), `note` (rich_text)                                                                                                                                 |
| **Accounts**     | `title`, `account_type` (select: credit/checkings/savings/investment), `starting_balance` (number), `ledger_balance` (formula), `reserved_for_cc` (rollup), `available_to_spend` (formula), `total_income` (rollup), `total_expenses` (rollup), `total_payments_in` (rollup), `total_payments_out` (rollup) |
| **Categories**   | `title` (category name: groceries, out, lyft, etc.)                                                                                                                                                                                                                                                         |
| **Budget Rules** | `title` (rule name), `account` (relation→Accounts), `percentage` (number 0-1)                                                                                                                                                                                                                               |

### 3. Environment Variables

Copy `env.example` to `.env` and fill in:

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

## Balance Model

Account balances are computed with **account-level math** via Notion formulas, not by summing individual expense statuses.

### `ledger_balance` formula

```
if(account_type == "credit",
  total_expenses - total_payments_in,
  starting_balance + total_income - total_payments_out - total_expenses
)
```

- **Credit cards**: Outstanding = charges minus payments received. A payment immediately reduces the balance by its full amount, regardless of whether individual expenses are cleared.
- **Debit/savings accounts**: Balance = starting balance + income - payments out - direct expenses.

### `reserved_for_cc` (rollup)

Sums `owed_amount` from credit card expenses where `funding_account` = this account. Shows funding accounts (e.g., checkings) how much is earmarked for unpaid credit card expenses.

### `available_to_spend` (formula)

```
ledger_balance - reserved_for_cc
```

### Expense clearing (reconciliation)

When a payment is created via the API, `payments.ts` auto-clears matching expenses (oldest first). This sets `paid_amount` on each expense, which reduces `owed_amount` (formula: `amount - paid_amount`), which in turn reduces `reserved_for_cc` on the funding account. Clearing is **required for funding account accuracy** but does **not** affect the credit card's `ledger_balance`.

---

## Key Features

- **Unified `add_transaction`**: Handles expenses, income, and payments in one tool
- **Account-level balances**: Credit card outstanding computed from total expenses minus total payments, not from individual expense clearing
- **Auto-clear payments**: When adding a payment, automatically marks matching uncleared expenses as cleared (updates funding account reserves)
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
npm run typecheck

# Run MCP server (hot reload)
npm run mcp

# Run Agent server (hot reload)
npm run agent
```

---

## License

MIT
