// Live check: hand a real drifted position with THREE viable rescue paths to
// Claude via makeClaudeRanker(), and record what it picks + why. This is the
// LLM strategist producing a real, in-bounds ranking — evidence for the
// Agentic-Economy track. Requires ANTHROPIC_API_KEY in the environment.
//
//   set -a; . C:/Users/ASUS/.claude-apis.env; set +a
//   npx tsx src/llm-live.ts

import { writeFileSync } from "node:fs";
import { WAD, ACTION, type Signals, type Terms, type Collateral, type Address } from "./types.ts";
import { computeCandidates, decideWith } from "./strategist.ts";
import { makeClaudeRanker } from "./llm.ts";

const EURC = "0x00000000000000000000000000000000000000e0" as Address;
const TBILL = "0x00000000000000000000000000000000000000b1" as Address;

function makeQuoter(reserves: Record<string, { usdc: bigint; token: bigint }>) {
  return (token: Address, amtIn: bigint): bigint => {
    const r = reserves[token.toLowerCase()];
    if (!r) return 0n;
    const inWithFee = amtIn * 997n;
    return (inWithFee * r.usdc) / (r.token * 1000n + inWithFee);
  };
}
function weighted(cs: Collateral[]): bigint {
  let w = 0n;
  for (const c of cs) w += (((c.amount * c.priceWad) / WAD) * c.ltWad) / WAD;
  return w;
}
const hfOf = (debt: bigint, cs: Collateral[]) => (debt === 0n ? 2n ** 255n : (weighted(cs) * WAD) / debt);
const wad = (x: bigint) => (Number(x) / 1e18).toFixed(3);
const usdc = (x: bigint) => (Number(x) / 1e18).toFixed(2);

async function main() {
  const ranker = makeClaudeRanker();
  if (!ranker) {
    console.error("ANTHROPIC_API_KEY not set — cannot run live LLM ranking.");
    process.exit(2);
  }

  // Alice: 1000 mEURC drifted 1.08 -> 0.98 (LT .8), debt 700, 500 USDC reserve,
  // mTBILL (LT .9) available as a rotate target. HF ~1.12, trigger 1.20.
  const cs: Collateral[] = [
    { token: EURC, symbol: "mEURC", amount: 1000n * WAD, priceWad: (98n * WAD) / 100n, ltWad: (8n * WAD) / 10n, isStable: false },
    { token: TBILL, symbol: "mTBILL", amount: 0n, priceWad: WAD, ltWad: (9n * WAD) / 10n, isStable: true },
  ];
  const debt = 700n * WAD;
  const reserves = {
    [EURC.toLowerCase()]: { usdc: 50_000n * WAD, token: 46_296n * WAD },
    [TBILL.toLowerCase()]: { usdc: 50_000n * WAD, token: 50_000n * WAD },
  };
  const s: Signals = { user: EURC, hf: hfOf(debt, cs), debt, collaterals: cs, quoteUsdcOut: makeQuoter(reserves) };
  const t: Terms = {
    hfTriggerWad: (12n * WAD) / 10n,
    maxSpendPerRescue: 10_000n * WAD,
    maxSlippageWad: WAD,
    minImprovementWad: 0n,
    keeperFee: 0n,
    allowedActions: ACTION.DELEVERAGE | ACTION.ROTATE | ACTION.TOPUP,
    reserve: 500n * WAD,
  };

  const set = computeCandidates(s, t);
  console.log(`HF ${wad(s.hf)} < trigger ${wad(t.hfTriggerWad)}, target ${wad(set.target)}. ${set.viable.length} viable paths:`);
  for (const c of set.viable) console.log(`  · action ${c.action}: ${c.why} (cost ${usdc(c.cost)} USDC)`);

  console.log("\nAsking Claude to rank...\n");
  const decision = await decideWith(s, t, ranker);
  console.log(`[strategist/llm] ${decision.memo}\n`);
  console.log(`chosen action: ${decision.plan?.action ?? "none"}`);

  const evidence = {
    scenario: "FX drift EURC 1.08->0.98, three viable rescue paths, LLM ranks",
    model: "claude-opus-4-8",
    hf: wad(s.hf),
    trigger: wad(t.hfTriggerWad),
    target: wad(set.target),
    viable: set.viable.map((c) => ({ action: c.action, why: c.why, costUsdc: usdc(c.cost) })),
    chosenAction: decision.plan?.action ?? null,
    memo: decision.memo,
  };
  const out = new URL("../evidence/llm-rank-001.json", import.meta.url);
  writeFileSync(out, JSON.stringify(evidence, null, 2));
  console.log(`\nevidence → evidence/llm-rank-001.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
