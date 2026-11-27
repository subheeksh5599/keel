# Buy a live ship position on Telegraph in about 40 lines

This walks through [`examples/buy-position.mjs`](../examples/buy-position.mjs): one paid ask to a named ship-tracking miner on the Telegraph testnet, then a free read of its public receipt. It is the same flow Keel uses for every check, with nothing else around it.

## What you need

- Node 20 or newer, and `npm i viem`.
- A fresh testnet private key. Never use a key that holds real funds.
- About 0.01 Sepolia ETH on that key for gas, to fund the escrow once.
- Test USDC in the Telegraph escrow. From this repo, `npm run fund -- 20 15` mints 20 test USDC (contract `0xcc194e1a843B658526D0D5C431f670028582Ae17`, anyone can mint) and deposits 15. Circle's faucet USDC is a different token and the escrow does not take it.

## Run it

```bash
TELEGRAPH_PRIVATE_KEY=0x... node examples/buy-position.mjs "VIKING GLORY"
```

Real output, 27 Nov 2026:

```
price $0.01 · miner Quay · status 200
answer: {
  vessel: 'VIKING GLORY',
  speed_knots: 20.8,
  latitude: 60.08184166666667,
  longitude: 20.939796666666666,
  course_deg: 270.6,
  observed_at: '2026-11-27T09:26:28.000Z'
}
receipt https://devnode.telegraphprotocol.com/engine/v1/signal/0x13f3a1bbbbff3f634cf23edb79f1df867edef60e6039670cc64785192095d5e7
paid by 0x2925d43c1e21888706d8b3b2223050af14ddaed4 · verified true · IMO 9827877 · MMSI 230041000 · status under way using engine
```

## What each step does

1. **Ask, and get refused.** `POST /engine/v1/ask/8818818` with `{ intent, params }`. The node answers `402` and a base64 `payment-required` header. Inside it, the `escrow` option carries the price (`amount`, in millionths of a dollar), the payee, and a message template to sign.
2. **Sign the template.** Fill `{from}`, `{nonce}`, `{validAfter}` and `{validBefore}`, then sign it with `signMessage` (EIP-191). The signature says "I agree to pay this much for this ask in the next 60 seconds". It is not a transfer and cannot move funds.
3. **Ask again with `X-PAYMENT`.** The header is the base64 of `{ x402Version: 2, scheme: "escrow", network, payload: { signature, authorization } }`. The node runs the miner and bills the escrow only if the answer is delivered.
4. **Read the receipt.** `GET /engine/v1/signal/<signal_hash>` needs no key. It shows the paying wallet, the miner, the request, the miner's full answer, and `verification.verified`, the node's keccak256 commitment check.

## Three things that will catch you out

- **An empty answer is still a 200, and it is billed.** A miner that has not heard the ship returns `latitude: null`. Treat that as "no data", never as "the ship is nowhere".
- **The paid answer is trimmed to the intent's fields; the signal is not.** Position, speed, course and time come back in the paid answer. The IMO, the MMSI, the status the ship broadcasts and how many ships share the name are only in the signal record (step 4).
- **Pinning versus routing.** `/engine/v1/ask/<minerId>` asks one miner. `/engine/v1/ask` lets the node pick the best-ranked one. Keel pins two trackers from different operators so their agreement means something, and routes only as a fallback.

## Where to go next

- `GET /engine/v1/intents` lists every intent and its fields.
- `GET /api/miners` lists miners, with ids, operators and the intents they serve.
- `GET /v1/ledger/account/<address>` shows your escrow balance and what has been charged.
- `src/telegraph.mjs` in this repo is the same flow with spending caps, timeouts and empty-answer handling.
