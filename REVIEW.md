# Jarvis Repository — Comprehensive Code Review

## Executive Summary

**Project:** Personal finance MCP server + LLM agent backed by Notion databases.
**Language:** TypeScript (~2,300 LOC across 11 source files).
**Overall Health:** Functional and well-structured for a personal tool, with clear separation of concerns and thoughtful domain modeling. However, it has meaningful gaps in testing, security, type safety, and performance that would need to be addressed before any multi-user or production deployment.

### Strengths
- Clean two-layer architecture (Agent / MCP) with clear boundaries
- Good domain modeling: transactions, payments, budgets, categories map well to the finance domain
- Thoughtful features like duplicate detection, auto-clearing payments, and category fallback lists
- Consistent coding style and naming conventions throughout
- Effective use of `as const` arrays with derived types for account enums
- Sensible defaults (sapphire for expenses, checkings for income)
- Solid README with architecture diagrams and table-based documentation

### Weaknesses
- Zero test coverage — no test files, no test framework, no test script
- Pervasive `any` casts undermine the strict TypeScript config
- No authentication or authorization on any endpoint
- Duplicate type definitions across agent and MCP layers
- Sequential processing for all batch operations
- No caching for frequently repeated Notion lookups (accounts, data source IDs)
- Several correctness edge cases in payment clearing and budget rules

---

## Architecture & Structure

### Overall Design

The repository implements two Express servers:

1. **MCP Server (port 3000):** Exposes 8 finance tools via JSON-RPC using the Model Context Protocol SDK. This is the core API layer.
2. **Agent Server (port 4000):** A natural language front-end that uses Google Gemini to parse user messages into structured MCP tool calls.

Data flows: `User -> Agent -> Gemini LLM -> MCP Client -> MCP Server -> Services -> Notion API -> Notion Databases`

The MCP server can also be used standalone by LLM clients (Claude, ChatGPT) that support MCP natively, making the agent layer optional.

### Folder Structure Assessment

```
src/
  mcp/                    # Well-scoped: MCP server + business logic
    server.ts             # Tool registration + HTTP transport
    constants.ts          # Account/type definitions
    notion/
      client.ts           # Notion client init + DB ID exports
      utils.ts            # Query helpers, caching, dedup — does too much
    services/
      transactions.ts     # Core transaction logic
      payments.ts         # Payment + auto-clearing
      categories.ts       # Category CRUD
      budgets.ts          # Budget rules + paycheck splitting
  agent/                  # Well-scoped: LLM parsing + MCP client
    agent_server.ts       # Express /chat endpoint
    mcp_client.ts         # JSON-RPC client
    llm/
      gemini_client.ts    # Prompt + response parsing
```

**Verdict:** Structure is clean and responsibilities are well-scoped at the folder level. `notion/utils.ts` is the one file that takes on too many concerns (caching, querying, deduplication, validation, type definitions).

---

## Code Quality Issues

### 1. Pervasive `any` Casts (High Impact)

Despite `strict: true` in tsconfig, the codebase heavily relies on `any`:

- **`notion/utils.ts:56,126,160`** — `(notion as any).dataSources.query(...)` cast on every single Notion query. The Notion SDK apparently doesn't type the `dataSources` API, but these casts suppress all type checking on query parameters and responses.
- **`server.ts:104,204`** — `const structured: any = {...}` and `(e: any)` in map callbacks.
- **`transactions.ts:211,276`** — `const properties: any = {...}` for building Notion page properties.
- **`payments.ts:159,214`** — Same pattern in payment property construction.
- **`budgets.ts:173`** — `const props: any = page.properties` on every budget rule page.
- **`gemini_client.ts:248-306`** — Extensive `(t: any)` and `(u: any)` in validation loops.

This means the strict TypeScript config provides a false sense of safety. The actual runtime type coverage is significantly lower than the config implies.

### 2. Duplicate Type Definitions (Medium Impact)

Account types are defined in three places:

- **`src/mcp/constants.ts`** — Canonical source using `as const` arrays with derived types.
- **`src/agent/mcp_client.ts:14-34`** — Hardcoded string literal union types that duplicate the constants. Example: `account?: "checkings" | "short term savings" | "bills" | ...` instead of importing `account_type`.
- **`src/agent/llm/gemini_client.ts:30-87`** — Another set of typed action definitions.

If an account is added or renamed, `mcp_client.ts` must be manually updated separately. The agent layer imports from `constants.ts` for the prompt (good) but duplicates types locally for its interfaces (bad).

### 3. `validate_category` Uses Stale or Uninitialized Cache (Medium Impact)

**`notion/utils.ts:88-92`:**
```typescript
export function validate_category(category: string): string {
  const available: readonly string[] = cached_categories ?? FALLBACK_CATEGORIES;
  return available.includes(normalized) ? normalized : "other";
}
```

This is synchronous and uses whatever happens to be in `cached_categories`. If `get_available_categories()` has never been called, it falls back to the hardcoded list. If the cache is stale (beyond TTL), this function won't refresh it — it just uses the old data. The function should either be async or the caller should ensure the cache is warm.

### 4. `build_title` Missing Payment Case (Low Impact)

**`transactions.ts:63-77`:** The function handles `expense` and `income` but has no `payment` branch. Payments are routed to `create_payment()` before `build_title` is called, so this is currently dead-safe, but the function's contract is misleading — it accepts `add_transaction_input` which includes payments.

### 5. Non-Atomic Budget Rule Updates (Medium Impact)

**`budgets.ts:78-96`:**
```typescript
// Archive existing rules
for (const page of existing) {
  await notion.pages.update({ page_id: page.id, archived: true });
}
// Create new rules
for (const b of budgets) {
  await notion.pages.create({...});
}
```

If creation fails midway (e.g., after archiving old rules and creating 2 of 4 new ones), the budget rule is left in an inconsistent state — some old rules archived, some new ones created. There's no rollback mechanism.

### 6. Double Account Lookup in `set_budget_rule` (Low Impact)

**`budgets.ts:67-86`:** Accounts are looked up once for validation (`find_account_page_by_title` in lines 68-75) and then again during creation (line 85). Each lookup hits the Notion API. The IDs from validation should be cached for reuse.

### 7. The `categories` vs `category` Property Fallback (Medium Impact)

**`transactions.ts:289-303`:**
```typescript
try {
  response = await try_create("categories");
} catch {
  response = await try_create("category");
}
```

This silently catches ALL errors (not just property-name mismatches) and retries with a different property name. If the first call fails due to a network error, rate limit, or invalid data, the second call will also fail — but the original error is swallowed. The catch block should at least check the error type.

### 8. `package.json` `main` Field Points to Nonexistent File

**`package.json:3`:** `"main": "index.js"` — No `index.js` or `index.ts` exists. Should be `"main": "dist/mcp/server.js"`.

---

## Risks & Technical Debt

### Security

1. **No authentication on any endpoint.** Both servers accept unauthenticated requests. Anyone with network access can create transactions, modify categories, or trigger payments. For a locally-run personal tool this may be acceptable, but the Render deployment config suggests it's intended to be internet-facing.

2. **Error details leaked to clients.** `agent_server.ts:101` returns `err?.message` in the 500 response body. In `server.ts:402`, the MCP error handler returns a generic message (good), but many service functions return raw error messages from Notion API calls.

3. **Credit card last-4 digits in LLM prompts.** `gemini_client.ts:105-107` embeds `SAPPHIRE_LAST4` and `FREEDOM_LAST4` directly into the prompt sent to Google's Gemini API. This is low-sensitivity data, but it's worth noting that card identifiers are sent to a third party on every request.

4. **No rate limiting.** Neither server implements rate limiting. The agent server sends unbounded requests to Gemini and MCP on each `/chat` call.

5. **No input size limits.** The `express.json()` middleware accepts arbitrarily large payloads on both servers.

### Reliability

6. **Single transport instance shared across requests.** `server.ts:388-392` creates one `StreamableHTTPServerTransport` and reuses it for all requests. The MCP SDK documentation should be checked to confirm this is safe for concurrent requests — transport state leakage between requests would cause subtle bugs.

7. **No graceful shutdown.** Neither server handles `SIGTERM`/`SIGINT`. Active Notion API calls will be interrupted ungracefully during deployment restarts.

8. **`dotenv/config` imported in multiple files.** Both `agent_server.ts` and `notion/client.ts` import `dotenv/config`, and `gemini_client.ts` also imports it. This is harmless (subsequent imports are no-ops) but indicates unclear initialization ownership.

### Maintainability

9. **Hard-coded employer names in LLM prompt.** `gemini_client.ts:145`: `Known budget names: "hunt", "msft", "default"`. This couples the LLM prompt to specific budget rules. Adding a new employer requires a code change + deploy rather than being data-driven.

10. **No logging framework.** All logging uses raw `console.log`/`console.error` with inconsistent prefix conventions (`[MCP]`, `[Agent]`, `[Gemini]`, `[dedup]`, `[payments]`). No log levels, no structured logging.

---

## Performance Concerns

### 1. Data Source ID Fetched on Every Query (High Impact)

**`notion/utils.ts:102-113`:** `get_data_source_id_for_database()` calls `notion.databases.retrieve()` on every single query to get the data source ID. This ID is stable — it doesn't change between requests. Every transaction, category lookup, account lookup, and dedup check pays this extra round-trip.

A single `add_transaction` call triggers approximately:
- 1 call for account lookup data source ID
- 1 call for account query
- 1 call for category lookup data source ID
- 1 call for category query
- 1 call for dedup data source ID
- 1 call for dedup query
- 1 call for the actual page creation

That's ~7 API calls where ~4 of the data source ID calls could be eliminated with caching.

### 2. No Account Page ID Caching (Medium Impact)

Account page IDs are looked up by title on every transaction. There are only 8 accounts and they change rarely. Caching `title -> page_id` with a TTL (like categories) would eliminate 1-2 Notion API calls per transaction.

### 3. Sequential Batch Processing (Medium Impact)

**`transactions.ts:352`** and **`categories.ts:176`:** All batch operations process items sequentially with `for...of` and `await`. For independent operations (each transaction is independent), `Promise.allSettled()` with a concurrency limiter would be significantly faster, especially for large batches.

### 4. Uncleared Expenses Query Has No Pagination (Low Impact)

**`payments.ts:188-204`:** The query for uncleared expenses uses `page_size: 100` (the default in `query_data_source_with_filter`). If a credit card accumulates more than 100 uncleared expenses, the payment clearing will miss some. For a personal finance tool this is unlikely but worth noting.

### 5. `split_paycheck` Resolves Account Titles via Extra API Call (Low Impact)

**`budgets.ts:180-183`:** For each budget allocation, the code calls `notion.pages.retrieve()` to get the account title from the relation, then passes that title to `add_transaction` which looks up the account page ID again. The relation already contains the ID.

---

## Testing Gaps

**There are zero tests.** No test framework is installed, no test script exists, no test files exist.

### Critical Paths That Need Testing

1. **Payment auto-clearing logic** (`payments.ts`): The oldest-first FIFO clearing, partial payment handling, and expense-to-payment linking is the most complex business logic. Bugs here mean incorrect financial records.

2. **Duplicate detection** (`utils.ts`): The 5-minute window logic, date matching, and "fail open" behavior need edge case coverage (same amount different accounts, boundary of time window, concurrent duplicate checks).

3. **Budget rule validation** (`budgets.ts`): The percentage-sum-to-1.0 check with floating point tolerance, archive-then-create flow, and split_paycheck calculation accuracy.

4. **LLM action parsing** (`gemini_client.ts`): The `infer_action` validation logic can be unit tested independently of the LLM by testing `extract_json` and the validation branches with known JSON inputs.

5. **Category validation** (`utils.ts`): The sync/async mismatch and cache behavior under various states (empty, populated, stale, errored).

### Suggested Test Infrastructure

- Add `vitest` or `jest` as dev dependency
- Create `src/__tests__/` or co-located `.test.ts` files
- Mock the Notion client for service tests
- Test `gemini_client.ts` validation without actual LLM calls

---

## Refactoring Roadmap

### Priority 1: High-Impact / Low-Effort

| Item | What | Why |
|------|------|-----|
| **Cache data source IDs** | Add a `Map<string, string>` cache in `utils.ts` for `get_data_source_id_for_database()` | Eliminates ~4 unnecessary Notion API calls per transaction. 5 minutes of work. |
| **Cache account page IDs** | Add TTL cache for `find_account_page_by_title()` | Eliminates 1-2 API calls per transaction. Accounts rarely change. |
| **Fix `package.json` main** | Change `"main": "index.js"` to `"main": "dist/mcp/server.js"` | Currently points to nonexistent file. |
| **Import types from constants in `mcp_client.ts`** | Replace hardcoded string unions with imported types | Eliminates duplicate type definitions; prevents drift. |
| **Narrow the `categories`/`category` catch** | Check error type before retrying with alternate property name | Currently swallows network errors, rate limits, and other non-schema issues. |

### Priority 2: Structural Refactors

| Item | What | Why |
|------|------|-----|
| **Split `notion/utils.ts`** | Extract dedup logic into `notion/dedup.ts`, types into `types.ts`, and validation into existing `constants.ts` or a `validation.ts` | `utils.ts` is a 334-line grab-bag of unrelated concerns: caching, querying, deduplication, validation, and type definitions. |
| **Add test infrastructure** | Install vitest/jest, create tests for payment clearing, budget splitting, and category validation | Zero test coverage on financial logic is the biggest risk in the codebase. |
| **Add authentication middleware** | At minimum, a shared secret / API key check on both servers | Required before any non-localhost deployment. |
| **Replace `any` casts with proper types** | Define Notion response types or use `unknown` with type narrowing | The strict tsconfig is currently theater — `any` bypasses all checks. Consider creating a `notion/types.ts` with interfaces for page properties. |
| **Make budget rule updates atomic** | Create all new rules first, then archive old ones only on full success | Prevents inconsistent state on partial failure. |

### Priority 3: Optional Enhancements

| Item | What | Why |
|------|------|-----|
| **Parallel batch processing** | Use `Promise.allSettled()` with concurrency limit for batch operations | Significant speedup for large batches. Not critical for typical 1-5 item batches. |
| **Structured logging** | Replace `console.log/error` with pino or winston, add consistent log levels | Helps debugging in production (Render). Not critical for personal use. |
| **Make budget names data-driven** | Fetch known budget names from Notion instead of hardcoding in LLM prompt | Avoids code changes when adding employers. Low priority if employer list is stable. |
| **Add request body size limits** | `app.use(express.json({ limit: '100kb' }))` | Defense-in-depth. Low risk for personal tool. |
| **Graceful shutdown** | Handle SIGTERM, drain active requests | Prevents interrupted Notion writes during deployment restarts. |

---

## Summary of Key Metrics

| Metric | Value |
|--------|-------|
| Source files | 11 |
| Lines of code | ~2,300 |
| Test files | 0 |
| Test coverage | 0% |
| `any` type usage | ~30+ occurrences |
| Notion API calls per transaction | ~7 (could be ~3 with caching) |
| Authentication | None |
| Logging framework | None (raw console) |
| Error handling pattern | Consistent try/catch with result objects |
| Input validation | Zod at MCP layer + manual checks in services (redundant) |

---

*Review generated 2026-02-04*
