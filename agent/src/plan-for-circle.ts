// Produce the rescue plan for execution through a Circle Agent Wallet.
//
// The decision path is unchanged: monitor reads real on-chain state, the
// deterministic core sizes + bounds-checks every allowed path, and Claude ranks
// only that vetted set. The single difference is who signs — instead of a raw
// private key via viem, the chosen plan is handed to `circle wallet execute`,
// so the keeper runs on Circle Agent Wallet infrastructure on Arc.
//
//   set -a; . C:/Users/ASUS/.claude-apis.env; set +a
//   RPC=https://rpc.testnet.arc.network CHAIN_ID=5042002 \
//     DEPLOYMENT=deployments/testnet-agentwallet.json npx tsx src/plan-for-circle.ts
//
// Prints the exact `circle wallet execute` invocation and writes the decision
// to evidence/ so the memo is captured before the tx is sent.

import { writeFileSync } from "node:fs";
import { loadDeployment } from "./config.ts";
import { readSignals, readTerms, rpcRetry } from "./monitor.ts";
import { computeCandidates, decideWith, spendOf } from "./strategist.ts";
import { makeClaudeRanker } from "./llm.ts";
import { publicClient } from "./chain.ts";
import { miniSwapAbi } from "./abi.ts";
import { ACTION, type Address } from "./types.ts";

const ACTION_NAME: Record<number, string> = {
  [ACTION.DELEVERAGE]: "DELEVERAGE",
  [ACTION.ROTATE]: "ROTATE",
  [ACTION.TOPUP]: "TOPUP",
};
const wad = (x: bigint) => (Number(x) / 1e18).toFixed(3);
const usdc = (x: bigint) => (Number(x) / 1e18).toFixed(2);

async function main() {
  const depPath = process.env.DEPLOYMENT ?? "deployments/testnet-agentwallet.json";
  const dep = loadDeployment(depPath);
  const user = (process.env.ALICE ?? "0x20E40d46631026891D89CA1d33a94073D561B23B") as Address;
  const keeper = process.env.KEEPER_ADDR ?? "";

  const [signals, terms] = await Promise.all([readSignals(dep, user), readTerms(dep, user)]);
  const set = computeCandidates(signals, terms);
  console.log(`[monitor] HF ${wad(signals.hf)} vs trigger ${wad(terms.hfTriggerWad)} · debt ${usdc(signals.debt)} USDC`);
  if (!set.triggered) {
    console.log("[strategist] above trigger — no rescue needed.");
    process.exit(2);
  }
  console.log(`[strategist] ${set.viable.length} viable paths, target ${wad(set.target)}:`);
  for (const c of set.viable) console.log(`  · ${ACTION_NAME[c.action]}: ${c.why} (cost ${usdc(c.cost)} USDC)`);

  const ranker = makeClaudeRanker();
  if (!ranker) { console.error("ANTHROPIC_API_KEY not set."); process.exit(2); }
  const decision = await decideWith(signals, terms, ranker);
  if (!decision.plan) { console.error("[strategist] no plan: " + decision.memo); process.exit(1); }
  let p = decision.plan;

  // ROTATE's second-leg slippage guard depends on leg-1 proceeds, so the
  // strategist leaves it 0 for the executor to fill from a fresh quote. On the
  // viem path executor.finalizePlan does this; the Circle path prints the tuple
  // directly, so fill it here — otherwise leg 2 would execute with min-out 0.
  if (p.action === ACTION.ROTATE) {
    const usdcOut = signals.quoteUsdcOut(p.collateralToken, p.collateralAmount);
    const tokenOut = (await rpcRetry(() => publicClient().readContract({
      address: dep.amm, abi: miniSwapAbi, functionName: "getTokenOut", args: [p.rotateTo, usdcOut],
    }))) as bigint;
    p = { ...p, minSwapOut2: (tokenOut * 99n) / 100n };
  }

  console.log(`\n[strategist/llm] ${decision.memo}`);

  // Solidity: rescueFlat(user, action, collateralToken, collateralAmount, rotateTo, minSwapOut, minSwapOut2, topUpAmount)
  const sig = "rescueFlat(address,uint8,address,uint256,address,uint256,uint256,uint256)";
  const args = `${user} ${p.action} ${p.collateralToken} ${p.collateralAmount} ${p.rotateTo} ${p.minSwapOut} ${p.minSwapOut2} ${p.topUpAmount}`;

  console.log(`\n── execute through the Circle Agent Wallet ──`);
  console.log(`circle wallet execute "${sig}" \\\n  ${args} \\\n  --contract ${dep.mandate} --address ${keeper} --chain ARC-TESTNET -o json`);

  const out = {
    note: "Decision produced by the unchanged Firebreak pipeline (deterministic sizing + spend-cap filter, then Claude ranks the vetted set). Execution is handed to a Circle Agent Wallet via `circle wallet execute` instead of a raw private key.",
    network: dep.network,
    user,
    keeperAgentWallet: keeper,
    mandate: dep.mandate,
    hfBefore: wad(signals.hf),
    trigger: wad(terms.hfTriggerWad),
    target: wad(set.target),
    model: "claude-opus-4-8",
    viable: set.viable.map((c) => ({ action: ACTION_NAME[c.action], why: c.why, costUsdc: usdc(c.cost) })),
    chosenAction: ACTION_NAME[p.action],
    plannedSpendUsdc: usdc(spendOf(p, signals)),
    memo: decision.memo,
    call: { signature: sig, args, contract: dep.mandate },
  };
  writeFileSync(new URL("../evidence/agentwallet-plan.json", import.meta.url), JSON.stringify(out, null, 2));
  console.log(`\nplan → evidence/agentwallet-plan.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
