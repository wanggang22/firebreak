// End-to-end demo: Claude drives a real on-chain rescue.
//
// Reproduces the strongest agentic-track evidence: an LLM sits in the keeper
// loop, RANKS the vetted rescue paths, and the executor sends the plan it chose
// to a live EVM. Sizing, spend cap, and action whitelist stay deterministic, so
// the model can only pick a bounds-checked path (strict-tool enum + cheapest
// fallback). Run against the DemoSetup scenario on local anvil:
//
//   1. anvil                                         (chainId 31337)
//   2. forge script DemoSetup --broadcast            (Alice drifts to HF 1.12)
//   3. set -a; . C:/Users/ASUS/.claude-apis.env; set +a   (ANTHROPIC_API_KEY)
//      RPC=http://127.0.0.1:8545 CHAIN_ID=31337 KEEPER_PK=0x... \
//        DEPLOYMENT=deployments/local.json npx tsx src/demo.ts
//
// Writes evidence/run-local-002.json.

import { writeFileSync } from "node:fs";
import { loadDeployment } from "./config.ts";
import { tick } from "./keeper.ts";
import { makeClaudeRanker } from "./llm.ts";
import { computeCandidates } from "./strategist.ts";
import { readSignals, readTerms } from "./monitor.ts";
import { publicClient } from "./chain.ts";
import { miniLendAbi } from "./abi.ts";
import { ACTION, type Address } from "./types.ts";

const ACTION_NAME: Record<number, string> = {
  [ACTION.DELEVERAGE]: "DELEVERAGE",
  [ACTION.ROTATE]: "ROTATE",
  [ACTION.TOPUP]: "TOPUP",
};
const wad = (x: bigint) => (Number(x) / 1e18).toFixed(3);
const usdc = (x: bigint) => (Number(x) / 1e18).toFixed(2);

async function main() {
  const depPath = process.env.DEPLOYMENT ?? "deployments/local.json";
  const dep = loadDeployment(depPath);
  const keeperKey = (process.env.KEEPER_PK ?? "0x") as `0x${string}`;
  const alice = (process.env.ALICE ??
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8") as Address;

  const ranker = makeClaudeRanker();
  if (!ranker) {
    console.error("ANTHROPIC_API_KEY not set — this demo needs the LLM in the loop.");
    process.exit(2);
  }
  console.log("[demo] LLM ranking enabled (claude-opus-4-8)\n");

  // Snapshot the vetted candidate set the LLM will rank (for the evidence file).
  const [signals, terms] = await Promise.all([readSignals(dep, alice), readTerms(dep, alice)]);
  const set = computeCandidates(signals, terms);
  console.log(
    `[demo] HF ${wad(signals.hf)} < trigger ${wad(terms.hfTriggerWad)}, target ${wad(set.target)}. ${set.viable.length} viable paths:`,
  );
  for (const c of set.viable) console.log(`  · ${ACTION_NAME[c.action]}: ${c.why} (cost ${usdc(c.cost)} USDC)`);
  console.log();

  // Claude ranks → executor sends the chosen plan on-chain.
  const outcome = await tick(dep, keeperKey, alice, { ranker });
  if (!outcome.rescue) {
    console.error("[demo] no rescue executed:", outcome.memo);
    process.exit(1);
  }

  // Independent on-chain re-read of HF after the rescue (don't trust our own event).
  const hfVerified = (await publicClient().readContract({
    address: dep.pool, abi: miniLendAbi, functionName: "healthFactor", args: [alice],
  })) as bigint;

  const r = outcome.rescue;
  const chosenAction = ACTION_NAME[decodeChosen(outcome.memo)] ?? "?";
  const evidence = {
    note: "LLM in the loop: Claude (claude-opus-4-8) ranked the vetted rescue paths and the executor sent its choice to a live EVM. The deterministic core sized every path and enforced the spend cap + action whitelist BEFORE ranking, so the model's only freedom was which safe path to take.",
    network: `${dep.network} (chainId ${process.env.CHAIN_ID ?? "?"})`,
    user: alice,
    scenario: "mEURC collateral, USDC debt; EURC drifts down until HF crosses the Mandate trigger",
    trigger: wad(terms.hfTriggerWad),
    target: wad(set.target),
    model: "claude-opus-4-8",
    ranking: {
      viablePaths: set.viable.map((c) => ({
        action: ACTION_NAME[c.action], why: c.why, costUsdc: usdc(c.cost),
      })),
      chosenAction,
      memo: outcome.memo,
    },
    result: {
      hfBefore: wad(r.hfBefore),
      hfAfter: wad(r.hfAfter),
      spent: `${usdc(r.spent)} USDC`,
      txHash: r.txHash,
      explorerUrl: r.url,
      hfVerifiedOnChainAfter: `${wad(hfVerified)} (independent readContract)`,
    },
  };
  const outName = process.env.EVIDENCE ?? "run-local-002.json";
  const out = new URL(`../evidence/${outName}`, import.meta.url);
  writeFileSync(out, JSON.stringify(evidence, null, 2));
  console.log(`\n[demo] evidence → evidence/${outName}`);
}

/** Pull the chosen ACTION id back out of the memo the strategist wrote. */
function decodeChosen(memo: string): number {
  if (/chose TOP-UP|Only one viable path: TOP-UP/i.test(memo)) return ACTION.TOPUP;
  if (/chose ROTATE|Only one viable path: ROTATE/i.test(memo)) return ACTION.ROTATE;
  if (/chose DELEVERAGE|Only one viable path: DELEVERAGE/i.test(memo)) return ACTION.DELEVERAGE;
  return 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
