// Pure test of the strategist: build a drifted position, ask for a decision,
// simulate applying the returned plan with the SAME math MiniLend uses on-chain,
// and assert the rescue lifts HF back above the trigger. No chain, no LLM.
//
//   run: npx tsx src/strategist.test.ts   (exit 0 = pass)

import { WAD, ACTION, ZERO_ADDR, type Signals, type Terms, type Collateral, type Address, type Plan } from "./types.ts";
import { decide, spendOf } from "./strategist.ts";

const EURC = "0x00000000000000000000000000000000000000e0" as Address;
const TBILL = "0x00000000000000000000000000000000000000b1" as Address;

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${detail}`); }
}

// constant-product quote matching MiniSwap.getUsdcOut (0.3% fee)
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
  if (debt === 0n) return 2n ** 255n;
  return (weighted(cs) * WAD) / debt;
}

// Apply a plan to a local (debt, collaterals) mirror, using the quoter for swaps.
function simulate(
  debt: bigint, cs: Collateral[], reserve: bigint, plan: Plan,
  quote: (t: Address, a: bigint) => bigint,
  quoteToken: (t: Address, usdcIn: bigint) => bigint,
): { debt: bigint; cs: Collateral[]; reserve: bigint } {
  cs = cs.map((c) => ({ ...c }));
  if (plan.action === ACTION.TOPUP) {
    const pay = plan.topUpAmount > debt ? debt : plan.topUpAmount;
    return { debt: debt - pay, cs, reserve: reserve - pay };
  }
  const src = cs.find((c) => c.token === plan.collateralToken)!;
  src.amount -= plan.collateralAmount;
  const usdcOut = quote(plan.collateralToken, plan.collateralAmount);
  if (plan.action === ACTION.DELEVERAGE) {
    const pay = usdcOut > debt ? debt : usdcOut;
    return { debt: debt - pay, cs, reserve: reserve + (usdcOut - pay) };
  }
  // ROTATE: usdcOut -> buy target token -> add as collateral
  const tokOut = quoteToken(plan.rotateTo, usdcOut);
  const tgt = cs.find((c) => c.token === plan.rotateTo)!;
  tgt.amount += tokOut;
  return { debt, cs, reserve };
}

function scenario() {
  // Alice: 1000 mEURC @1.08 (LT .8) + 0 mTBILL (LT .9), debt 700. Then drift to 0.98.
  const cs: Collateral[] = [
    { token: EURC, symbol: "mEURC", amount: 1000n * WAD, priceWad: (98n * WAD) / 100n, ltWad: (8n * WAD) / 10n, isStable: false },
    { token: TBILL, symbol: "mTBILL", amount: 0n, priceWad: WAD, ltWad: (9n * WAD) / 10n, isStable: true },
  ];
  const debt = 700n * WAD;
  const reserves: Record<string, { usdc: bigint; token: bigint }> = {
    [EURC.toLowerCase()]: { usdc: 50_000n * WAD, token: 46_296n * WAD },
    [TBILL.toLowerCase()]: { usdc: 50_000n * WAD, token: 50_000n * WAD },
  };
  const quote = makeQuoter(reserves);
  const quoteToken = (token: Address, usdcIn: bigint): bigint => {
    const r = reserves[token.toLowerCase()];
    const inWithFee = usdcIn * 997n;
    return (inWithFee * r.token) / (r.usdc * 1000n + inWithFee);
  };
  return { cs, debt, reserves, quote, quoteToken };
}

const fmt = (w: bigint) => (Number(w) / 1e18).toFixed(3);

console.log("strategist sizing — restores HF above trigger for each path\n");
const trigger = (12n * WAD) / 10n; // 1.2

// sanity: drifted HF is below trigger
{
  const { cs, debt } = scenario();
  const hf = hfOf(debt, cs);
  check("drifted position is under-water vs trigger", hf < trigger, `HF=${fmt(hf)}`);
  console.log(`    drifted HF = ${fmt(hf)} (trigger ${fmt(trigger)})`);
}

// DELEVERAGE only
{
  const { cs, debt, quote, quoteToken } = scenario();
  const s: Signals = { user: EURC, hf: hfOf(debt, cs), debt, collaterals: cs, quoteUsdcOut: quote };
  const t: Terms = { hfTriggerWad: trigger, maxSpendPerRescue: 10_000n * WAD, maxSlippageWad: WAD, minImprovementWad: 0n, allowedActions: ACTION.DELEVERAGE, reserve: 0n };
  const d = decide(s, t);
  check("deleverage: plan produced", d.plan !== null);
  if (d.plan) {
    const after = simulate(debt, cs, 0n, d.plan, quote, quoteToken);
    const hf2 = hfOf(after.debt, after.cs);
    check("deleverage: HF restored above trigger", hf2 >= trigger, `HF=${fmt(hf2)}`);
    console.log(`    ${d.memo}\n    → HF ${fmt(hfOf(debt, cs))} → ${fmt(hf2)}`);
  }
}

// TOPUP preferred when reserve available (cheapest)
{
  const { cs, debt, quote } = scenario();
  const s: Signals = { user: EURC, hf: hfOf(debt, cs), debt, collaterals: cs, quoteUsdcOut: quote };
  const t: Terms = { hfTriggerWad: trigger, maxSpendPerRescue: 10_000n * WAD, maxSlippageWad: WAD, minImprovementWad: 0n, allowedActions: ACTION.DELEVERAGE | ACTION.TOPUP, reserve: 500n * WAD };
  const d = decide(s, t);
  check("topup: chosen over deleverage (cheaper)", d.plan?.action === ACTION.TOPUP, `action=${d.plan?.action}`);
  if (d.plan) {
    const after = simulate(debt, cs, 500n * WAD, d.plan, quote, (a, b) => b);
    const hf2 = hfOf(after.debt, after.cs);
    check("topup: HF restored above trigger", hf2 >= trigger, `HF=${fmt(hf2)}`);
    console.log(`    ${d.memo}\n    → HF ${fmt(hfOf(debt, cs))} → ${fmt(hf2)}`);
  }
}

// ROTATE restores health by parking into higher-LT asset
{
  const { cs, debt, quote, quoteToken } = scenario();
  const s: Signals = { user: EURC, hf: hfOf(debt, cs), debt, collaterals: cs, quoteUsdcOut: quote };
  const t: Terms = { hfTriggerWad: trigger, maxSpendPerRescue: 10_000n * WAD, maxSlippageWad: WAD, minImprovementWad: 0n, allowedActions: ACTION.ROTATE, reserve: 0n };
  const d = decide(s, t);
  check("rotate: plan produced", d.plan?.action === ACTION.ROTATE);
  if (d.plan) {
    const after = simulate(debt, cs, 0n, d.plan, quote, quoteToken);
    const hf2 = hfOf(after.debt, after.cs);
    check("rotate: HF restored above trigger", hf2 >= trigger, `HF=${fmt(hf2)}`);
    console.log(`    ${d.memo}\n    → HF ${fmt(hfOf(debt, cs))} → ${fmt(hf2)}`);
  }
}

// spend cap blocks oversized plans
{
  const { cs, debt, quote } = scenario();
  const s: Signals = { user: EURC, hf: hfOf(debt, cs), debt, collaterals: cs, quoteUsdcOut: quote };
  const t: Terms = { hfTriggerWad: trigger, maxSpendPerRescue: 10n * WAD, maxSlippageWad: WAD, minImprovementWad: 0n, allowedActions: ACTION.DELEVERAGE, reserve: 0n };
  const d = decide(s, t);
  check("spend cap: no plan when every path exceeds cap", d.plan === null, `plan=${JSON.stringify(d.plan)}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
