# Keel: the judges' checklist

Each line is something you can check yourself, and what you should see. Nothing here needs a wallet except the last section.

## In Telegram (two minutes, nothing to install)

| # | Do this | You should see |
|---|---|---|
| 1 | Open [@keel567_bot](https://t.me/keel567_bot), press **Start** | What Keel does, and the commands |
| 2 | Paste `BREAKING: ferry VIKING GLORY hit by a drone and sinking in the Baltic` | `🔎 Checking…` at once, then `⚠️ Tracking disagrees with the rumour`, two positions from two operators, the speed, a map pin, and four `receipt` links |
| 3 | Tap any `receipt` link | The signal on the Telegraph node: payer `0x2925…DAEd4`, the miner, the request, the raw answer |
| 4 | Paste `Houthis claim missile hit on container ship HULDA MAERSK in the Red Sea` | `⚠️ disagrees`: the ship is in the North Sea, thousands of km from the Red Sea |
| 5 | Paste `Sanctioned tanker ADRIAN DARYA 1 seized by IRGC in the Strait of Hormuz` | `❓ Can't verify from tracking`, each tracker's reason for having no position, and `🚩 Sanctions:` naming both sources |
| 6 | Paste `Iran closed the Strait of Hormuz to all shipping today` | Only a fact-check is bought; the reply says no ship was named |
| 7 | Send `good morning` | Nothing is bought; it explains what it needs |
| 8 | Paste the step 2 rumour again within 10 minutes | The same answer, marked as reused, nothing paid again |
| 9 | Press **👁 Watch this ship**, then `/watches` | The ship is listed; `/unwatch` removes it |
| 10 | `/receipts` and `/stats` | This chat's last checks with receipts; totals across all chats |
| 11 | Open the [keelverdict group](https://t.me/+Kzl7YJUEUedhZmY1) | The public verdict feed (no one's identity is shown) |

Times vary with the testnet: a check usually takes 10 to 30 seconds.

## From the repo (no key needed)

| Command | Expected |
|---|---|
| `npm ci && npm test` | `pass 56`, `fail 0`, no network |
| `node scripts/verify-receipts.mjs` | `signals 22 · verified 22 · not found 0 · mismatched 0` (plus any receipts added since) |
| `node scripts/dashboard.mjs` | Rebuilds `docs/index.html`, the receipts dashboard |

## With a funded testnet key (spends a few cents of test USDC)

| Command | Expected |
|---|---|
| `npm run check -- "ferry VIKING GLORY went dark near the Aland Islands"` | `⚠️ disagrees`: it was transmitting minutes ago |
| `node --env-file=.env scripts/evidence.mjs` | The six-row table in the README, re-run live (about $0.22) |
| `TELEGRAPH_PRIVATE_KEY=0x... node examples/buy-position.mjs` | One paid position and its verified receipt ([tutorial](docs/TUTORIAL.md)) |

## What it should refuse to do

- Call a rumour false on tracking alone. The strongest verdict is "tracking disagrees", and attack or fire claims against a stopped ship stay "can't verify".
- Report "no sanctions" when the screen failed. It says "not a clean bill".
- Count a tracker's empty answer as evidence.
- Spend more than $0.30 on one check or $2 in a UTC day.
- React to chatter in a group. Only `/check` or a mention starts a check.

## Known gaps (stated, not hidden)

- Gulf tracking coverage is thin, and the Baltic is the only sea with two operators.
- Tracking cannot see damage. Fact-check miners rarely know about fresh events.
- Photos uploaded to Telegram are not sent for forensics, because their file link contains the bot token.
