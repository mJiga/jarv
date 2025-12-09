import { add_transaction } from "./services/transactions";

async function main() {
  const result = await add_transaction({
    amount: 4,
    transaction_type: "income",
    account: "freedom unlimited",
    category: "food",
    // date: "2025-12-04" // optional; if omitted, uses today
  });

  console.log(result);
}

main().catch((err) => {
  console.error("Unhandled error in testAddTransaction:", err);
});
