// Re-runnable evidence: a fixed set of rumours, each covering one rule, checked live on the Telegraph testnet.
// Writes receipts/evidence-<timestamp>.json (every purchase, signal hash, cost) and appends a row table to stdout.
// Usage: node --env-file=.env scripts/evidence.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { Telegraph } from "../src/telegraph.mjs";
import { Budget } from "../src/budget.mjs";
import { OfacList } from "../src/ofac.mjs";
import { runCheck } from "../src/check.mjs";

export const SCENARIOS = [
  { rule: "Two operators agree; a ship making way is not 'sinking'", text: "BREAKING: ferry VIKING GLORY hit by a drone and sinking in the Baltic" },
  { rule: "The ship is somewhere else entirely", text: "Houthis claim missile hit on container ship HULDA MAERSK in the Red Sea" },
  { rule: "'Went dark' while it is transmitting", text: "ferry VIKING GLORY went dark near the Aland Islands" },
  { rule: "Sanctioned tanker, no tracking coverage", text: "Sanctioned tanker ADRIAN DARYA 1 seized by IRGC in the Strait of Hormuz" },
  { rule: "Sanctioned by EU/UK but not on OFAC's list", text: "Shadow fleet tanker EAGLE S went dark in the Gulf of Finland, IMO 9329760" },
  { rule: "No ship named: only the claim is checked", text: "Iran closed the Strait of Hormuz to all shipping today" },
];

const budget = new Budget({ file: "data/spend.json", dailyCapUsd: Number(process.env.KEEL_DAILY_CAP_USD || 2) });
const telegraph = new Telegraph({ privateKey: process.env.TELEGRAPH_PRIVATE_KEY });
const ofac = new OfacList({ file: "data/sdn.csv" });
await ofac.load();

const runs = [];
for (const s of SCENARIOS) {
  const c = await runCheck(s.text, { telegraph, budget, ofac });
  runs.push({ ...s, check: c });
  const r = c.result;
  console.log(`| ${s.rule} | ${r.verdict.icon} ${r.verdict.key} | ${r.confidence} | ${r.sanctions} | ${c.purchases.filter((p) => p.ok).length}/${c.purchases.length} | $${c.totalUsd.toFixed(2)} |`);
}
mkdirSync("receipts", { recursive: true });
const file = `receipts/evidence-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify({ payer: telegraph.account.address, node: telegraph.node, ranAt: new Date().toISOString(), runs }, null, 2));
console.log("\nsaved", file, "· total", `$${runs.reduce((s, r) => s + r.check.totalUsd, 0).toFixed(2)}`);
