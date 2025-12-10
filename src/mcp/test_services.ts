import { add_transaction } from "./services/transactions";
import { set_budget_rule, split_paycheck } from "./services/budgets";

async function main() {
  // const result = await add_transaction({
  //   amount: 4,
  //   transaction_type: "expense",
  //   account: "checkings",
  //   category: "food",
  //   // date: "2025-12-04" // optional; if omitted, uses today
  // });

  // const result = await set_budget_rule({
  //   rule_name: "msft",
  //   budgets: [
  //     { account: "checkings", percentage: 0.1 },
  //     { account: "spaxx", percentage: 0.7 },
  //     { account: "short term savings", percentage: 0.1 },
  //     { account: "roth ira", percentage: 0.05 },
  //     { account: "brokerage", percentage: 0.05 },
  //   ],
  // });

  const result = await split_paycheck({
    gross_amount: 3000,
    rule_name: "msft",
    // date: "2025-12-04" // optional; if omitted, uses today
  });
  console.log(result);
}

main().catch((err) => {
  console.error("Unhandled error in testAddTransaction:", err);
});
