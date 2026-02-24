// src/mcp/services/balances.ts
// Balance lookup — reads the ledger_balance property from an account page.

import { ACCOUNTS_DB_ID } from "../notion/client";
import { query_data_source_by_title } from "../notion/utils";
import { get_formula_number_prop, get_number_prop } from "../notion/types";
import type { account_type } from "../constants";

interface balance_result {
  success: boolean;
  account: string;
  balance?: number;
  error?: string;
}

/**
 * Returns the ledger_balance for a given account.
 */
export async function check_balance(account: account_type): Promise<balance_result> {
  try {
    const results = await query_data_source_by_title(ACCOUNTS_DB_ID, account, 1);
    const page = results[0];

    if (!page) {
      return { success: false, account, error: `Account "${account}" not found.` };
    }

    // Try formula first, fall back to plain number
    let balance = get_formula_number_prop(page.properties, "ledger_balance");
    if (balance === null) {
      balance = get_number_prop(page.properties, "ledger_balance");
    }

    if (balance === null) {
      return { success: false, account, error: `No ledger_balance property found for "${account}".` };
    }

    return {
      success: true,
      account,
      balance: Math.round(balance * 100) / 100,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, account, error: msg };
  }
}
