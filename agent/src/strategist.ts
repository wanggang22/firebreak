// The strategist: given a health snapshot and the signed Mandate terms, choose
// the cheapest rescue path and size it to restore health to a safe margin —
// with a written reasoning memo. Pure functions, no chain, no LLM: this is the
// deterministic core. In Week 3 an LLM proposes the ranking; these same
// functions still size and bounds-check whatever it picks (defense in depth).

import {
  WAD, ACTION, ZERO_ADDR,
  type Signals, type Terms, type Plan, type Decision, type Collateral, type Address,
} from "./types.ts";

/** Restore health to this multiple of the trigger (e.g. 1.2 trigger -> aim 1.38). */
const SAFETY_MARGIN = (115n * WAD) / 100n; // 1.15x
const SLIPPAGE_BPS = 100n; // 1% slippage tolerance on swap legs

function targetHf(t: Terms): bigint {
  return (t.hfTriggerWad * SAFETY_MARGIN) / WAD;
}

function weightedCollateral(cs: Collateral[]): bigint {
  let w = 0n;
  for (const c of cs) {
    const value = (c.amount * c.priceWad) / WAD;
    w += (value * c.ltWad) / WAD;
  }
  return w;
}

function allowed(t: Terms, action: number): boolean {
  return (t.allowedActions & action) !== 0;
}

/** The riskiest (lowest-LT, most drifted) asset the user holds — deleverage/rotate source. */
function riskiestCollateral(cs: Collateral[]): Collateral | null {
  const held = cs.filter((c) => c.amount > 0n);
  if (held.length === 0) return null;
  return held.reduce((a, b) => (b.ltWad < a.ltWad ? b : a));
}

function steadiestTarget(cs: Collateral[], notToken: Address): Collateral | null {
  const cands = cs.filter((c) => c.isStable && c.token !== notToken);
  if (cands.length === 0) return null;
  return cands.reduce((a, b) => (b.ltWad > a.ltWad ? b : a));
}

/**
 * DELEVERAGE sizing. Selling collateral value V (repaying V of debt):
 *   newHF = (W - V*LT) / (D - V)  ⇒  V = (T*D - W) / (T - LT)
 * Returns the collateral token amount to sell to reach target HF.
 */
function sizeDeleverage(s: Signals, c: Collateral, t: Terms): bigint {
  const W = weightedCollateral(s.collaterals);
  const D = s.debt;
  const T = targetHf(t);
  const num = (T * D) / WAD - W; // T*D - W  (WAD units)
  const den = T - c.ltWad; // T - LT (WAD)
  if (num <= 0n || den <= 0n) return 0n;
  const valueToSell = (num * WAD) / den; // USDC value
  // convert value -> token amount at oracle price, cap at balance
  let amt = (valueToSell * WAD) / c.priceWad;
  if (amt > c.amount) amt = c.amount;
  return amt;
}

const withSlippage = (x: bigint) => (x * (10000n - SLIPPAGE_BPS)) / 10000n;

/** WAD health factor from weighted collateral and debt (∞ when debt-free). */
function hfFrom(weighted: bigint, debt: bigint): bigint {
  return debt <= 0n ? 2n ** 255n : (weighted * WAD) / debt;
}

/** Finalize a candidate: record whether it reaches the target, and annotate the
 *  `why` when a clamp (reserve / held balance / collateral balance) left it a
 *  partial fix — so both the cheapest-rule and the LLM see the shortfall instead
 *  of being told every path fully restores health. */
function mark(
  c: Omit<Candidate, "reachesTarget">,
  target: bigint,
  clamped: boolean,
): Candidate {
  const reachesTarget = c.projectedHf >= target;
  const why = reachesTarget
    ? c.why
    : `${c.why} — PARTIAL: only reaches HF ${fmt(c.projectedHf)} (target ${fmt(target)}${clamped ? ", capped" : ""})`;
  return { ...c, why, reachesTarget };
}

/** One viable rescue path: pre-sized to restore health, priced, and (in the
 *  returned set) already filtered to fit the spend cap. This is what the LLM
 *  ranks — it can only ever pick from these, never invent an unbounded action. */
export interface Candidate {
  action: number; // ACTION.* — stable id the ranker selects by
  plan: Plan; // fully sized, ready to execute
  cost: bigint; // USDC value the user gives up now (0 for TOP-UP)
  why: string; // one-line human description
  projectedHf: bigint; // WAD; HF the position reaches if this plan executes
  reachesTarget: boolean; // projectedHf >= target (a full fix, not a partial)
}

export interface CandidateSet {
  triggered: boolean;
  target: bigint; // target HF (WAD)
  notes: string[]; // reasoning breadcrumbs, folded into the memo
  viable: Candidate[]; // sized + spend-cap-filtered; empty if nothing fits
}

/**
 * The deterministic core: from a health snapshot and the signed Mandate, build
 * every allowed rescue path, size each to the target HF, price it, and drop any
 * that breach the spend cap. Pure — no chain, no LLM. Both the rule-based
 * `decide` and the LLM-ranked `decideWith` consume this; sizing and bounds live
 * here so the LLM only ever chooses among vetted, executable candidates.
 */
export function computeCandidates(s: Signals, t: Terms): CandidateSet {
  if (s.hf >= t.hfTriggerWad) {
    return { triggered: false, target: targetHf(t), notes: [], viable: [] };
  }

  const target = targetHf(t);
  const risky = riskiestCollateral(s.collaterals);
  const notes: string[] = [
    `HF ${fmt(s.hf)} < trigger ${fmt(t.hfTriggerWad)}. Target ${fmt(target)}. Debt ${usdc(s.debt)} USDC.`,
  ];

  // Cost model: build the three allowed paths. "Cost" = USDC value the user
  // gives up now.
  const cands: Candidate[] = [];

  // ── TOPUP: repay from reserve. Cost = USDC repaid (but it's the user's own
  //    reserve, so cheapest in fees — no swap, no slippage, no collateral sold).
  if (allowed(t, ACTION.TOPUP) && t.reserve > 0n) {
    // repay V to reach target: newHF = (W)/(D - V) = T ⇒ V = D - W/T
    const W = weightedCollateral(s.collaterals);
    const V = s.debt - (W * WAD) / target;
    const repay = clamp(V, 0n, min(t.reserve, s.debt));
    if (repay > 0n) {
      // repaying `repay` leaves W unchanged, debt = D - repay
      const projectedHf = hfFrom(W, s.debt - repay);
      cands.push(mark({
        action: ACTION.TOPUP,
        plan: plan(ACTION.TOPUP, ZERO_ADDR, 0n, ZERO_ADDR, 0n, 0n, repay),
        cost: 0n, // reserve is the user's own money moved from idle to debt — no value lost
        why: `TOP-UP ${usdc(repay)} USDC from reserve (no swap, no slippage, no collateral sold)`,
        projectedHf,
      }, target, t.reserve < V));
    }
  }

  // ── ROTATE: swap risky collateral into a steadier (higher-LT) asset. Cost =
  //    swap fees on the moved value (2 legs). Best when a drifting asset can be
  //    parked without deleveraging.
  if (allowed(t, ACTION.ROTATE) && risky) {
    const target2 = steadiestTarget(s.collaterals, risky.token);
    if (target2) {
      // move a fixed, health-restoring slice: size so the LT uplift covers the gap.
      // moving value M from LT1 to LT2 raises weighted by M*(LT2-LT1).
      // newHF = (W + M*(LT2-LT1))/D = T ⇒ M = (T*D - W)/(LT2 - LT1)
      const W = weightedCollateral(s.collaterals);
      const dLT = target2.ltWad > risky.ltWad ? target2.ltWad - risky.ltWad : 0n;
      if (dLT > 0n) {
        const num = (target * s.debt) / WAD - W;
        if (num > 0n) {
          let moveValue = (num * WAD) / dLT;
          const held = (risky.amount * risky.priceWad) / WAD;
          if (moveValue > held) moveValue = held;
          const amt = (moveValue * WAD) / risky.priceWad;
          const usdcOut = s.quoteUsdcOut(risky.token, amt);
          // moving `moveValue` from LT1→LT2 raises weighted collateral by
          // moveValue*(LT2-LT1); debt is unchanged.
          const newW = W + (moveValue * dLT) / WAD;
          const projectedHf = hfFrom(newW, s.debt);
          const capped = moveValue < (num * WAD) / dLT; // held-balance clamp bit
          cands.push(mark({
            action: ACTION.ROTATE,
            plan: plan(
              ACTION.ROTATE, risky.token, amt, target2.token,
              withSlippage(usdcOut), 0n /* leg2 min filled by executor */, 0n,
            ),
            cost: (usdcOut * 60n) / 10000n, // ~0.3% x2 legs fee proxy (both legs)
            why: `ROTATE ${usdc(moveValue)} USDC of ${risky.symbol}(LT ${fmt(risky.ltWad)}) → ${target2.symbol}(LT ${fmt(target2.ltWad)})`,
            projectedHf,
          }, target, capped));
        }
      }
    }
  }

  // ── DELEVERAGE: sell risky collateral, repay debt. Cost = swap slippage +
  //    permanently reduced exposure. Always available as the backstop.
  if (allowed(t, ACTION.DELEVERAGE) && risky) {
    const amt = sizeDeleverage(s, risky, t);
    if (amt > 0n) {
      const usdcOut = s.quoteUsdcOut(risky.token, amt);
      const soldValue = (amt * risky.priceWad) / WAD;
      // selling `soldValue` of risky removes soldValue*LT from weighted, and
      // repays min(usdcOut, debt) of debt.
      const newW = weightedCollateral(s.collaterals) - (soldValue * risky.ltWad) / WAD;
      const newDebt = s.debt - (usdcOut < s.debt ? usdcOut : s.debt);
      const projectedHf = hfFrom(newW, newDebt);
      const capped = amt >= risky.amount; // hit the balance clamp
      cands.push(mark({
        action: ACTION.DELEVERAGE,
        plan: plan(ACTION.DELEVERAGE, risky.token, amt, ZERO_ADDR, withSlippage(usdcOut), 0n, 0n),
        cost: usdcOut, // gives up this much collateral value now
        why: `DELEVERAGE: sell ${usdc(soldValue)} USDC of ${risky.symbol}, repay debt`,
        projectedHf,
      }, target, capped));
    }
  }

  const viable = cands.filter((c) => spendOf(c.plan, s) <= t.maxSpendPerRescue);
  notes.push(`Candidates: ${cands.map((c) => c.why.split(":")[0].split(" ")[0]).join(", ") || "none"}.`);
  return { triggered: true, target, notes, viable };
}

/** A ranker picks one candidate by action id and explains why (LLM or otherwise). */
export type Ranker = (input: RankInput) => Promise<RankChoice>;
export interface RankInput {
  hfWad: bigint;
  triggerWad: bigint;
  targetWad: bigint;
  debt: bigint;
  spendCap: bigint;
  candidates: Candidate[];
}
export interface RankChoice {
  chosenAction: number; // must be one of the candidates' actions
  reasoning: string;
}

/**
 * Rule-based decision: cheapest viable path. Pure and synchronous — the
 * deterministic fallback and the reference the strategist test pins.
 */
export function decide(s: Signals, t: Terms): Decision {
  const set = computeCandidates(s, t);
  if (!set.triggered) {
    return { plan: null, memo: `HF ${fmt(s.hf)} ≥ trigger ${fmt(t.hfTriggerWad)} — no rescue needed.` };
  }
  const chosen = pickBest(set.viable);
  if (!chosen) {
    return { plan: null, memo: `${set.notes.join(" ")} No path fits spend cap ${usdc(t.maxSpendPerRescue)} USDC.` };
  }
  const notes = [...set.notes, `Chose ${chosen.why} — best of ${set.viable.length} viable (cost ${usdc(chosen.cost)} USDC, HF→${fmt(chosen.projectedHf)}).`];
  return { plan: chosen.plan, memo: notes.join(" ") };
}

/**
 * LLM-ranked decision. The ranker chooses among the SAME vetted candidates the
 * rule engine built — sizing, spend cap, and action whitelist are already
 * enforced, so its only freedom is which safe path to take. Any failure or an
 * out-of-set pick falls back to the cheapest, so the LLM can never make the
 * position worse or stall a rescue. With 0–1 viable paths there's nothing to
 * rank, so we skip the call entirely.
 */
export async function decideWith(s: Signals, t: Terms, ranker: Ranker): Promise<Decision> {
  const set = computeCandidates(s, t);
  if (!set.triggered) {
    return { plan: null, memo: `HF ${fmt(s.hf)} ≥ trigger ${fmt(t.hfTriggerWad)} — no rescue needed.` };
  }
  if (set.viable.length === 0) {
    return { plan: null, memo: `${set.notes.join(" ")} No path fits spend cap ${usdc(t.maxSpendPerRescue)} USDC.` };
  }
  const fallback = pickBest(set.viable)!;
  if (set.viable.length === 1) {
    const notes = [...set.notes, `Only one viable path: ${fallback.why} (cost ${usdc(fallback.cost)} USDC).`];
    return { plan: fallback.plan, memo: notes.join(" ") };
  }

  try {
    const choice = await ranker({
      hfWad: s.hf, triggerWad: t.hfTriggerWad, targetWad: set.target,
      debt: s.debt, spendCap: t.maxSpendPerRescue, candidates: set.viable,
    });
    const picked = set.viable.find((c) => c.action === choice.chosenAction);
    if (!picked) {
      const notes = [...set.notes, `LLM returned action ${choice.chosenAction} not in the viable set — falling back to cheapest: ${fallback.why}.`];
      return { plan: fallback.plan, memo: notes.join(" ") };
    }
    const notes = [
      ...set.notes,
      `LLM ranked ${set.viable.length} viable paths and chose ${picked.why} (cost ${usdc(picked.cost)} USDC).`,
      `Reason: ${choice.reasoning.trim()}`,
    ];
    return { plan: picked.plan, memo: notes.join(" ") };
  } catch (err) {
    const notes = [...set.notes, `LLM ranking unavailable (${(err as Error).message}); using cheapest: ${fallback.why} (cost ${usdc(fallback.cost)} USDC).`];
    return { plan: fallback.plan, memo: notes.join(" ") };
  }
}

/** The safe deterministic pick and fallback. A path that actually restores
 *  health to the target always beats one that only partially fixes it — a
 *  cheaper partial (e.g. a reserve-capped TOP-UP that undershoots) must never
 *  win just because its fee is zero. Among full fixes, cheapest wins; if none
 *  reach target, take the one that lifts health the most. */
function pickBest(cs: Candidate[]): Candidate | null {
  if (cs.length === 0) return null;
  const full = cs.filter((c) => c.reachesTarget);
  if (full.length) return full.reduce((a, b) => (b.cost < a.cost ? b : a));
  return cs.reduce((a, b) =>
    b.projectedHf > a.projectedHf ? b : b.projectedHf === a.projectedHf && b.cost < a.cost ? b : a,
  );
}

/** Kept for tests/back-compat: the pure cheapest-by-cost among candidates. */
function cheapest(cs: Candidate[]): Candidate | null {
  if (cs.length === 0) return null;
  return cs.reduce((a, b) => (b.cost < a.cost ? b : a));
}
void cheapest;

/** USDC value moved by a plan (used for the spend-cap pre-check). */
export function spendOf(p: Plan, s: Signals): bigint {
  if (p.action === ACTION.TOPUP) return p.topUpAmount;
  // deleverage/rotate: the USDC proceeds of the first swap leg
  return s.quoteUsdcOut(p.collateralToken, p.collateralAmount);
}

/* ── helpers ─────────────────────────────────────────── */

function plan(
  action: number, collateralToken: Address, collateralAmount: bigint,
  rotateTo: Address, minSwapOut: bigint, minSwapOut2: bigint, topUpAmount: bigint,
): Plan {
  return { action, collateralToken, collateralAmount, rotateTo, minSwapOut, minSwapOut2, topUpAmount };
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const clamp = (x: bigint, lo: bigint, hi: bigint) => (x < lo ? lo : x > hi ? hi : x);
const fmt = (wad: bigint) => (Number(wad) / 1e18).toFixed(3);
const usdc = (wei: bigint) => (Number(wei) / 1e18).toFixed(2);
