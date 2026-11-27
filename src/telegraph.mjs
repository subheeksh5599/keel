// Telegraph client: asks the testnet node and pays from the bot's escrow balance.
// The escrow signature proves intent only; it cannot move funds. The node bills only delivered answers.
// Escrow header format follows telegraphprotocol/telegraph-mcp (MIT), src/pay.ts.
import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";

export const NODE = process.env.TELEGRAPH_URL || "https://devnode.telegraphprotocol.com";

export class Telegraph {
  constructor({ privateKey, node = NODE, budget, fetchImpl = fetch } = {}) {
    if (!privateKey) throw new Error("TELEGRAPH_PRIVATE_KEY is not set");
    this.account = privateKeyToAccount(privateKey);
    this.node = node;
    this.budget = budget; // a Budget instance (spend caps), optional
    this.fetch = fetchImpl;
  }

  // Ask one named miner (pinned) or let the node route (miner omitted).
  // Returns { ok, status, intent, miner, answer, signal, costUsd, latencyMs, error }.
  async ask({ intent, params, miner, maxBudgetUsdc, timeoutMs = 60_000, budget = this.budget }) {
    const path = miner ? `/engine/v1/ask/${encodeURIComponent(miner)}` : "/engine/v1/ask";
    const body = { intent, params, ...(maxBudgetUsdc ? { max_budget_usdc: maxBudgetUsdc } : {}) };
    const started = Date.now();
    const send = (headers = {}) =>
      this.fetch(this.node + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    let res;
    try {
      res = await send();
      if (res.status === 402) {
        const required = decodeRequired(res.headers.get("payment-required"));
        const escrow = (required?.accepts || []).find((a) => a.scheme === "escrow");
        if (!escrow) return fail(intent, miner, 402, "the node offered no escrow payment", started);
        const priceUsd = Number(escrow.amount ?? 0) / 1e6;
        budget?.reserve(priceUsd);
        let delivered = false;
        try {
          res = await send({ "X-PAYMENT": await this.escrowHeader(escrow) });
          delivered = res.ok;
        } finally {
          if (!delivered) budget?.release(priceUsd);
        }
      }
    } catch (e) {
      return fail(intent, miner, 0, e.name === "TimeoutError" ? "timed out" : String(e.message || e), started);
    }
    const json = await readJson(res);
    const latencyMs = Date.now() - started;
    if (!res.ok) return fail(intent, miner, res.status, errorText(json), started);
    const receipt = decodeRequired(res.headers.get("x-payment-response") || res.headers.get("payment-response"));
    return parseAnswer(intent, miner, json, receipt, latencyMs, this.node);
  }

  async escrowHeader(req) {
    const template = String(req?.extra?.message || "");
    if (!template) throw new Error("the escrow challenge has no message to sign");
    const now = Math.floor(Date.now() / 1000);
    const authorization = {
      from: this.account.address,
      to: req.payTo,
      value: req.amount,
      validAfter: String(now - 10),
      validBefore: String(now + 60),
      nonce: "0x" + randomBytes(32).toString("hex"),
    };
    const message = template
      .replaceAll("{from}", authorization.from.toLowerCase())
      .replaceAll("{nonce}", authorization.nonce)
      .replaceAll("{validAfter}", authorization.validAfter)
      .replaceAll("{validBefore}", authorization.validBefore);
    const signature = await this.account.signMessage({ message });
    const envelope = { x402Version: 2, scheme: "escrow", network: req.network, payload: { signature, authorization } };
    return Buffer.from(JSON.stringify(envelope)).toString("base64");
  }

  async escrowBalance() {
    const r = await this.fetch(`${this.node}/v1/ledger/account/${this.account.address}`, { signal: AbortSignal.timeout(20_000) });
    const j = await r.json();
    return { availableUsd: Number(j.available ?? 0) / 1e6, chargedUsd: Number(j.charged ?? 0) / 1e6 };
  }
}

export function signalUrl(hash, node = NODE) {
  return hash ? `${node}/engine/v1/signal/${hash}` : null;
}

// The node's answer: { miner_id, miner_name, result, field_status, signal_hash, cost_usd, warnings, ... }.
// A miner that has nothing returns 200 with every scored field null: that is "no answer", never evidence.
export function parseAnswer(intent, miner, json, receipt, latencyMs, node = NODE) {
  const answer = json?.result ?? json?.execution?.result ?? null;
  const signal = json?.signal_hash || json?.signal?.hash || null;
  const fieldStatus = json?.field_status || {};
  const inputs = new Set(Object.keys(json?.input || {}));
  const answered = Object.entries(fieldStatus).filter(([k, v]) => v === "ok" && !inputs.has(k)).map(([k]) => k);
  const hasValues = answer && typeof answer === "object"
    ? Object.entries(answer).some(([k, v]) => !inputs.has(k) && v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0))
    : answer != null;
  const billed = Array.isArray(json?.fulfillment?.payments) && json.fulfillment.payments.length
    ? json.fulfillment.payments.reduce((s, p) => s + Number(p?.amount_uusdc || 0), 0) / 1e6
    : receipt?.amount_uusdc != null ? Number(receipt.amount_uusdc) / 1e6 : Number(json?.cost_usd_total ?? json?.cost_usd ?? 0);
  const ok = Boolean(hasValues && (answered.length > 0 || Object.keys(fieldStatus).length === 0));
  return {
    ok,
    status: 200,
    intent,
    miner: json?.miner_name || json?.routing?.miner_slug || (miner ? String(miner) : null),
    minerId: json?.miner_id ? String(json.miner_id) : miner ? String(miner) : null,
    answer,
    fieldStatus,
    warnings: json?.warnings || [],
    signal,
    signalUrl: signalUrl(signal, node),
    costUsd: Number.isFinite(billed) ? billed : 0,
    latencyMs,
    error: ok ? null : "the miner had no data for this",
  };
}

function fail(intent, miner, status, error, started) {
  return { ok: false, status, intent, miner: miner ? String(miner) : null, minerId: miner ? String(miner) : null, answer: null, fieldStatus: {}, warnings: [], signal: null, signalUrl: null, costUsd: 0, latencyMs: Date.now() - started, error };
}

function decodeRequired(header) {
  if (!header) return null;
  try { return JSON.parse(Buffer.from(header, "base64").toString("utf8")); } catch { return null; }
}

async function readJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { message: text.slice(0, 300) }; }
}

function errorText(j) {
  const m = j?.error || j?.message || j?.reason || "request failed";
  return String(typeof m === "string" ? m : JSON.stringify(m)).slice(0, 240);
}
