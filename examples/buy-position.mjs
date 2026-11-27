// Buy one live ship position from a named Telegraph miner, paid from escrow, then read its public receipt.
// Standalone: needs only viem and a testnet key with an escrow balance (see docs/TUTORIAL.md).
// Usage: TELEGRAPH_PRIVATE_KEY=0x... node examples/buy-position.mjs "VIKING GLORY"
import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";

const NODE = "https://devnode.telegraphprotocol.com";
const account = privateKeyToAccount(process.env.TELEGRAPH_PRIVATE_KEY);
const vessel = process.argv[2] || "VIKING GLORY";
const url = `${NODE}/engine/v1/ask/8818818`; // pin one miner by id; drop "/8818818" to let the node route
const body = JSON.stringify({ intent: "VESSEL_TELEMETRY_VERIFY_GENERAL", params: { vessel } });
const post = (headers = {}) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });

// 1. The first ask is refused with 402 and a payment challenge.
const first = await post();
const required = JSON.parse(Buffer.from(first.headers.get("payment-required"), "base64").toString());
const req = required.accepts.find((a) => a.scheme === "escrow");

// 2. Sign the node's message template. This proves intent; it cannot move funds. It expires in 60 s.
const now = Math.floor(Date.now() / 1000);
const auth = { from: account.address, to: req.payTo, value: req.amount, validAfter: String(now - 10), validBefore: String(now + 60), nonce: "0x" + randomBytes(32).toString("hex") };
const message = req.extra.message.replaceAll("{from}", auth.from.toLowerCase()).replaceAll("{nonce}", auth.nonce)
  .replaceAll("{validAfter}", auth.validAfter).replaceAll("{validBefore}", auth.validBefore);
const signature = await account.signMessage({ message });
const payment = Buffer.from(JSON.stringify({ x402Version: 2, scheme: "escrow", network: req.network, payload: { signature, authorization: auth } })).toString("base64");

// 3. Ask again with the signature. The escrow is billed only if an answer is delivered.
const res = await post({ "X-PAYMENT": payment });
const answer = await res.json();
console.log(`price $${Number(req.amount) / 1e6} · miner ${answer.miner_name} · status ${res.status}`);
console.log("answer:", answer.result);

// 4. The receipt is a public signal: free to read, no key. It holds the miner's full raw answer.
const sig = await (await fetch(`${NODE}/engine/v1/signal/${answer.signal_hash}`)).json();
const raw = sig.result?.execution?.result || sig.payload?.response || {};
console.log(`receipt ${NODE}/engine/v1/signal/${answer.signal_hash}`);
console.log(`paid by ${sig.signal?.wallet_address} · verified ${sig.verification?.verified} · IMO ${raw.imo} · MMSI ${raw.mmsi} · status ${raw.nav_status}`);
