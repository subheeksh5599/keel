// Run one full check from the command line (no Telegram) and save the evidence to receipts/.
// Usage: node --env-file=.env scripts/check.mjs "tanker VIKING GLORY sinking in the Baltic"
import { mkdirSync, writeFileSync } from "node:fs";
import { Telegraph } from "../src/telegraph.mjs";
import { Budget } from "../src/budget.mjs";
import { OfacList } from "../src/ofac.mjs";
import { runCheck } from "../src/check.mjs";
import { formatCheck } from "../src/format.mjs";

const text = process.argv.slice(2).join(" ");
if (!text) { console.error('usage: scripts/check.mjs "<rumour text>"'); process.exit(1); }
const budget = new Budget({ file: "data/spend.json", dailyCapUsd: Number(process.env.KEEL_DAILY_CAP_USD || 2) });
const telegraph = new Telegraph({ privateKey: process.env.TELEGRAPH_PRIVATE_KEY });
const ofac = new OfacList({ file: "data/sdn.csv" });
await ofac.load();
const c = await runCheck(text, { telegraph, budget, ofac, maxCheckUsd: Number(process.env.KEEL_MAX_CHECK_USD || 0.3) });
console.log(formatCheck(c, { budgetLeftUsd: budget.remainingUsd() }).replace(/<[^>]+>/g, ""));
mkdirSync("receipts", { recursive: true });
const file = `receipts/check-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify({ input: text, payer: telegraph.account.address, ...c }, null, 2));
console.log("\nsaved", file);
