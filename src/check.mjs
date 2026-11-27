// One check: rumour text in, verdict + every purchase (with receipt) out.
import { extract } from "./extract.mjs";
import { assess } from "./assess.mjs";
import { regionOf } from "./geo.mjs";
import { CheckBudget, BudgetError } from "./budget.mjs";

// Tracking miners asked by id. Different operators reading different AIS networks, so agreement means something:
// 8818818 listens to worldwide terrestrial AIS receivers; 751084 relays Finland's official AIS feed (Baltic coverage)
// and resolves ships best by MMSI, so it is asked second, with the MMSI the first tracker reported when there is one.
export const TRACKERS = [
  { id: "8818818", source: "Quay", operator: "Quay" },
  { id: "751084", source: "VesselWire", operator: "VesselWire", coverage: [53.5, 9.0, 66.5, 31.0] }, // Baltic only
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
    // The free signal record carries the miner's full raw answer (IMO, MMSI, navigational status, same-name count).
    const sig = r.signal && telegraph.signal ? await telegraph.signal(r.signal) : null;
    if (sig) r = { ...r, raw: sig.raw, verified: sig.verified };
    // A tracking answer without a position is not evidence, even when the miner filled other fields.
    if (args.intent === INTENTS.vessel && (r.ok || r.status === 200) && (num(r.answer?.latitude) === null || num(r.answer?.longitude) === null)) {
      r = { ...r, ok: false, error: notSeenReason(r.raw) };
    }
    purchases.push({ label, ...r });
    return r;
  };

  // Sanctions, fact-check and media run in parallel with tracking.
  const sanctionsName = shipName || (ex.imos[0] ? `IMO ${ex.imos[0]}` : null);
  const sanctionsP = sanctionsName ? buy("Sanctions screen", { intent: INTENTS.sanctions, params: { name: sanctionsName } }) : Promise.resolve(null);
  const factP = ex.claims.length ? buy("Fact-check", { intent: INTENTS.fact, params: { claim: ex.text.slice(0, 400) } }) : Promise.resolve(null);
  const mediaP = ex.media[0] ? buy("Media forensics", { intent: INTENTS.media, params: { media_url: ex.media[0] } }) : Promise.resolve(null);

  // Tracking: first tracker, then the second with the best identifier we now hold.
  const tracked = [];
  const skipped = [];
  let identity = { imo: ex.imos[0] || null, mmsi: ex.mmsis[0] || null, name: shipName };
  if (shipQuery) {
    for (const [i, t] of trackers.entries()) {
      // A tracker that only covers one sea is not paid to look for a ship another tracker places elsewhere.
      const known = tracked.map(({ r }) => r).find((r) => r.ok);
      if (t.coverage && known && !inBox(known.answer, t.coverage)) {
        skipped.push(`${t.source} (covers the Baltic only)`);
        continue;
      }
      const q = i === 0 ? shipQuery : identity.mmsi || shipQuery;
      const r = await buy(`Position (${t.source})`, { intent: INTENTS.vessel, params: { vessel: q }, miner: t.id });
      identity = mergeIdentity(identity, r.raw);
      tracked.push({ t, r });
    }
    // If no pinned tracker heard the ship, let the node route one more ask to whichever miner ranks best.
    if (tracked.every(({ r }) => !r.ok)) {
      const r = await buy("Position (routed by Telegraph)", { intent: INTENTS.vessel, params: { vessel: shipQuery } });
      identity = mergeIdentity(identity, r.raw);
      tracked.push({ t: { id: r.minerId, source: r.miner || "routed miner", operator: r.miner || "routed" }, r });
    }
  }
  const [sanctionsR, factR, mediaR] = await Promise.all([sanctionsP, factP, mediaP]);

  const fixes = [];
  const noData = [];
  let sameName = 0;
  for (const { t, r } of tracked) {
    const a = r.answer || {};
    const raw = r.raw || {};
    const lat = num(a.latitude), lon = num(a.longitude);
    if (r.ok && lat !== null && lon !== null) {
      fixes.push({
        source: t.source, operator: t.operator, lat, lon,
        speed: num(a.speed_knots), course: num(a.course_deg), at: a.observed_at || null,
        navStatus: navStatusOf(raw), destination: raw.destination || null,
        signalUrl: r.signalUrl, region: regionOf({ lat, lon }),
      });
      sameName = Math.max(sameName, Number(raw.other_ships_with_same_name) || 0);
    } else {
      noData.push({ source: t.source, reason: r.error || "no position" });
    }
  }

  // OFAC is matched on every identifier we hold, including the IMO/MMSI a tracker reported for a name-only rumour.
  const ofacMatch = ofac && shipQuery ? ofac.match({ name: shipName, imo: identity.imo, mmsi: identity.mmsi }) : null;
  const evidence = {
    hasShip: Boolean(shipQuery),
    claims: ex.claims,
    places: ex.places,
    fixes,
    noData,
    skipped,
    sameName,
    identity,
    sanctions: {
      telegraph: sanctionsR ? { ok: sanctionsR.ok, matched: sanctionsR.answer?.matched === true || sanctionsR.answer?.matched === "true", lists: sanctionsR.answer?.lists || [], matches: sanctionsR.answer?.matches || [], score: sanctionsR.answer?.match_score ?? null, source: sanctionsR.miner } : null,
      ofac: ofacMatch,
    },
    factCheck: factR ? { ok: factR.ok, verdict: factR.answer?.verdict, reasoning: factR.answer?.reasoning, source: factR.miner } : null,
    media: mediaR ? [{ ok: mediaR.ok, verdict: mediaR.answer?.verdict, confidence: mediaR.answer?.confidence, summary: mediaR.answer?.summary }] : [],
    now: now(),
  };
  const result = assess(evidence);
  const totalUsd = round(purchases.reduce((s, p) => s + (p.costUsd || 0), 0));
  return { kind: shipQuery ? "ship" : "claim", extracted: ex, shipQuery, shipName, identity, evidence, result, purchases, totalUsd, checkedAt: evidence.now.toISOString() };
}

function inBox(a, [lat0, lon0, lat1, lon1]) {
  const lat = num(a?.latitude), lon = num(a?.longitude);
  return lat !== null && lon !== null && lat >= lat0 && lat <= lat1 && lon >= lon0 && lon <= lon1;
}

function mergeIdentity(id, raw) {
  if (!raw || typeof raw !== "object") return id;
  const imo = id.imo || (/^\d{7}$/.test(String(raw.imo || "")) ? String(raw.imo) : null);
  const mmsiRaw = String(raw.mmsi || "");
  const mmsi = id.mmsi || (/^\d{9}$/.test(mmsiRaw) ? mmsiRaw : null);
  return { ...id, imo, mmsi, name: id.name || raw.name || null, callsign: id.callsign || raw.callsign || raw.call_sign || null };
}

// AIS navigational status, as the ship itself broadcasts it ("moored", "at anchor", "aground", "not under command"...).
function navStatusOf(raw) {
  const v = raw?.nav_status ?? raw?.navigation_status ?? raw?.navigational_status ?? raw?.nav_stat ?? null;
  return v == null ? null : String(v).toLowerCase().replace(/_/g, " ");
}

function notSeenReason(raw) {
  const s = String(raw?.summary || "");
  const days = /last (\d+) days/.exec(s);
  if (days) return `not heard by its receivers in the last ${days[1]} days`;
  if (/Supply a nine-digit MMSI/i.test(s)) return "needs an MMSI to find this ship";
  return "no position: this miner has not heard the ship";
}

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const round = (n) => Math.round(n * 1e6) / 1e6;
