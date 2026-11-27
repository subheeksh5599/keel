// One live paid ask, printed raw, to confirm the node's answer shape.
// Usage: node --env-file=.env scripts/probe.mjs <INTENT> '<params json>' [minerId]
import { Telegraph } from "../src/telegraph.mjs";

const [intent, params, miner] = process.argv.slice(2);
const tg = new Telegraph({ privateKey: process.env.TELEGRAPH_PRIVATE_KEY });
const r = await tg.ask({ intent, params: JSON.parse(params), miner });
console.log(JSON.stringify(r, null, 2));
console.log("escrow:", await tg.escrowBalance());
