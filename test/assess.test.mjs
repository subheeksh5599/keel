import { test } from "node:test";
import assert from "node:assert/strict";
import { assess } from "../src/assess.mjs";

const NOW = new Date("2026-11-27T10:00:00Z");
const fix = (source, lat, lon, speed, minAgo, operator = source) => ({ source, operator, lat, lon, speed, at: new Date(NOW - minAgo * 60000).toISOString() });
const clean = { telegraph: { ok: true, matched: false, lists: ["OFAC"] }, ofac: { checked: true, matches: [] } };

test("sinking rumour vs a ship making way, two agreeing operators → disagrees", () => {
  const r = assess({ claims: ["sinking"], fixes: [fix("Quay", 60.0818, 20.9398, 20.8, 20), fix("VesselWire", 60.0853, 20.8035, 18.5, 6)], sanctions: clean, now: NOW });
  assert.equal(r.verdict.key, "DISAGREES");
  assert.equal(r.sourcesAgree, true);
  assert.ok(r.confidence >= 70);
});

test("a stopped ship never 'disproves' a hit: verdict stays can't-verify", () => {
  const r = assess({ claims: ["struck", "sinking"], fixes: [fix("Quay", 25.15, 56.42, 0, 6)], sanctions: clean, now: NOW });
  assert.equal(r.verdict.key, "UNVERIFIED");
  assert.ok(r.reasons.some((x) => /neither confirms nor rules out/.test(x.text)));
});

test("stale position (>3 h) → can't confirm, low confidence", () => {
  const r = assess({ claims: ["sinking"], fixes: [fix("Quay", 26.5, 56.3, 14, 300)], sanctions: clean, now: NOW });
  assert.equal(r.verdict.key, "UNVERIFIED");
  assert.equal(r.stale, true);
  assert.ok(r.confidence <= 40);
});

test("no tracking data at all → can't verify", () => {
  const r = assess({ claims: ["struck"], fixes: [], sanctions: clean, now: NOW });
  assert.equal(r.verdict.key, "UNVERIFIED");
  assert.equal(r.best, null);
});

test("rumour names the Red Sea, fresh fix is in the North Sea → disagrees", () => {
  const r = assess({ claims: ["struck"], places: ["Red Sea"], fixes: [fix("Quay", 51.93, 4.06, 0, 5)], sanctions: clean, now: NOW });
  assert.equal(r.verdict.key, "DISAGREES");
  assert.ok(r.reasons.some((x) => /km away/.test(x.text)));
});

test("'went dark' but transmitting 10 min ago → disagrees; quiet for 6 h → consistent", () => {
  assert.equal(assess({ claims: ["dark"], fixes: [fix("Quay", 59.9, 26, 10, 10)], sanctions: clean, now: NOW }).verdict.key, "DISAGREES");
  assert.equal(assess({ claims: ["dark"], fixes: [fix("Quay", 59.9, 26, 10, 360)], sanctions: clean, now: NOW }).verdict.key, "CONSISTENT");
});

test("two operators far apart → spoofing flag and lower confidence", () => {
  const r = assess({ claims: ["struck"], fixes: [fix("Quay", 26.5, 56.3, 12, 10), fix("VesselWire", 36.0, 18.0, 12, 5)], sanctions: clean, now: NOW });
  assert.equal(r.sourcesAgree, false);
  assert.ok(r.flags.some((f) => /disagree on the position/.test(f)));
});

test("a position deep inland is flagged as a bad or spoofed report", () => {
  const r = assess({ claims: [], fixes: [fix("Quay", 32.0, 54.0, 11, 5)], sanctions: clean, now: NOW });
  assert.ok(r.flags.some((f) => /inland/.test(f)));
});

test("sanctions: a hit from either source is flagged; a failed check is never a clean bill", () => {
  const listed = assess({ claims: [], fixes: [], sanctions: { telegraph: { ok: true, matched: true, lists: ["US OFAC SDN", "EU Consolidated"] }, ofac: { checked: true, matches: [] } }, now: NOW });
  assert.equal(listed.sanctions, "listed");
  assert.ok(listed.flags[0].startsWith("🚩"));
  const failed = assess({ claims: [], fixes: [], sanctions: { telegraph: { ok: false }, ofac: { checked: false } }, now: NOW });
  assert.equal(failed.sanctions, "failed");
  assert.ok(failed.flags.some((f) => /not a clean bill/.test(f)));
  const ofacOnly = assess({ claims: [], fixes: [], sanctions: { telegraph: { ok: false }, ofac: { checked: true, matches: [{ name: "X" }] } }, now: NOW });
  assert.equal(ofacOnly.sanctions, "listed");
});

test("a fact-check that says True lowers a tracking disagreement and flags the conflict", () => {
  const base = { claims: ["sinking"], fixes: [fix("Quay", 60.08, 20.94, 20, 5)], sanctions: clean, now: NOW };
  const a = assess(base);
  const b = assess({ ...base, factCheck: { ok: true, verdict: "True" } });
  assert.ok(b.confidence < a.confidence);
  assert.ok(b.flags.some((f) => /different directions/.test(f)));
});

test("confidence is always within 5..90", () => {
  const r = assess({ claims: ["sinking"], fixes: [fix("Quay", 60.08, 20.94, 20, 1), fix("VW", 60.081, 20.941, 20, 1)], sanctions: clean, factCheck: { ok: true, verdict: "False" }, now: NOW });
  assert.ok(r.confidence <= 90 && r.confidence >= 5);
});

test("the ship broadcasting 'aground' matches an aground rumour; 'not under command' fits a ship in trouble", () => {
  const ag = assess({ claims: ["aground"], fixes: [{ ...fix("Quay", 30.0, 32.57, 0, 10), navStatus: "aground" }], sanctions: clean, now: NOW });
  assert.equal(ag.verdict.key, "CONSISTENT");
  const nuc = assess({ claims: ["struck"], fixes: [{ ...fix("Quay", 13.0, 43.0, 1, 10), navStatus: "not under command" }], sanctions: clean, now: NOW });
  assert.equal(nuc.verdict.key, "CONSISTENT");
  assert.ok(nuc.reasons.some((r) => /not proof of an attack/.test(r.text)));
});

test("an aground rumour vs a ship making way at speed → disagrees", () => {
  const r = assess({ claims: ["aground"], fixes: [fix("Quay", 30.0, 32.57, 12, 5)], sanctions: clean, now: NOW });
  assert.equal(r.verdict.key, "DISAGREES");
});

test("a name shared by other ships is flagged and lowers confidence", () => {
  const base = { claims: ["sinking"], fixes: [fix("Quay", 60.08, 20.94, 20, 5)], sanctions: clean, now: NOW };
  const a = assess(base), b = assess({ ...base, sameName: 2 });
  assert.ok(b.confidence < a.confidence);
  assert.ok(b.flags.some((f) => /2 other ships share this name/.test(f)));
});

test("no position: the reason names each tracker's answer", () => {
  const r = assess({ claims: ["struck"], fixes: [], noData: [{ source: "Quay", reason: "not heard by its receivers in the last 14 days" }], sanctions: clean, now: NOW });
  assert.ok(r.reasons.some((x) => /Quay: not heard by its receivers in the last 14 days/.test(x.text)));
});

test("a big sea is judged by its extent: a ship in the western Mediterranean is not 'somewhere else'", () => {
  const west = assess({ claims: ["struck"], places: ["Mediterranean"], fixes: [fix("Quay", 37.0, 2.0, 12, 5)], sanctions: clean, now: NOW });
  assert.notEqual(west.verdict.key, "DISAGREES");
  const yemen = assess({ claims: ["struck"], places: ["Yemen coast"], fixes: [fix("Quay", 51.94, 4.06, 0, 5)], sanctions: clean, now: NOW });
  assert.equal(yemen.verdict.key, "DISAGREES");
});

test("a suspect position never yields 'disagrees': sources far apart, or a fix far inland", () => {
  const apart = assess({ claims: ["struck"], places: ["Red Sea"], fixes: [fix("Quay", 51.94, 4.06, 0, 5), { ...fix("VesselWire", 20.0, 38.5, 0, 6), operator: "VesselWire" }], sanctions: clean, now: NOW });
  assert.equal(apart.verdict.key, "UNVERIFIED");
  const inland = assess({ claims: ["struck"], places: ["Persian Gulf"], fixes: [fix("Quay", 33.0, 44.0, 0, 5)], sanctions: clean, now: NOW });
  assert.equal(inland.verdict.key, "UNVERIFIED");
});

test("an unreadable or future timestamp is an unknown age, never live", () => {
  const bad = assess({ claims: ["dark"], fixes: [{ ...fix("Quay", 60.08, 20.94, 18, 5), at: "garbage" }], sanctions: clean, now: NOW });
  assert.equal(bad.ageMin, null);
  assert.equal(bad.verdict.key, "UNVERIFIED");
  const future = assess({ claims: ["dark"], fixes: [{ ...fix("Quay", 60.08, 20.94, 18, 5), at: new Date(NOW.getTime() + 3600e3).toISOString() }], sanctions: clean, now: NOW });
  assert.equal(future.verdict.key, "UNVERIFIED");
});
