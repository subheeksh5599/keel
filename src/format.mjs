// Telegram replies (parse_mode HTML). Kept under Telegram's 4096-character limit.
import { fmtCoord } from "./geo.mjs";
import { fmtAge } from "./assess.mjs";
import { claimLabel } from "./extract.mjs";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const usd = (n) => `$${Number(n || 0).toFixed(2)}`;

export function formatCheck(c, { budgetLeftUsd } = {}) {
  if (c.kind === "nothing") return formatNothing();
  const r = c.result;
  const lines = [];
  lines.push(`${r.verdict.icon} <b>${esc(r.verdict.label)}</b>`);
  if (c.shipQuery) {
    const claimed = c.extracted.claims.length ? ` · rumour: ${esc(c.extracted.claims.map(claimLabel).join(", "))}` : "";
    const id = c.identity || {};
    const ids = [id.imo ? `IMO ${id.imo}` : null, id.mmsi ? `MMSI ${id.mmsi}` : null].filter(Boolean).join(" · ");
    lines.push(`🚢 <b>${esc(c.shipName || id.name || c.shipQuery)}</b>${ids ? ` (${esc(ids)})` : ""}${claimed}`);
  } else {
    lines.push(`📰 No ship named. I checked the claim itself.`);
  }
  if (r.best) {
    const b = r.best;
    const motion = b.speed == null ? "speed unknown" : b.speed < 1 ? "stopped" : `${b.speed} kn${b.course != null ? `, course ${Math.round(b.course)}°` : ""}`;
    lines.push(`📍 ${esc(fmtCoord(b))}${b.region ? ` · ${esc(b.region)}` : ""} · ${esc(motion)}${b.navStatus ? ` · "${esc(b.navStatus)}"` : ""} · ${esc(fmtAge(r.ageMin))} ago${b.destination ? ` · bound for ${esc(b.destination)}` : ""}`);
  }
  for (const f of r.flags) lines.push(`${f.startsWith("🚩") ? "" : "⚠️ "}${esc(f)}`);

  lines.push("");
  lines.push(`<b>Confidence ${r.confidence}/100</b>`);
  for (const x of r.reasons.slice(0, 6)) lines.push(`${x.sign > 0 ? "＋" : x.sign < 0 ? "－" : "·"} ${esc(x.text)}`);

  lines.push("");
  lines.push(`<b>Checks bought on Telegraph</b> (${usd(c.totalUsd)} test USDC)`);
  c.purchases.forEach((p, i) => {
    const status = p.ok ? "✓" : "✗";
    const what = p.ok ? summarize(p) : esc(shortErr(p.error));
    const receipt = p.signalUrl ? ` <a href="${esc(p.signalUrl)}">receipt ${i + 1}</a>` : "";
    lines.push(`${status} ${esc(p.label)}: ${what} · ${esc(p.miner || "—")} · ${usd(p.costUsd)}${receipt}`);
  });
  const ofac = c.evidence?.sanctions?.ofac;
  if (ofac?.checked) lines.push(`${ofac.matches.length ? "🚩" : "✓"} OFAC SDN list (read directly from treasury.gov, free): ${ofac.matches.length ? esc(ofac.matches.map((m) => `${m.name}${m.imo ? ` IMO ${m.imo}` : ""}, ${m.program}`).join("; ")) : "no listing"}`);
  if (budgetLeftUsd != null) lines.push(`<i>Daily budget left: ${usd(budgetLeftUsd)} · Testnet, test USDC</i>`);
  return clip(lines.join("\n"));
}

function summarize(p) {
  const a = p.answer || {};
  switch (p.intent) {
    case "VESSEL_TELEMETRY_VERIFY_GENERAL":
      return a.latitude != null ? esc(`${Number(a.latitude).toFixed(3)}, ${Number(a.longitude).toFixed(3)}${a.speed_knots != null ? `, ${a.speed_knots} kn` : ""}`) : "no position";
    case "SANCTIONS_SCREENING_MATCH_GENERAL":
      return a.matched === true || a.matched === "true" ? "<b>listed</b>" : "no match";
    case "FACT_CHECK_GENERAL":
      return esc(a.verdict || "no verdict");
    case "MEDIA_FORENSIC_VERIFY_GENERAL":
      return esc(a.verdict || "no verdict");
    default:
      return "answered";
  }
}

function shortErr(e) {
  const s = String(e || "failed");
  if (/insufficient_coverage/.test(s)) return "no coverage there";
  if (/no data|no position|null/i.test(s)) return "no data";
  if (/timed out/i.test(s)) return "timed out";
  if (/cap/i.test(s)) return s;
  return s.replace(/upstream error \d+: /, "").slice(0, 60);
}

function clip(s) {
  return s.length <= 4000 ? s : s.slice(0, 3990) + "\n…";
}

export function formatNothing() {
  return [
    "I couldn't find a ship or a claim to check in that.",
    "",
    "Send or forward a rumour that names a ship, for example:",
    "<i>tanker ADRIAN DARYA 1 hit by a drone in the Red Sea</i>",
    "<i>MV EAGLE S went dark in the Gulf of Finland, IMO 9329760</i>",
  ].join("\n");
}

export const HELP = [
  "<b>Keel checks war and shipping rumours against live ship tracking.</b>",
  "",
  "• <b>Forward or paste</b> a rumour that names a ship. I buy its live position from two independent tracking miners on Telegraph, screen it against sanctions lists, fact-check the claim, and reply with a verdict and a receipt for every check.",
  "• In a group: reply to a message with /check, or write <code>/check tanker NAME was hit…</code>",
  "• /watch NAME or IMO — I message you if the ship goes quiet for 3+ hours or turns up somewhere unexpected.",
  "• /unwatch NAME · /watches · /receipts (last checks) · /stats · /about",
  "",
  "Verdicts: ⚠️ tracking disagrees with the rumour · ✅ consistent with tracking · ❓ can't verify from tracking.",
  "Tracking shows where a ship is and how fast it moves. It can't prove damage, and position reports can be spoofed, so I never say a rumour is false on tracking alone.",
  "",
  "<i>Runs on the Telegraph testnet: every check is paid in test USDC, not real money.</i>",
].join("\n");

export const ABOUT = [
  "<b>About Keel</b>",
  "Conflict intelligence for anyone who reads shipping news: newsrooms, analysts, traders and insurers.",
  "Each check buys answers from ranked miners on the Telegraph network (testnet). Every answer carries a signal hash you can open: that is the receipt.",
  "Tracking: Quay and VesselWire miners (live AIS). Sanctions: Telegraph screening miners plus OFAC's own SDN list. Claims: fact-check miners.",
  "Source and method: https://github.com/subheeksh5599/keel",
].join("\n");
