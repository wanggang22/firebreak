// The amount a cross-chain refill actually sends.
//
// Circle's SDK takes the amount as a decimal *string*, so an 18-decimal bigint
// has to be rendered before it goes out. Rendering it through Number() looks
// fine in a console and is wrong on the wire: it drops the low digits of a
// full-precision amount, and prints small values in exponent form, which is
// not a decimal number at all. Either one sends the wrong amount, or none.
//
//   run: npx tsx src/amount.test.ts   (exit 0 = pass)

import { formatEther, parseEther } from "viem";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${detail}`); }
}

/** Exactly what unified-balance.ts sends as the SDK's `amount`. */
const wire = (wad: bigint) => formatEther(wad);

console.log("\namount rendering");

{
  const wad = 1234567890123456789n;
  check("keeps every digit of a full-precision amount",
    wire(wad) === "1.234567890123456789", wire(wad));
  // the defect this replaced
  check("  …which Number() would have lost",
    (Number(wad) / 1e18).toString() !== wire(wad));
}
{
  const wad = 1000000000n; // 1e-9 USDC
  check("renders small amounts as decimals, not exponents",
    !wire(wad).includes("e"), wire(wad));
  check("  …and Number() would have produced an exponent",
    (Number(wad) / 1e18).toString().includes("e"));
}
{
  check("round-trips through parseEther unchanged",
    parseEther(wire(1234567890123456789n) as `${number}`) === 1234567890123456789n);
}
{
  const cases = [0n, 1n, parseEther("0.01"), parseEther("1"), parseEther("12345.6789"), 2n ** 90n];
  let ok = true, why = "";
  for (const wad of cases) {
    const s = wire(wad);
    if (s.includes("e") || s.includes("E")) { ok = false; why = `${wad} → ${s}`; break; }
    if (parseEther(s as `${number}`) !== wad) { ok = false; why = `${wad} → ${s} → ${parseEther(s as `${number}`)}`; break; }
  }
  check("every amount renders exactly and reparses to itself", ok, why);
}
{
  // A refill is a payment. Reading it back must give the same number a human
  // would read on the transfer.
  check("a whole amount has no trailing noise", wire(parseEther("10")) === "10");
  check("zero is zero", wire(0n) === "0");
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
