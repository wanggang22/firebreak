// Pure test of the LLM-ranking harness (decideWith) with an INJECTED ranker —
// no network, no key, no chain. Proves the safety contract that lets us hand
// path selection to an LLM: it can only ever pick a vetted candidate, and any
// deviation (out-of-set pick, thrown error) falls back to the cheapest path, so
// the model can never make the position worse or stall a rescue.
//
//   run: npx tsx src/strategist-llm.test.ts   (exit 0 = pass)

import { WAD, ACTION, type Signals, type Terms, type Collateral, type Address } from "./types.ts";
import { decideWith, computeCandidates, type Ranker } from "./strategist.ts";

const EURC = "0x00000000000000000000000000000000000000e0" as Address;
const TBILL = "0x00000000000000000000000000000000000000b1" as Address;

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${detail}`); }
}

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
function hfOf(debt: bigint, cs: Collateral[]): bigint {
  return debt === 0n ? 2n ** 255n : (weighted(cs) * WAD) / debt;
}

// A drifted position where all three paths are viable: reserve for TOPUP, a
// higher-LT stable for ROTATE, and enough collateral to DELEVERAGE.
function situation() {
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
    allowedActions: ACTION.DELEVERAGE | ACTION.ROTATE | ACTION.TOPUP,
    reserve: 500n * WAD,
  };
  return { s, t };
}

console.log("LLM-ranking harness — honors valid picks, falls back safely\n");

// Confirm the fixture really offers a multi-way choice (so ranking is exercised).
{
  const { s, t } = situation();
  const set = computeCandidates(s, t);
  check("fixture yields >1 viable path to rank", set.viable.length >= 2, `viable=${set.viable.length}`);
}

// 1. A valid LLM pick is honored even when it's NOT the cheapest.
{
  const { s, t } = situation();
  const set = computeCandidates(s, t);
  const cheapest = set.viable.reduce((a, b) => (b.cost < a.cost ? b : a));
  const dearer = set.viable.find((c) => c.action !== cheapest.action)!;
  const ranker: Ranker = async () => ({ chosenAction: dearer.action, reasoning: "keeping market exposure is worth the fee here" });
  const d = await decideWith(s, t, ranker);
  check("valid pick honored (chose the non-cheapest path)", d.plan?.action === dearer.action, `action=${d.plan?.action}`);
  check("memo carries the LLM reasoning", d.memo.includes("keeping market exposure"), d.memo);
}

// 2. An out-of-set action falls back to the cheapest — the model can't force an
//    action that wasn't vetted.
{
  const { s, t } = situation();
  const set = computeCandidates(s, t);
  const cheapest = set.viable.reduce((a, b) => (b.cost < a.cost ? b : a));
  const ranker: Ranker = async () => ({ chosenAction: 999, reasoning: "invent an action" });
  const d = await decideWith(s, t, ranker);
  check("out-of-set pick falls back to cheapest", d.plan?.action === cheapest.action, `action=${d.plan?.action}`);
  check("memo notes the fallback", d.memo.includes("not in the viable set"), d.memo);
}

// 3. A thrown ranker (network/API failure) falls back to the cheapest — a rescue
//    is never stalled by the LLM being down.
{
  const { s, t } = situation();
  const set = computeCandidates(s, t);
  const cheapest = set.viable.reduce((a, b) => (b.cost < a.cost ? b : a));
  const ranker: Ranker = async () => { throw new Error("429 overloaded"); };
  const d = await decideWith(s, t, ranker);
  check("ranker error falls back to cheapest", d.plan?.action === cheapest.action, `action=${d.plan?.action}`);
  check("memo notes ranking was unavailable", d.memo.includes("LLM ranking unavailable"), d.memo);
}

// 4. Below trigger: no rescue, ranker never called.
{
  const { s, t } = situation();
  const safe: Terms = { ...t, hfTriggerWad: (10n * WAD) / 100n }; // 0.1 — HF is above it
  let called = false;
  const ranker: Ranker = async () => { called = true; return { chosenAction: ACTION.TOPUP, reasoning: "x" }; };
  const d = await decideWith(s, safe, ranker);
  check("no rescue when above trigger", d.plan === null);
  check("ranker not called when untriggered", called === false);
}

// 5. Single viable path: skip the LLM entirely (nothing to rank).
{
  const { s, t } = situation();
  const only: Terms = { ...t, allowedActions: ACTION.DELEVERAGE, reserve: 0n }; // just one path
  let called = false;
  const ranker: Ranker = async () => { called = true; return { chosenAction: ACTION.DELEVERAGE, reasoning: "x" }; };
  const d = await decideWith(s, only, ranker);
  check("single viable path produces a plan", d.plan?.action === ACTION.DELEVERAGE);
  check("ranker skipped when only one path", called === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
