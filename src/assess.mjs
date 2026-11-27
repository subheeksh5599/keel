// The verdict engine. Pure: evidence in, verdict out. Every rule is written so that tracking data is never
// stretched into a claim it cannot support (a moored ship can still be damaged; a transmitting ship can be spoofed).
import { distanceKm, impliedKnots, onLand, regionOf } from "./geo.mjs";
import { claimLabel } from "./extract.mjs";

export const STALE_HOURS = 3;
export const FRESH_MIN = 60;
const MAX_SHIP_KNOTS = 45; // no merchant ship reports faster than this; above it the report is bad or spoofed
const UNDERWAY_KNOTS = 6; // clearly making way
const PLACE_KM = 400; // a ship further than this from the place the rumour names is "somewhere else"

// Rough centres for places rumours name, to test "the ship is not even there".
export const PLACE_CENTRES = {
  "Strait of Hormuz": [26.6, 56.4], "Gulf of Oman": [24.5, 58.5], "Persian Gulf": [27.0, 51.5], "Red Sea": [20.0, 38.5],
  "Bab el-Mandeb": [12.6, 43.3], "Gulf of Aden": [12.5, 47.5], "Suez Canal": [30.6, 32.35], "Black Sea": [43.5, 34.0],
  "Baltic Sea": [58.0, 19.5], "Gulf of Finland": [59.9, 26.0], "South China Sea": [13.0, 114.0], "Taiwan Strait": [24.0, 119.5],
  "Strait of Malacca": [3.0, 100.5], "English Channel": [50.2, -1.5], "Mediterranean": [36.0, 18.0], "Fujairah": [25.15, 56.4],
  "Ras Tanura": [26.65, 50.17], "Kharg Island": [29.24, 50.31], "Bandar Abbas": [27.15, 56.2], "Hodeidah": [14.8, 42.9],
  "Odesa": [46.45, 30.75], "Novorossiysk": [44.7, 37.8], "Primorsk": [60.35, 28.6], "Ust-Luga": [59.68, 28.4],
  "Yemen coast": [14.5, 45.0], "Somali coast": [6.0, 49.5], "Gulf of Guinea": [3.0, 3.0], "Strait of Gibraltar": [35.95, -5.6],
  "Bosphorus": [41.1, 29.05], "Kerch Strait": [45.3, 36.5],
};

export const VERDICT = {
  DISAGREES: { key: "DISAGREES", icon: "⚠️", label: "Tracking disagrees with the rumour" },
  CONSISTENT: { key: "CONSISTENT", icon: "✅", label: "Consistent with tracking" },
  UNVERIFIED: { key: "UNVERIFIED", icon: "❓", label: "Can't verify from tracking" },
};

/**
 * @param {object} ev
 *  ev.claims: string[] claim keys from extract(); ev.places: string[]
 *  ev.fixes: [{ source, operator, lat, lon, speed, course, at, signalUrl }] — answers that carried a position
 *  ev.noData: [{ source, reason }]
 *  ev.sanctions: { telegraph: { ok, matched, lists, source } | null, ofac: { checked, matches } | null }
 *  ev.factCheck: { ok, verdict, reasoning } | null
 *  ev.media: [{ ok, verdict, confidence, summary }]
 *  ev.now: Date
 */
export function assess(ev) {
  const now = ev.now ? new Date(ev.now) : new Date();
  const claims = ev.claims || [];
  const reasons = []; // { sign: +1|-1|0, text }
  const flags = []; // things a reader must see whatever the verdict
  const fixes = (ev.fixes || []).filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lon));

  // 1. Choose the freshest position and judge its age.
  const t = (f) => { const v = Date.parse(f.at || ""); return Number.isFinite(v) ? v : -Infinity; };
  fixes.sort((a, b) => t(b) - t(a));
  const best = fixes[0] || null;
  // An unreadable timestamp, or one more than 10 minutes in the future, is an unknown age, and unknown is never live.
  const rawAge = best ? (now - t(best)) / 60000 : NaN;
  const ageMin = Number.isFinite(rawAge) && rawAge >= -10 ? Math.max(0, rawAge) : null;
  const stale = ageMin == null || ageMin > STALE_HOURS * 60;
  const fresh = ageMin != null && ageMin <= FRESH_MIN;

  let confidence = 50;
  const operators = new Set(fixes.map((f) => f.operator || f.source));

  const hasShip = ev.hasShip !== false;
  if (!hasShip) {
    reasons.push({ sign: 0, text: "No ship was named, so there is nothing to track. Only the claim itself was checked." });
    confidence -= 20;
  } else if (!best) {
    const why = (ev.noData || []).map((n) => `${n.source}: ${n.reason}`).join("; ");
    reasons.push({ sign: -1, text: `No tracking source has a position for this ship${why ? ` (${why})` : ""}. Coverage is from coastal receivers, so ships far offshore can go unheard.` });
    confidence -= 20;
  } else if (stale) {
    reasons.push({ sign: -1, text: `Its last position report is ${fmtAge(ageMin)} old. I can't confirm where it is now.` });
    confidence -= 20;
  } else {
    reasons.push({ sign: +1, text: `Position reported ${fmtAge(ageMin)} ago.` });
    if (fresh) confidence += 10;
  }

  // 2. Do independent sources agree? Compare the speed needed to move between their fixes with the speed reported.
  let sourcesAgree = null;
  if (operators.size >= 2) {
    const [a, b] = pickTwoOperators(fixes);
    const need = impliedKnots(a, b);
    const gapKm = distanceKm(a, b);
    const reported = Math.max(a.speed ?? 0, b.speed ?? 0);
    if (need === null) sourcesAgree = gapKm < 2;
    else sourcesAgree = need <= Math.max(reported * 1.5 + 5, 8) || gapKm < 2;
    if (sourcesAgree) {
      reasons.push({ sign: +1, text: `${a.source} and ${b.source} (different operators) agree on where it is (${gapKm.toFixed(1)} km apart, consistent with the time between reports).` });
      confidence += 20;
    } else {
      reasons.push({ sign: -1, text: `${a.source} and ${b.source} disagree: ${gapKm.toFixed(0)} km apart, which would need ${need?.toFixed(0)} knots. One report is wrong or spoofed.` });
      flags.push("Tracking sources disagree on the position: possible spoofing or a mixed-up ship.");
      confidence -= 25;
    }
  } else if (best) {
    const why = ev.skipped?.length ? ` The second tracker covers the Baltic only and was not asked.` : "";
    reasons.push({ sign: -1, text: `Only one tracking source has a position, so it can't be cross-checked.${why}` });
    confidence -= 10;
  }

  // 3. Spoof and bad-data checks on the best fix. Any of these blocks a verdict: a suspect position proves nothing.
  let suspect = sourcesAgree === false;
  if (best && ageMin == null && best.at) {
    reasons.push({ sign: -1, text: "The position's timestamp can't be read, so its age is unknown." });
  }
  if (best) {
    if (onLand(best)) {
      suspect = true;
      flags.push("The reported position is far inland: a bad or spoofed position report.");
      reasons.push({ sign: -1, text: "Position falls far inland, which a seagoing ship can't do." });
      confidence -= 30;
    }
    if ((best.speed ?? 0) > MAX_SHIP_KNOTS) {
      suspect = true;
      flags.push(`Reported speed ${best.speed} kn is impossible for a merchant ship.`);
      confidence -= 25;
    }
  }

  // 4. Compare the rumour with what tracking can actually show.
  let verdict = VERDICT.UNVERIFIED;
  const usable = best && !stale && !suspect;
  if (best && !stale && suspect) reasons.push({ sign: 0, text: "The position looks wrong (see the flags), so no verdict is drawn from it." });
  const speed = best?.speed ?? null;
  const nav = best?.navStatus || "";
  const placeMismatch = usable ? farFromClaimedPlace(best, ev.places || []) : null;
  const troubleClaim = claims.some((c) => ["struck", "sinking", "fire"].includes(c));

  if (ev.sameName > 0) {
    flags.push(`${ev.sameName} other ship${ev.sameName > 1 ? "s share" : " shares"} this name. Send the IMO number to be sure it is the right one.`);
    reasons.push({ sign: -1, text: "The name is not unique, so the position may belong to a different ship." });
    confidence -= 15;
  }

  if (usable && placeMismatch) {
    verdict = VERDICT.DISAGREES;
    reasons.push({ sign: +1, text: `The rumour places it in ${placeMismatch.place}, but it is ${Math.round(placeMismatch.km)} km away${best.region ? `, in ${best.region}` : ""}.` });
  } else if (usable && claims.includes("aground") && /aground/.test(nav)) {
    verdict = VERDICT.CONSISTENT;
    reasons.push({ sign: +1, text: `The ship itself is broadcasting the status "aground".` });
  } else if (usable && troubleClaim && /not under command|restricted/.test(nav)) {
    verdict = VERDICT.CONSISTENT;
    reasons.push({ sign: +1, text: `The ship itself is broadcasting "${nav}", which fits a ship in trouble. Crews also use it for engine failures, so it is not proof of an attack.` });
  } else if (usable && claims.includes("dark")) {
    if (fresh) {
      verdict = VERDICT.DISAGREES;
      reasons.push({ sign: +1, text: "The rumour says it went dark, but it was transmitting within the last hour." });
    }
  } else if (usable && (claims.includes("sinking") || claims.includes("aground")) && speed !== null && speed >= UNDERWAY_KNOTS && fresh) {
    verdict = VERDICT.DISAGREES;
    reasons.push({ sign: +1, text: `It is reporting ${speed} kn, making way normally, which a ${claims.includes("sinking") ? "sinking" : "grounded"} ship would not. A transmitter can keep sending after damage, so this is not proof.` });
  } else if (best && stale && ageMin != null && !suspect && claims.includes("dark")) {
    verdict = VERDICT.CONSISTENT;
    reasons.push({ sign: +1, text: `It has been quiet for ${fmtAge(ageMin)}, which fits the rumour that it went dark.` });
  }

  if (verdict === VERDICT.UNVERIFIED && usable) {
    const events = claims.filter((c) => c !== "dark" && c !== "blocked");
    if (events.length) reasons.push({ sign: 0, text: `Tracking can show where a ship is and how fast it moves, not whether it was ${events.map(claimLabel).join(" or ")}.` });
    if (speed !== null && speed < 1) reasons.push({ sign: 0, text: `It is stopped${nav ? ` (the ship reports "${nav}")` : ""}. That neither confirms nor rules out damage.` });
  }

  // 5. Fact-check and media checks are shown beside the tracking result, never averaged into it.
  const fc = ev.factCheck;
  if (fc?.ok && fc.verdict) {
    const v = String(fc.verdict);
    if (/^(False|Mostly False|Misleading)$/i.test(v)) {
      reasons.push({ sign: verdict === VERDICT.DISAGREES ? +1 : 0, text: `A fact-check miner rates the claim "${v}".` });
      if (verdict === VERDICT.DISAGREES) confidence += 5;
    } else if (/^(True|Mostly True)$/i.test(v)) {
      reasons.push({ sign: verdict === VERDICT.DISAGREES ? -1 : 0, text: `A fact-check miner rates the claim "${v}".` });
      if (verdict === VERDICT.DISAGREES) { confidence -= 15; flags.push("The fact-check and the tracking point in different directions."); }
    } else {
      reasons.push({ sign: 0, text: `A fact-check miner found no reliable source either way ("${v}").` });
    }
  }
  for (const m of ev.media || []) {
    if (!m.ok) continue;
    if (/manipulated/i.test(m.verdict || "")) flags.push(`The attached media was rated "${m.verdict}" by a forensics miner.`);
  }

  // 6. Sanctions: shown as a flag, never as a verdict on the rumour. A failed check is never a clean bill.
  //    The two sources are named separately: a screening miner can match a list OFAC does not carry (EU, UK).
  const s = ev.sanctions || {};
  const tgMatched = s.telegraph?.ok && s.telegraph.matched === true;
  const ofacMatched = s.ofac?.checked && s.ofac.matches?.length > 0;
  let sanctions = "unknown";
  if (!hasShip) {
    sanctions = "not-applicable";
  } else if (tgMatched || ofacMatched) {
    sanctions = "listed";
    const who = [];
    if (tgMatched) who.push(`a Telegraph screening miner matched it${s.telegraph.score != null && s.telegraph.score < 1 ? ` (match score ${Number(s.telegraph.score).toFixed(2)})` : ""}`);
    if (ofacMatched) {
      const m = s.ofac.matches[0];
      who.push(`OFAC's own SDN list has it${m.imo ? ` (IMO ${m.imo}` : ""}${m.program ? `${m.imo ? ", " : " ("}${m.program}` : ""}${m.imo || m.program ? ")" : ""}`);
    } else if (s.ofac?.checked) who.push("OFAC's SDN list does not (it may be on an EU or UK list)");
    flags.unshift(`🚩 Sanctions: ${who.join("; ")}.`);
  } else if (s.telegraph?.ok || s.ofac?.checked) {
    sanctions = s.telegraph?.ok && s.ofac?.checked ? "clear-two-sources" : "clear";
  } else {
    sanctions = "failed";
    flags.push("Sanctions check failed. This is not a clean bill.");
  }

  // The DISAGREES verdict needs a fresh fix; a single source caps how sure it can be.
  if (verdict === VERDICT.DISAGREES && operators.size < 2) confidence = Math.min(confidence + 10, 70);
  else if (verdict === VERDICT.DISAGREES && sourcesAgree === true) confidence += 15;
  if (verdict === VERDICT.UNVERIFIED) confidence = Math.min(confidence, 60);

  return {
    verdict,
    confidence: Math.max(5, Math.min(90, Math.round(confidence))),
    reasons,
    flags,
    best: best ? { ...best, region: best.region || regionOf(best) } : null,
    ageMin,
    stale,
    operators: [...operators],
    sourcesAgree,
    sanctions,
  };
}

function pickTwoOperators(fixes) {
  const a = fixes[0];
  const b = fixes.find((f) => (f.operator || f.source) !== (a.operator || a.source));
  return [a, b];
}

// How far each named area reaches from its centre, so a big sea is not "somewhere else" just off its middle.
const PLACE_RADIUS_KM = {
  "Mediterranean": 2000, "Red Sea": 1150, "South China Sea": 1300, "Baltic Sea": 750, "Black Sea": 600, "Persian Gulf": 550,
  "Gulf of Aden": 500, "English Channel": 300, "Strait of Malacca": 450, "Gulf of Finland": 220, "Gulf of Oman": 300, "Taiwan Strait": 200,
  "Yemen coast": 450, "Somali coast": 900, "Gulf of Guinea": 700,
};

function farFromClaimedPlace(fix, places) {
  const known = places.filter((p) => PLACE_CENTRES[p]);
  if (!known.length) return null;
  let nearest = null;
  for (const p of known) {
    const [lat, lon] = PLACE_CENTRES[p];
    const km = distanceKm(fix, { lat, lon });
    const margin = km - (PLACE_RADIUS_KM[p] || 0);
    if (!nearest || margin < nearest.margin) nearest = { place: p, km, margin };
  }
  return nearest.km > PLACE_KM + (PLACE_RADIUS_KM[nearest.place] || 0) ? nearest : null;
}

export function fmtAge(min) {
  if (min == null) return "unknown";
  if (min < 1) return "under a minute";
  if (min < 60) return `${Math.round(min)} min`;
  const h = min / 60;
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)} h`;
  return `${Math.round(h / 24)} days`;
}
