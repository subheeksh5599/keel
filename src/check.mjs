// One check: rumour text in, verdict + every purchase (with receipt) out.
import { extract } from "./extract.mjs";
import { assess } from "./assess.mjs";
import { regionOf } from "./geo.mjs";
import { CheckBudget, BudgetError } from "./budget.mjs";

// Tracking miners asked by id. Different operators, so agreement between them means something.
export const TRACKERS = [
  { id: "8818818", source: "Quay", operator: "Quay (imprint-hash)" },
  { id: "751084", source: "VesselWire", operator: "VesselWire" },
];

export const INTENTS = {
  vessel: "VESSEL_TELEMETRY_VERIFY_GENERAL",
  sanctions: "SANCTIONS_SCREENING_MATCH_GENERAL",
  fact: "FACT_CHECK_GENERAL",
  media: "MEDIA_FORENSIC_VERIFY_GENERAL",
};

export async function runCheck(text, { telegraph, budget, ofac, maxCheckUsd = 0.3, now = () => new Date(), trackers = TRACKERS } = {}) {
  const ex = extract(text);
  const purchases = [];
  const checkBudget = new CheckBudget(budget, maxCheckUsd);

  const shipQuery = ex.imos[0] ? `IMO ${ex.imos[0]}` : ex.mmsis[0] || ex.ships[0] || null;
  const shipName = ex.ships[0] || null;

  if (!shipQuery && !ex.claims.length) {
    return { kind: "nothing", extracted: ex, purchases, totalUsd: 0 };
  }

  const buy = async (label, args) => {
    let r;
    try {
      r = await telegraph.ask({ ...args, budget: checkBudget });
    } catch (e) {
      r = { ok: false, intent: args.intent, miner: args.miner || null, costUsd: 0, signalUrl: null, error: e instanceof BudgetError ? e.message : String(e.message || e) };
    }
    // A tracking answer without a position is not evidence, even when the miner filled other fields.
    if (r.ok && args.intent === INTENTS.vessel && (num(r.answer?.latitude) === null || num(r.answer?.longitude) === null)) {
      r = { ...r, ok: false, error: "no position: this miner has not heard the ship" };
    }
    purchases.push({ label, ...r });
    return r;
  };

  const tasks = [];
  if (shipQuery) {
    for (const t of trackers) tasks.push(buy(`Position (${t.source})`, { intent: INTENTS.vessel, params: { vessel: shipQuery }, miner: t.id }).then((r) => ({ t, r })));
  }
  const sanctionsName = shipName || (ex.imos[0] ? `IMO ${ex.imos[0]}` : null);
  // (no ship named → no sanctions screen and no tracking: only the claim is checked)
  const sanctionsP = sanctionsName ? buy("Sanctions screen", { intent: INTENTS.sanctions, params: { name: sanctionsName } }) : Promise.resolve(null);
  const factP = ex.claims.length ? buy("Fact-check", { intent: INTENTS.fact, params: { claim: ex.text.slice(0, 400) } }) : Promise.resolve(null);
  const mediaP = ex.media[0] ? buy("Media forensics", { intent: INTENTS.media, params: { media_url: ex.media[0] } }) : Promise.resolve(null);

  const tracked = await Promise.all(tasks);
  // If no pinned tracker heard the ship, let the node route one more ask to whichever miner ranks best.
  if (shipQuery && tracked.length && tracked.every(({ r }) => !r.ok)) {
    const r = await buy("Position (routed by Telegraph)", { intent: INTENTS.vessel, params: { vessel: shipQuery } });
    tracked.push({ t: { id: r.minerId, source: r.miner || "routed miner", operator: r.miner || "routed" }, r });
  }
  const [sanctionsR, factR, mediaR] = await Promise.all([sanctionsP, factP, mediaP]);

  const fixes = [];
  const noData = [];
  for (const { t, r } of tracked) {
    const a = r.answer || {};
    const lat = num(a.latitude), lon = num(a.longitude);
    if (r.ok && lat !== null && lon !== null) {
      fixes.push({ source: t.source, operator: t.operator, lat, lon, speed: num(a.speed_knots), course: num(a.course_deg), at: a.observed_at || null, signalUrl: r.signalUrl, region: regionOf({ lat, lon }) });
    } else {
      noData.push({ source: t.source, reason: r.error || "no position" });
    }
  }

  const ofacMatch = ofac && shipQuery ? ofac.match({ name: shipName, imo: ex.imos[0], mmsi: ex.mmsis[0] }) : null;
  const evidence = {
    hasShip: Boolean(shipQuery),
    claims: ex.claims,
    places: ex.places,
    fixes,
    noData,
    sanctions: {
      telegraph: sanctionsR ? { ok: sanctionsR.ok, matched: sanctionsR.answer?.matched === true || sanctionsR.answer?.matched === "true", lists: sanctionsR.answer?.lists || [], matches: sanctionsR.answer?.matches || [], score: sanctionsR.answer?.match_score ?? null, source: sanctionsR.miner } : null,
      ofac: ofacMatch,
    },
    factCheck: factR ? { ok: factR.ok, verdict: factR.answer?.verdict, reasoning: factR.answer?.reasoning, source: factR.miner } : null,
    media: mediaR ? [{ ok: mediaR.ok, verdict: mediaR.answer?.verdict, confidence: mediaR.answer?.confidence, summary: mediaR.answer?.summary }] : [],
    now: now(),
  };
  const result = assess(evidence);
  const totalUsd = round(purchases.reduce((s, p) => s + (p.ok || p.costUsd ? p.costUsd || 0 : 0), 0));
  return { kind: shipQuery ? "ship" : "claim", extracted: ex, shipQuery, shipName, evidence, result, purchases, totalUsd, checkedAt: evidence.now.toISOString() };
}

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const round = (n) => Math.round(n * 1e6) / 1e6;
