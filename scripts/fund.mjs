// Testnet only: mint Telegraph's test USDC to the bot wallet and deposit it into the escrow diamond.
// Usage: node --env-file=.env scripts/fund.mjs [mintUsd=20] [depositUsd=15]
import { createPublicClient, createWalletClient, http, parseAbi, parseUnits, formatUnits } from "viem";
import { sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.TELEGRAPH_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const DIAMOND = process.env.TELEGRAPH_DIAMOND || "0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b";
const NODE = process.env.TELEGRAPH_URL || "https://devnode.telegraphprotocol.com";
const [mintUsd = 20, depositUsd = 15] = process.argv.slice(2).map(Number);

const account = privateKeyToAccount(process.env.TELEGRAPH_PRIVATE_KEY);
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });
const usdcAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const usdc = await pub.readContract({ address: DIAMOND, abi: parseAbi(["function usdcToken() view returns (address)"]), functionName: "usdcToken" });
const wait = async (hash, what) => {
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error(`${what} reverted: ${hash}`);
  console.log(`${what}: https://sepolia.etherscan.io/tx/${hash}`);
};
let nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
const bal = await pub.readContract({ address: usdc, abi: usdcAbi, functionName: "balanceOf", args: [account.address] });
const need = parseUnits(String(depositUsd), 6);
if (bal < need) {
  await wait(await wallet.writeContract({ address: usdc, abi: usdcAbi, functionName: "mint", args: [account.address, parseUnits(String(mintUsd), 6)], nonce: nonce++ }), "mint");
}
const allowance = await pub.readContract({ address: usdc, abi: usdcAbi, functionName: "allowance", args: [account.address, DIAMOND] });
if (allowance < need) {
  await wait(await wallet.writeContract({ address: usdc, abi: usdcAbi, functionName: "approve", args: [DIAMOND, need], nonce: nonce++ }), "approve");
}
await wait(await wallet.writeContract({ address: DIAMOND, abi: parseAbi(["function depositUSDC(uint256 amount)"]), functionName: "depositUSDC", args: [need], nonce: nonce++ }), "depositUSDC");
const ledger = await (await fetch(`${NODE}/v1/ledger/account/${account.address}`)).json();
console.log("escrow ledger:", JSON.stringify(ledger));
console.log("wallet USDC now:", formatUnits(await pub.readContract({ address: usdc, abi: usdcAbi, functionName: "balanceOf", args: [account.address] }), 6));
