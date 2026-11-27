import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget, CheckBudget, BudgetError } from "../src/budget.mjs";
import { Telegraph, parseAnswer } from "../src/telegraph.mjs";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // a throwaway test key, never funded

test("daily cap refuses before paying, and survives a restart", () => {
  const file = join(mkdtempSync(join(tmpdir(), "keel-")), "spend.json");
  const now = () => new Date("2026-11-27T10:00:00Z");
  const b = new Budget({ file, dailyCapUsd: 0.03, now });
  b.reserve(0.01); b.reserve(0.01); b.reserve(0.01);
  assert.throws(() => b.reserve(0.01), BudgetError);
  const again = new Budget({ file, dailyCapUsd: 0.03, now });
  assert.equal(again.todayUsd(), 0.03);
  b.release(0.01);
  assert.equal(b.remainingUsd(), 0.01);
});

test("the daily count resets at 00:00 UTC", () => {
  let t = new Date("2026-11-27T23:59:00Z");
  const b = new Budget({ dailyCapUsd: 0.02, now: () => t });
  b.reserve(0.02);
  t = new Date("2026-11-28T00:01:00Z");
  assert.equal(b.remainingUsd(), 0.02);
});

test("per-check cap", () => {
  const c = new CheckBudget(new Budget({ dailyCapUsd: 5 }), 0.02);
  c.reserve(0.01); c.reserve(0.01);
  assert.throws(() => c.reserve(0.01), /per-check cap/);
});

function fakeNode({ answer, status = 200, header = true, amount = "10000", payTo = "0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b", message = "pay {from} {nonce} {validAfter} {validBefore}", dropPaid = false }) {
  const calls = [];
  const challenge = Buffer.from(JSON.stringify({ accepts: [{ scheme: "escrow", amount, payTo, network: "eip155:11155111", extra: { message } }] })).toString("base64");
  const fetchImpl = async (url, opts) => {
    calls.push({ url, headers: opts.headers });
    if (!opts.headers["X-PAYMENT"]) return new Response("{}", { status: 402, headers: header ? { "payment-required": challenge } : {} });
    if (dropPaid) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(answer), { status });
  };
  return { fetchImpl, calls };
}

test("402 challenge → escrow-signed retry → answer parsed with its receipt", async () => {
  const answer = { miner_id: "8818818", miner_name: "Quay", result: { vessel: "X", latitude: 1, longitude: 2, speed_knots: 3, observed_at: "2026-11-27T10:00:00Z" }, field_status: { vessel: "ok", latitude: "ok" }, input: { vessel: "X" }, signal_hash: "0xabc", cost_usd: 0.01 };
  const { fetchImpl, calls } = fakeNode({ answer });
  const budget = new Budget({ dailyCapUsd: 1 });
  const tg = new Telegraph({ privateKey: KEY, fetchImpl, budget });
  const r = await tg.ask({ intent: "VESSEL_TELEMETRY_VERIFY_GENERAL", params: { vessel: "X" }, miner: "8818818" });
  assert.equal(r.ok, true);
  assert.equal(r.miner, "Quay");
  assert.equal(r.signalUrl.endsWith("/engine/v1/signal/0xabc"), true);
  assert.equal(calls.length, 2);
  const env = JSON.parse(Buffer.from(calls[1].headers["X-PAYMENT"], "base64").toString());
  assert.equal(env.scheme, "escrow");
  assert.match(env.payload.signature, /^0x[0-9a-f]+$/);
  assert.equal(budget.todayUsd(), 0.01);
});

test("a failed delivery is released from the budget (the node does not bill it)", async () => {
  const { fetchImpl } = fakeNode({ answer: { error: "upstream error 404" }, status: 502 });
  const budget = new Budget({ dailyCapUsd: 1 });
  const tg = new Telegraph({ privateKey: KEY, fetchImpl, budget });
  const r = await tg.ask({ intent: "VESSEL_TELEMETRY_VERIFY_GENERAL", params: { vessel: "X" } });
  assert.equal(r.ok, false);
  assert.match(r.error, /upstream error 404/);
  assert.equal(budget.todayUsd(), 0);
});

test("over the daily cap: nothing is signed", async () => {
  const { fetchImpl, calls } = fakeNode({ answer: {} });
  const tg = new Telegraph({ privateKey: KEY, fetchImpl, budget: new Budget({ dailyCapUsd: 0.005 }) });
  const r = await tg.ask({ intent: "FACT_CHECK_GENERAL", params: { claim: "x" } });
  assert.equal(r.ok, false);
  assert.match(r.error, /daily cap/);
  assert.equal(calls.length, 1);
});

test("an answer with every field null is 'no data', not evidence", () => {
  const r = parseAnswer("VESSEL_TELEMETRY_VERIFY_GENERAL", "8818818", { miner_name: "Quay", result: { vessel: "EAGLE S", latitude: null, longitude: null }, field_status: { vessel: "ok", latitude: "missing" }, input: { vessel: "EAGLE S" }, signal_hash: "0x1", cost_usd: 0.01 }, null, 10);
  assert.equal(r.ok, false);
  assert.equal(r.costUsd, 0.01);
});

test("a challenge over $0.10, to another contract, or with an unfilled field is refused before signing", async () => {
  for (const opts of [{ amount: "500000" }, { payTo: "0x0000000000000000000000000000000000000001" }, { message: "pay {from} {amount} {nonce}" }]) {
    const node = fakeNode({ answer: { result: { latitude: 1, longitude: 2 } }, ...opts });
    const budget = new Budget({ dailyCapUsd: 1 });
    const r = await new Telegraph({ privateKey: KEY, budget, fetchImpl: node.fetchImpl }).ask({ intent: "X", params: {} });
    assert.equal(r.ok, false);
    assert.ok(!node.calls.some((c) => c.headers["X-PAYMENT"]), "nothing was signed and sent");
    assert.equal(budget.todayUsd(), 0);
  }
});

test("a response lost after the paid request was sent keeps its reservation (the node may have billed)", async () => {
  const node = fakeNode({ answer: {}, dropPaid: true });
  const budget = new Budget({ dailyCapUsd: 1 });
  const r = await new Telegraph({ privateKey: KEY, budget, fetchImpl: node.fetchImpl }).ask({ intent: "X", params: {} });
  assert.equal(r.ok, false);
  assert.equal(budget.todayUsd(), 0.01);
});

test("a bad cap setting or a damaged spend file never disables the cap", () => {
  assert.throws(() => new Budget({ dailyCapUsd: Number("2usd") }), /positive number/);
  assert.throws(() => new CheckBudget(new Budget({ dailyCapUsd: 1 }), NaN), /positive number/);
  const dir = mkdtempSync(join(tmpdir(), "keel-"));
  for (const body of ["{}", "null", "not json"]) {
    const file = join(dir, "spend.json");
    writeFileSync(file, body);
    const b = new Budget({ file, dailyCapUsd: 2 });
    assert.throws(() => b.reserve(0.01), BudgetError);
  }
});
