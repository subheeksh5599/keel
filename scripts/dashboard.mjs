// Builds docs/index.html: a static receipts dashboard from every file in receipts/ (served by GitHub Pages).
// Every row links to its public signal on the Telegraph node, so the page proves nothing by itself; the node does.
// Usage: node scripts/dashboard.mjs
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
const all = walk("receipts");
const files = all.filter((f) => f.endsWith(".json")).sort();
const checks = [];
let payer = "";
for (const f of files) {
  const doc = JSON.parse(readFileSync(f, "utf8"));
  payer ||= doc.payer || "";
  for (const r of doc.runs || [{ rule: r0(doc), check: doc }]) checks.push({ file: f.replace(/^receipts\//, ""), rule: r.rule, c: r.check });
}
function r0(doc) { return doc.source === "telegram" ? "Asked through Telegram" : doc.expected ? `Pre-registered: expected ${doc.expected}` : null; }
checks.sort((a, b) => String(b.c.checkedAt).localeCompare(String(a.c.checkedAt)));
const watchPolls = all.filter((f) => f.endsWith(".jsonl")).flatMap((f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const purchases = [...checks.flatMap(({ c }) => c.purchases || []), ...watchPolls.flatMap((w) => w.purchases || [])];
const watchRows = watchPolls.slice(-40).reverse().map((w) => `<li>${esc(w.at.slice(0, 16).replace("T", " "))} · <b>${esc(w.ship)}</b> · ${w.fix ? `${w.fix.lat.toFixed(3)}, ${w.fix.lon.toFixed(3)}` : "no position"} · ${(w.purchases || []).map((p) => p.signalUrl ? `<a href="${esc(p.signalUrl)}">signal</a>` : "").join(" ")}${w.alerts?.length ? ` · <span class="flag">${esc(w.alerts.join(" / "))}</span>` : ""}</li>`).join("");
const paid = purchases.reduce((s, p) => s + (p.costUsd || 0), 0);
const withData = purchases.filter((p) => p.ok).length;
const miners = [...new Set(purchases.map((p) => p.miner).filter(Boolean))];

const rows = checks.map(({ file, rule, c }) => {
  const r = c.result || {};
  const buys = (c.purchases || []).map((p) => `<li class="${p.ok ? "ok" : "no"}">${p.ok ? "✓" : "✗"} ${esc(p.label)} · ${esc(p.miner || "")} · $${(p.costUsd || 0).toFixed(2)}${p.latencyMs ? ` · ${(p.latencyMs / 1000).toFixed(1)} s` : ""}${p.signalUrl ? ` · <a href="${esc(p.signalUrl)}">signal</a>` : ""}${!p.ok && p.error ? ` <span class="why">${esc(p.error)}</span>` : ""}</li>`).join("");
  return `<article>
  <header><span class="v">${esc(r.verdict?.icon)} ${esc(r.verdict?.label || r.verdict?.key)}</span><span class="conf">${esc(r.confidence)}/100</span></header>
  <p class="rumour">“${esc(c.extracted?.text || "")}”</p>
  ${rule ? `<p class="rule">Rule exercised: ${esc(rule)}</p>` : ""}
  <ul class="reasons">${(r.reasons || []).map((x) => `<li>${x.sign > 0 ? "＋" : x.sign < 0 ? "－" : "·"} ${esc(x.text)}</li>`).join("")}${(r.flags || []).map((f) => `<li class="flag">${esc(f)}</li>`).join("")}</ul>
  <ul class="buys">${buys}</ul>
  <footer>${esc(c.checkedAt)} · $${(c.totalUsd || 0).toFixed(2)} test USDC${c.elapsedMs ? ` · ${Math.round(c.elapsedMs / 1000)} s` : ""} · <a href="https://github.com/subheeksh5599/keel/blob/main/receipts/${esc(file)}">${esc(file)}</a></footer>
</article>`;
}).join("\n");

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Keel · receipts</title>
<style>
:root{--bg:#0d1117;--fg:#e6edf3;--mut:#8b949e;--line:#30363d;--acc:#4cc2ff;--ok:#3fb950;--no:#f85149}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
h2{font-size:16px;margin:28px 0 12px;color:var(--mut);text-transform:uppercase;letter-spacing:.08em}main{max-width:920px;margin:0 auto;padding:40px 20px}h1{font-size:28px;margin:0 0 4px;letter-spacing:.04em}
.sub{color:var(--mut);margin:0 0 28px}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:32px}
.stats div{border:1px solid var(--line);border-radius:8px;padding:14px}.stats b{display:block;font-size:22px}.stats span{color:var(--mut);font-size:13px}
article{border:1px solid var(--line);border-radius:8px;padding:18px;margin-bottom:16px}
article header{display:flex;justify-content:space-between;font-weight:600}.conf{color:var(--acc)}
.rumour{font-style:italic;margin:8px 0}.rule{color:var(--mut);font-size:13px;margin:0 0 8px}
ul{margin:8px 0;padding-left:0;list-style:none}.reasons li{margin:2px 0}.flag{color:#d29922}
.buys{border-top:1px solid var(--line);padding-top:8px;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.buys .ok{color:var(--fg)}.buys .no{color:var(--mut)}.why{color:var(--no)}a{color:var(--acc)}
footer{color:var(--mut);font-size:12px}
</style></head><body><main>
<h1>KEEL</h1>
<p class="sub">Every check below was paid on the Telegraph testnet from escrow wallet <code>${esc(payer)}</code>. Each signal link opens the node's own record of the ask. Re-check them all with <code>node scripts/verify-receipts.mjs</code>. Bot: <a href="https://t.me/keel567_bot">@keel567_bot</a> · <a href="https://github.com/subheeksh5599/keel">source</a></p>
<section class="stats">
<div><b>${checks.length}</b><span>rumours checked</span></div>
<div><b>${purchases.length}</b><span>answers bought</span></div>
<div><b>${withData}</b><span>with data</span></div>
<div><b>$${paid.toFixed(2)}</b><span>test USDC paid</span></div>
<div><b>${miners.length}</b><span>miners used</span></div>
<div><b>${watchPolls.length}</b><span>watch polls</span></div>
</section>
${watchRows ? `<h2>Watch log</h2><ul class="buys">${watchRows}</ul>` : ""}
<h2>Checks</h2>
${rows}
</main></body></html>`;
mkdirSync("docs", { recursive: true });
writeFileSync("docs/index.html", html);
console.log(`docs/index.html · ${checks.length} checks · ${purchases.length} answers · $${paid.toFixed(2)}`);
