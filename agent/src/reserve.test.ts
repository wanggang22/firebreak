// Pure test of the refill policy — the arithmetic that decides when the keeper
// pulls from the borrower's cross-chain Unified Balance. No chain, no SDK.
//
//   run: npx tsx src/reserve.test.ts   (exit 0 = pass)

import { parseEther } from "viem";
import { planRefill, describe as describeStatus, DEFAULT_POLICY, type ReservePolicy } from "./reserve.ts";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${detail}`); }
}

const E = parseEther;
const P: ReservePolicy = { floorWad: E("2"), targetWad: E("10"), maxRefillWad: E("50") };

console.log("\nreserve policy");

// ── the ordinary cases ────────────────────────────────────────────
{
  const s = planRefill(E("5"), E("1000"), P);
  check("above the floor → no refill", !s.needsRefill && s.refillWad === 0n, `refill=${s.refillWad}`);
}
{
  const s = planRefill(E("2"), E("1000"), P);
  check("exactly at the floor → no refill (floor is inclusive)", !s.needsRefill);
}
{
  const s = planRefill(E("1.5"), E("1000"), P);
  check("below the floor → refills the gap up to target", s.needsRefill && s.refillWad === E("8.5"), `refill=${s.refillWad}`);
}
{
  const s = planRefill(0n, E("1000"), P);
  check("empty reserve → refills the full target", s.refillWad === E("10"), `refill=${s.refillWad}`);
}

// ── the bounds that protect the borrower ──────────────────────────
{
  // A borrower can cap how much the keeper may pull at once, independently of
  // how deep the target is — the same "bounded authority" idea as the Mandate.
  const tight: ReservePolicy = { floorWad: E("2"), targetWad: E("100"), maxRefillWad: E("7") };
  const s = planRefill(0n, E("1000"), tight);
  check("maxRefill caps a single pull", s.refillWad === E("7"), `refill=${s.refillWad}`);
}
{
  const s = planRefill(E("1"), E("3"), P);
  check("never pulls more than the Unified Balance holds", s.refillWad === E("3"), `refill=${s.refillWad}`);
  check("  …and reports the shortfall", s.shortfallWad === E("6"), `short=${s.shortfallWad}`);
}
{
  const s = planRefill(E("1"), 0n, P);
  check("no ammunition anywhere → no refill, full shortfall", !s.needsRefill && s.shortfallWad === E("9"), `short=${s.shortfallWad}`);
  check("  …and says TOP-UP is unavailable", describeStatus(s, P).includes("TOP-UP unavailable"));
}

// ── the invariant that matters ────────────────────────────────────
{
  // Whatever the inputs, a refill must never overshoot the target: the keeper
  // is topping up a reserve, not sweeping the borrower's cross-chain funds.
  let ok = true, why = "";
  for (const arc of ["0", "0.5", "1", "1.9", "2", "3", "50"]) {
    for (const uni of ["0", "1", "9", "1000"]) {
      const s = planRefill(E(arc), E(uni), P);
      // Only meaningful when a refill actually happens — a reserve already
      // sitting above target is left alone, it is not drained back down.
      if (s.refillWad > 0n && E(arc) + s.refillWad > P.targetWad) {
        ok = false; why = `arc=${arc} uni=${uni} overshot`; break;
      }
      if (s.refillWad > E(uni)) { ok = false; why = `arc=${arc} uni=${uni} overspent`; break; }
    }
  }
  check("never overshoots target, never exceeds available balance", ok, why);
}
{
  const s = planRefill(E("20"), E("1000"), DEFAULT_POLICY);
  check("default policy leaves a healthy reserve alone", !s.needsRefill);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
