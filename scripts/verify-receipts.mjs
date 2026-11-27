// Keyless re-read of every receipt in receipts/: each signal must exist on the node, name the payer wallet,
// carry the intent that was bought, and pass the node's keccak256 commitment check.
// Usage: node scripts/verify-receipts.mjs [receipts-dir]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] || "receipts";
const NODE = process.env.TELEGRAPH_URL || "https://devnode.telegraphprotocol.com";
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
const rows = [];
for (const f of files) {
  const doc = JSON.parse(readFileSync(join(dir, f), "utf8"));
  const checks = doc.runs ? doc.runs.map((r) => r.check) : [doc];
  for (const c of checks) for (const p of c.purchases || []) if (p.signal) rows.push({ file: f, payer: String(doc.payer || "").toLowerCase(), p });
}

let ok = 0, missing = 0, mismatch = 0, spent = 0;
for (const { file, payer, p } of rows) {
  let j = null;
  try {
    const r = await fetch(`${NODE}/engine/v1/signal/${p.signal}`, { signal: AbortSignal.timeout(20_000) });
    if (r.ok) j = await r.json();
  } catch {}
  if (!j) { missing++; console.log(`✗ ${p.signal.slice(0, 12)}… not found (${file})`); continue; }
  const wallet = String(j.signal?.wallet_address || "").toLowerCase();
  const intent = j.signal?.intent_id;
  const good = wallet === payer && intent === p.intent && j.verification?.verified === true;
  if (good) { ok++; spent += p.costUsd || 0; }
  else { mismatch++; console.log(`✗ ${p.signal.slice(0, 12)}… wallet ${wallet === payer ? "ok" : wallet} intent ${intent} verified ${j.verification?.verified}`); }
}
console.log(`signals ${rows.length} · verified ${ok} · not found ${missing} · mismatched ${mismatch} · paid by ${rows[0]?.payer || "-"} · $${spent.toFixed(2)} test USDC across ${files.length} file(s)`);
process.exit(missing || mismatch ? 1 : 0);
