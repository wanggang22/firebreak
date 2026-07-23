// Ammunition management — the keeper's second loop.
//
// A rescue is atomic: it spends the borrower's *prepaid* reserve that already
// sits on Arc. But making a borrower park idle USDC on Arc, months ahead, to
// insure against a liquidation that may never come is a bad trade — and when
// the reserve runs thin the cheapest rescue path (TOP-UP) silently stops being
// available, which is exactly how a position ends up taking a worse path.
//
// So the reserve itself lives cross-chain, in the borrower's Circle Unified
// Balance, and the keeper tops it back up on Arc when it runs low. Crossing
// chains cannot be atomic, so this deliberately does NOT happen inside a
// rescue — it is a separate loop that keeps the magazine loaded before the
// shot is needed.
//
// The authorization shape is the same one Firebreak already uses on-chain:
//
//   Arc      borrower registers a Mandate  → keeper may move collateral, bounded
//   Circle   borrower addDelegate(keeper)  → keeper may spend balance, bounded
//
// The borrower stays the owner on both layers. Revoking either one is enough
// to stop the keeper.
import { formatEther, parseEther } from "viem";
import type { Address } from "./types.ts";

/** What the keeper needs to know to manage a borrower's ammunition. */
export interface ReservePolicy {
  /** Refill once the on-chain reserve drops below this (wei, 18-dec USDC). */
  floorWad: bigint;
  /** Refill up to this level (wei). Must exceed floorWad. */
  targetWad: bigint;
  /** Never pull more than this from the Unified Balance in one go (wei). */
  maxRefillWad: bigint;
}

export interface ReserveStatus {
  onArcWad: bigint;
  unifiedWad: bigint;
  needsRefill: boolean;
  /** How much the keeper would pull right now (0 when no refill is due). */
  refillWad: bigint;
  /** Set when a refill is due but the cross-chain balance cannot cover it. */
  shortfallWad: bigint;
}

export const DEFAULT_POLICY: ReservePolicy = {
  floorWad: parseEther("2"),
  targetWad: parseEther("10"),
  maxRefillWad: parseEther("50"),
};

/**
 * Decide whether to refill, and by how much. Pure function — no I/O, no SDK,
 * so the policy is unit-testable on its own and the same numbers drive both
 * the live keeper and the demo.
 */
export function planRefill(
  onArcWad: bigint,
  unifiedWad: bigint,
  policy: ReservePolicy = DEFAULT_POLICY,
): ReserveStatus {
  const base: ReserveStatus = {
    onArcWad,
    unifiedWad,
    needsRefill: false,
    refillWad: 0n,
    shortfallWad: 0n,
  };
  if (onArcWad >= policy.floorWad) return base;

  // A mis-ordered policy — target at or below floor — would make this
  // subtraction negative, and bigint carries the sign silently into every
  // number downstream. Clamp instead: a policy that cannot say how much to
  // refill should refill nothing, not a negative amount.
  const want = policy.targetWad > onArcWad ? policy.targetWad - onArcWad : 0n;
  const capped = want > policy.maxRefillWad ? policy.maxRefillWad : want;
  const affordable = capped > unifiedWad ? unifiedWad : capped;

  return {
    ...base,
    needsRefill: affordable > 0n,
    refillWad: affordable,
    // Flag the case where the borrower is out of ammunition everywhere: the
    // keeper can still deleverage/rotate, but TOP-UP is off the table and the
    // borrower should be told rather than silently given a worse rescue.
    shortfallWad: capped > affordable ? capped - affordable : 0n,
  };
}

export const fmt = (wad: bigint) => `${Number(formatEther(wad)).toFixed(2)} USDC`;

/** Human-readable one-liner for logs and the demo console. */
export function describe(s: ReserveStatus, policy: ReservePolicy = DEFAULT_POLICY): string {
  if (!s.needsRefill && s.shortfallWad === 0n) {
    return `reserve ${fmt(s.onArcWad)} on Arc — above the ${fmt(policy.floorWad)} floor, no refill needed`;
  }
  if (s.shortfallWad > 0n && s.refillWad === 0n) {
    return `reserve ${fmt(s.onArcWad)} is below floor and the Unified Balance is empty — TOP-UP unavailable, short ${fmt(s.shortfallWad)}`;
  }
  const tail = s.shortfallWad > 0n ? ` (still ${fmt(s.shortfallWad)} short of target)` : "";
  return `reserve ${fmt(s.onArcWad)} below the ${fmt(policy.floorWad)} floor — pulling ${fmt(s.refillWad)} from the Unified Balance${tail}`;
}
