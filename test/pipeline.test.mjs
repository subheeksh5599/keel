import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck } from "../src/check.mjs";
import { formatCheck } from "../src/format.mjs";
import { Budget } from "../src/budget.mjs";
import { parseSdnVessels, OfacList } from "../src/ofac.mjs";
import { Watcher } from "../src/watch.mjs";
import { KeelBot, parseCommand } from "../src/bot.mjs";

const NOW = new Date("2026-11-27T10:00:00Z");

// A stand-in Telegraph that answers by intent and miner, so the whole pipeline runs without the network.
function fakeTelegraph(map) {
  const calls = [];
  return {
    calls,
    async ask({ intent, params, miner, budget }) {
      calls.push({ intent, params, miner });
      const a = map(intent, miner, params);
      if (!a) return { ok: false, intent, miner, minerId: miner, costUsd: 0, signalUrl: null, error: "the miner had no data for this" };
      budget?.reserve(0.01);
      return { ok: true, intent, miner: a.miner || miner, minerId: miner, answer: a.answer, signal: `0x${calls.length}`, signalUrl: `https://node/engine/v1/signal/0x${calls.length}`, costUsd: 0.01 };
    },
  };
}

const SDN = `36,"ADRIAN DARYA 1","vessel","IRAN-EO13846",-0- ,"9HA2441","Crude Oil Tanker",-0- ,"151,738","Iran",-0- ,"Vessel Registration Identification IMO 9116412; f.k.a. 'GRACE 1'."\r\n37,"SOME PERSON","individual","SDGT",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- \r\n`;

test("OFAC parser keeps vessels, IMO numbers and former names", () => {
  const v = parseSdnVessels(SDN);
  assert.equal(v.length, 1);
  assert.equal(v[0].imo, "9116412");
  assert.deepEqual(v[0].aka, ["GRACE 1"]);
});

test("full check: two trackers, sanctions hit from OFAC by former name, fact-check, formatted reply with receipts", async () => {
  const ofac = new OfacList({ fetchImpl: async () => new Response(SDN) });
  await ofac.load();
  const tg = fakeTelegraph((intent, miner) => {
    if (intent === "VESSEL_TELEMETRY_VERIFY_GENERAL" && miner === "8818818") return { miner: "Quay", answer: { latitude: 36.1, longitude: -5.4, speed_knots: 12, observed_at: "2026-11-27T09:55:00Z" } };
    if (intent === "VESSEL_TELEMETRY_VERIFY_GENERAL" && miner === "751084") return { miner: "VesselWire", answer: { latitude: 36.11, longitude: -5.38, speed_knots: 12, observed_at: "2026-11-27T09:57:00Z" } };
    if (intent === "SANCTIONS_SCREENING_MATCH_GENERAL") return { miner: "Screener", answer: { matched: false, lists: ["US OFAC SDN"] } };
    if (intent === "FACT_CHECK_GENERAL") return { miner: "Facts", answer: { verdict: "Unverified" } };
    return null;
  });
  const budget = new Budget({ dailyCapUsd: 1 });
  const c = await runCheck("tanker GRACE 1 struck by a missile and sinking in the Red Sea", { telegraph: tg, budget, ofac, now: () => NOW });
  assert.equal(c.kind, "ship");
  assert.equal(c.result.verdict.key, "DISAGREES"); // fresh fixes near Gibraltar, far from the Red Sea
  assert.equal(c.result.sanctions, "listed"); // the miner missed it, OFAC caught the former name
  assert.equal(c.purchases.length, 3); // the Baltic-only tracker is not paid to look near Gibraltar
  assert.deepEqual(c.evidence.skipped, ["VesselWire (covers the Baltic only)"]);
  assert.equal(c.totalUsd, 0.03);
  const html = formatCheck(c, { budgetLeftUsd: budget.remainingUsd() });
  assert.match(html, /Tracking disagrees/);
  assert.match(html, /🚩 Sanctions: OFAC's own SDN list has it \(IMO 9116412/);
  assert.equal((html.match(/receipt \d/g) || []).length, 3);
  assert.ok(html.length < 4096);
});

test("no tracker hears the ship → one routed ask, then can't verify", async () => {
  const tg = fakeTelegraph(() => null);
  const c = await runCheck("tanker NOBODY KNOWS hit near Hormuz", { telegraph: tg, budget: new Budget({ dailyCapUsd: 1 }), now: () => NOW });
  assert.equal(c.result.verdict.key, "UNVERIFIED");
  assert.ok(tg.calls.some((x) => x.intent === "VESSEL_TELEMETRY_VERIFY_GENERAL" && !x.miner));
  assert.equal(c.result.sanctions, "failed");
});

test("per-check cap stops buying mid-check without crashing", async () => {
  const tg = fakeTelegraph((intent) => ({ answer: intent === "VESSEL_TELEMETRY_VERIFY_GENERAL" ? { latitude: 1, longitude: 1, speed_knots: 1, observed_at: NOW.toISOString() } : { verdict: "Unverified", matched: false } }));
  const c = await runCheck("tanker CAPPED struck near Hormuz", { telegraph: tg, budget: new Budget({ dailyCapUsd: 1 }), maxCheckUsd: 0.02, now: () => NOW });
  assert.ok(c.purchases.some((p) => /per-check cap/.test(p.error || "")));
  assert.ok(c.totalUsd <= 0.02);
});

test("nothing to check → no purchase", async () => {
  const tg = fakeTelegraph(() => ({ answer: {} }));
  const c = await runCheck("good morning", { telegraph: tg, budget: new Budget({ dailyCapUsd: 1 }) });
  assert.equal(c.kind, "nothing");
  assert.equal(tg.calls.length, 0);
});

test("claim with no ship: only the fact-check is bought, no tracking or sanctions noise", async () => {
  const tg = fakeTelegraph((intent) => intent === "FACT_CHECK_GENERAL" ? { answer: { verdict: "Unverified" } } : null);
  const c = await runCheck("Iran closed the Strait of Hormuz to all shipping today", { telegraph: tg, budget: new Budget({ dailyCapUsd: 1 }), now: () => NOW });
  assert.equal(c.kind, "claim");
  assert.deepEqual(tg.calls.map((x) => x.intent), ["FACT_CHECK_GENERAL"]);
  assert.equal(c.result.sanctions, "not-applicable");
  assert.ok(!c.result.flags.some((f) => /Sanctions check failed/.test(f)));
  assert.ok(c.result.reasons.some((r) => /No ship was named/.test(r.text)));
});

test("a tracker that answers without a position is not counted, and triggers the routed fallback", async () => {
  const tg = fakeTelegraph((intent, miner) => intent === "VESSEL_TELEMETRY_VERIFY_GENERAL" && miner ? { answer: { latitude: null, longitude: null, observed_at: NOW.toISOString() } } : null);
  const c = await runCheck("tanker GHOST struck near Hormuz", { telegraph: tg, budget: new Budget({ dailyCapUsd: 1 }), now: () => NOW });
  assert.ok(c.purchases.filter((p) => p.label.startsWith("Position (") && p.label !== "Position (routed by Telegraph)").every((p) => !p.ok));
  assert.ok(tg.calls.some((x) => x.intent === "VESSEL_TELEMETRY_VERIFY_GENERAL" && !x.miner));
});

test("watch: goes quiet → one alert; transmitting again → one alert; impossible jump → spoof alert", async () => {
  let t = new Date("2026-11-27T10:00:00Z");
  let answer = { latitude: 59.9, longitude: 26.0, speed_knots: 10, observed_at: "2026-11-27T09:55:00Z" };
  const tg = { ask: async () => (answer ? { ok: true, answer, signalUrl: "https://node/s/1" } : { ok: false }) };
  const sent = [];
  const w = new Watcher({ file: join(mkdtempSync(join(tmpdir(), "keel-")), "w.json"), telegraph: tg, now: () => t, send: async (id, m) => sent.push(m) });
  w.add(1, "EAGLE S");
  assert.equal((await w.tick()).length, 0);
  answer = null; t = new Date("2026-11-27T14:00:00Z");
  assert.match((await w.tick())[0].text, /gone quiet/);
  t = new Date("2026-11-27T16:00:00Z");
  assert.equal((await w.tick()).length, 0); // no repeat while still quiet
  answer = { latitude: 59.95, longitude: 25.9, speed_knots: 9, observed_at: "2026-11-27T17:55:00Z" }; t = new Date("2026-11-27T18:00:00Z");
  assert.match((await w.tick())[0].text, /transmitting again/);
  answer = { latitude: 26.5, longitude: 56.3, speed_knots: 9, observed_at: "2026-11-27T19:55:00Z" }; t = new Date("2026-11-27T20:00:00Z");
  const alerts = await w.tick();
  assert.ok(alerts.some((a) => /jumped/.test(a.text)));
});

test("watch limits per chat", () => {
  const w = new Watcher({ file: join(mkdtempSync(join(tmpdir(), "keel-")), "w.json"), telegraph: {}, send: async () => {} });
  assert.equal(w.add(1, "A").ok, true);
  assert.equal(w.add(1, "B").ok, true);
  assert.equal(w.add(1, "C").ok, false);
  assert.equal(w.add(1, "A").ok, false);
});

test("commands parse, and a command for another bot is ignored", () => {
  assert.deepEqual(parseCommand("/check tanker X hit", "keel567_bot"), { name: "check", args: "tanker X hit" });
  assert.deepEqual(parseCommand("/watch@keel567_bot EAGLE S", "keel567_bot"), { name: "watch", args: "EAGLE S" });
  assert.equal(parseCommand("/check@otherbot x", "keel567_bot"), null);
  assert.equal(parseCommand("hello", "keel567_bot"), null);
});

test("bot: a forwarded rumour in a private chat gets an acknowledgement, a verdict, a map pin and a group post", async () => {
  const sent = [];
  const api = async (method, body) => { sent.push({ method, body }); return { message_id: sent.length, username: "keel567_bot" }; };
  const tg = fakeTelegraph((intent, miner) => intent === "VESSEL_TELEMETRY_VERIFY_GENERAL" && miner === "8818818" ? { answer: { latitude: 60.08, longitude: 20.94, speed_knots: 20, observed_at: NOW.toISOString() } } : intent === "SANCTIONS_SCREENING_MATCH_GENERAL" ? { answer: { matched: false } } : null);
  const dir = mkdtempSync(join(tmpdir(), "keel-"));
  const bot = new KeelBot({ token: "t", api, telegraph: tg, budget: new Budget({ dailyCapUsd: 1 }), ofac: null, dataDir: dir, now: () => NOW, verdictChatId: -100 });
  bot.username = "keel567_bot";
  await bot.handle({ update_id: 1, message: { message_id: 9, chat: { id: 5, type: "private" }, forward_date: 1, text: "ferry VIKING GLORY sinking in the Baltic" } });
  const methods = sent.map((s) => s.method);
  assert.deepEqual(methods.filter((m) => m !== "sendChatAction"), ["sendMessage", "editMessageText", "sendLocation", "sendMessage"]);
  assert.match(sent.find((s) => s.method === "editMessageText").body.text, /Tracking disagrees/);
  assert.equal(sent.at(-1).body.chat_id, -100);
  // The same rumour again within 10 minutes is answered from cache: no new purchase.
  const before = tg.calls.length;
  await bot.handle({ update_id: 2, message: { message_id: 10, chat: { id: 5, type: "private" }, text: "ferry VIKING GLORY sinking in the Baltic" } });
  assert.equal(tg.calls.length, before);
  assert.match(sent.at(-1).body.text, /nothing paid again/);
});

test("bot: in a group, plain chatter is ignored and /check as a reply checks the replied message", async () => {
  const sent = [];
  const api = async (method, body) => { sent.push({ method, body }); return { message_id: sent.length }; };
  const tg = fakeTelegraph(() => null);
  const bot = new KeelBot({ token: "t", api, telegraph: tg, budget: new Budget({ dailyCapUsd: 1 }), dataDir: mkdtempSync(join(tmpdir(), "keel-")), now: () => NOW });
  bot.username = "keel567_bot";
  await bot.handle({ update_id: 1, message: { message_id: 1, chat: { id: -5, type: "group", title: "friends" }, text: "tanker X sinking lol" } });
  assert.equal(sent.length, 0);
  await bot.handle({ update_id: 2, message: { message_id: 2, chat: { id: -5, type: "group", title: "friends" }, text: "/check", reply_to_message: { text: "tanker ELISE hit near Hormuz" } } });
  assert.ok(sent.some((s) => s.method === "editMessageText" && /ELISE/.test(s.body.text)));
});

test("signal enrichment: the tracker's raw IMO feeds the OFAC match and the second tracker is asked by MMSI", async () => {
  const ofac = new OfacList({ fetchImpl: async () => new Response(SDN) });
  await ofac.load();
  const base = fakeTelegraph((intent, miner, params) => {
    if (intent === "VESSEL_TELEMETRY_VERIFY_GENERAL" && miner === "8818818") return { answer: { latitude: 60.1, longitude: 26.5, speed_knots: 0, observed_at: NOW.toISOString() } };
    if (intent === "VESSEL_TELEMETRY_VERIFY_GENERAL" && miner === "751084" && params.vessel === "422123456") return { answer: { latitude: 60.101, longitude: 26.501, speed_knots: 0, observed_at: NOW.toISOString() } };
    return null;
  });
  const tg = { ...base, ask: base.ask, signal: async () => ({ raw: { imo: "9116412", mmsi: "422123456", nav_status: "at_anchor", other_ships_with_same_name: 0 }, verified: true }) };
  const c = await runCheck("tanker MYSTERY seized in the Gulf of Finland", { telegraph: tg, budget: new Budget({ dailyCapUsd: 1 }), ofac, now: () => NOW });
  assert.equal(c.identity.imo, "9116412");
  assert.ok(base.calls.some((x) => x.miner === "751084" && x.params.vessel === "422123456"));
  assert.equal(c.result.sanctions, "listed");
  assert.equal(c.result.best.navStatus, "at anchor");
  assert.equal(c.result.sourcesAgree, true);
});

test("bot: in a group, a forwarded rumour and any rumour in the verdict group are checked without a command; chatter is not", async () => {
  const sent = [];
  const api = async (method, body) => { sent.push({ method, body }); return { message_id: sent.length }; };
  const bot = new KeelBot({ token: "t", api, telegraph: fakeTelegraph(() => null), budget: new Budget({ dailyCapUsd: 1 }), dataDir: mkdtempSync(join(tmpdir(), "keel-")), now: () => NOW });
  bot.username = "keel567_bot";
  const group = { id: -7, type: "supergroup", title: "shipping desk" };
  await bot.handle({ update_id: 1, message: { message_id: 1, chat: group, text: "anyone around?" , forward_date: 1 } });
  assert.equal(sent.length, 0);
  await bot.handle({ update_id: 2, message: { message_id: 2, chat: group, text: "tanker ELISE hit near Hormuz", forward_date: 1 } });
  assert.ok(sent.some((s) => s.method === "editMessageText" && /ELISE/.test(s.body.text)));
  const verdict = { id: -9, type: "supergroup", title: "keelverdict" };
  sent.length = 0;
  await bot.handle({ update_id: 3, message: { message_id: 3, chat: verdict, text: "tanker NORDIC hit near Hormuz" } });
  assert.ok(sent.some((s) => s.method === "editMessageText" && /NORDIC/.test(s.body.text) && s.body.chat_id === -9));
  assert.equal(sent.filter((s) => s.method === "sendMessage" && s.body.chat_id === -9 && /Checked via/.test(s.body.text)).length, 0, "no duplicate post into the group it was asked in");
});
