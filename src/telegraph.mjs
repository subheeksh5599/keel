// Telegraph client: asks the testnet node and pays from the bot's escrow balance.
// The escrow signature proves intent only; it cannot move funds. The node bills only delivered answers.
// Escrow header format follows telegraphprotocol/telegraph-mcp (MIT), src/pay.ts.
import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";

export const NODE = process.env.TELEGRAPH_URL || "https://devnode.telegraphprotocol.com";
export const MAX_ASK_USD = 0.1; // no single answer is worth more than this to Keel
const ESCROW_DIAMOND = (process.env.TELEGRAPH_ESCROW || "0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b").toLowerCase();
const EXPECTED_NETWORKS = new Set(["eip155:11155111", "11155111", "sepolia", "ethereum-sepolia"]);

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
        // Refuse a challenge that is not what Keel expects to pay, before anything is signed.
        if (!(priceUsd > 0) || priceUsd > MAX_ASK_USD) return fail(intent, miner, 402, `refused: the node asked $${priceUsd}, over the $${MAX_ASK_USD} per-answer limit`, started);
        if (escrow.network && !EXPECTED_NETWORKS.has(String(escrow.network))) return fail(intent, miner, 402, `refused: unexpected payment network ${escrow.network}`, started);
        if (escrow.payTo && String(escrow.payTo).toLowerCase() !== ESCROW_DIAMOND) return fail(intent, miner, 402, `refused: unexpected escrow contract ${escrow.payTo}`, started);
        budget?.reserve(priceUsd);
        let delivered = false;
        let ambiguous = false;
        try {
          const header = await this.escrowHeader(escrow);
          ambiguous = true; // from here the node may bill even if the response is lost
          res = await send({ "X-PAYMENT": header });
          ambiguous = false;
          delivered = res.ok;
        } finally {
          // A lost response after the paid request was sent keeps its reservation: the cap must never under-count.
          if (!delivered && !ambiguous) budget?.release(priceUsd);
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
    if (/\{[a-zA-Z_]+\}/.test(message)) throw new Error("the escrow message has a field Keel does not fill; refusing to sign");
    const signature = await this.account.signMessage({ message });
    const envelope = { x402Version: 2, scheme: "escrow", network: req.network, payload: { signature, authorization } };
    return Buffer.from(JSON.stringify(envelope)).toString("base64");
  }

  async escrowBalance() {
    const r = await this.fetch(`${this.node}/v1/ledger/account/${this.account.address}`, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`ledger read failed: HTTP ${r.status}`);
    const j = await r.json();
    return { availableUsd: Number(j.available ?? 0) / 1e6, chargedUsd: Number(j.charged ?? 0) / 1e6 };
  }

  // The public signal record behind a receipt (free, no key): who paid, which miner, the miner's full raw answer,
  // and the node's keccak256 commitment check. The paid answer is trimmed to the intent's fields; this is not.
  async signal(hash) {
    if (!hash) return null;
    try {
      const r = await this.fetch(`${this.node}/engine/v1/signal/${hash}`, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) return null;
      const j = await r.json();
      return {
        raw: j?.result?.execution?.result || j?.payload?.response || null,
        payer: j?.signal?.wallet_address || j?.payload?.wallet_address || null,
        miner: j?.signal?.miner_slug || null,
        intent: j?.signal?.intent_id || null,
        verified: j?.verification?.verified === true,
        createdAt: j?.signal?.created_at || null,
      };
    } catch {
      return null;
    }
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
