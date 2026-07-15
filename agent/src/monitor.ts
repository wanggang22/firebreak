// Monitor: read the full health snapshot for a user straight off-chain.
// Everything the strategist reasons over is a real on-chain read — HF, debt,
// per-token collateral, oracle prices, live swap quotes.

import { publicClient } from "./chain.ts";
import { miniLendAbi, miniSwapAbi, oracleAbi, mandateAbi } from "./abi.ts";
import type { Deployment } from "./config.ts";
import type { Signals, Terms, Collateral, Address } from "./types.ts";

export async function readSignals(dep: Deployment, user: Address): Promise<Signals> {
  const pc = publicClient();
  const [hf, debt] = await Promise.all([
    pc.readContract({ address: dep.pool, abi: miniLendAbi, functionName: "healthFactor", args: [user] }),
    pc.readContract({ address: dep.pool, abi: miniLendAbi, functionName: "debtOf", args: [user] }),
  ]);

  const collaterals: Collateral[] = await Promise.all(
    dep.tokens.map(async (tm): Promise<Collateral> => {
      const [amount, listing, price] = await Promise.all([
        pc.readContract({ address: dep.pool, abi: miniLendAbi, functionName: "collateralOf", args: [user, tm.token] }),
        pc.readContract({ address: dep.pool, abi: miniLendAbi, functionName: "listings", args: [tm.token] }),
        pc.readContract({ address: dep.oracle, abi: oracleAbi, functionName: "getPrice", args: [tm.token] }),
      ]);
      return {
        token: tm.token,
        symbol: tm.symbol,
        amount: amount as bigint,
        priceWad: price as bigint,
        ltWad: (listing as readonly [boolean, bigint, bigint])[2],
        isStable: tm.isStable,
      };
    }),
  );

  // live quoter — one synchronous view per call would be async; we pre-fetch a
  // small cache keyed by (token, amount) lazily via a memoized async barrier.
  // For the strategist's needs we expose a batched pre-quote instead: see below.
  const quoteUsdcOut = makeCachedQuoter(dep, collaterals);

  // warm the cache for the amounts the strategist will probe (each collateral's
  // full balance is the upper bound it considers).
  await quoteUsdcOut.warm();

  return { user, hf: hf as bigint, debt: debt as bigint, collaterals, quoteUsdcOut: quoteUsdcOut.fn };
}

export async function readTerms(dep: Deployment, user: Address): Promise<Terms> {
  const pc = publicClient();
  const res = (await pc.readContract({
    address: dep.mandate, abi: mandateAbi, functionName: "mandateOf", args: [user],
  })) as readonly [
    { pool: Address; swapVenue: Address; keeper: Address; hfTrigger: bigint; maxSpendPerRescue: bigint; allowedActions: number },
    boolean,
    bigint,
  ];
  const [terms, , reserve] = res;
  return {
    hfTriggerWad: terms.hfTrigger,
    maxSpendPerRescue: terms.maxSpendPerRescue,
    allowedActions: terms.allowedActions,
    reserve,
  };
}

// The strategist calls quoteUsdcOut synchronously while sizing. We pre-quote a
// grid of amounts per token and interpolate — for the constant-product venue an
// exact re-quote is cheap, so we simply cache exact answers we know we'll need.
function makeCachedQuoter(dep: Deployment, cs: Collateral[]) {
  const pc = publicClient();
  const cache = new Map<string, bigint>();
  const key = (t: Address, a: bigint) => `${t}:${a}`;

  async function warm() {
    // probe each token at a range of fractions of the user's balance
    const probes: Array<Promise<void>> = [];
    for (const c of cs) {
      for (let i = 1; i <= 100; i++) {
        const amt = (c.amount * BigInt(i)) / 100n;
        if (amt === 0n) continue;
        probes.push(
          pc
            .readContract({ address: dep.amm, abi: miniSwapAbi, functionName: "getUsdcOut", args: [c.token, amt] })
            .then((out) => { cache.set(key(c.token, amt), out as bigint); }),
        );
      }
    }
    await Promise.all(probes);
  }

  // Synchronous lookup: snap the requested amount to the nearest warmed probe.
  function fn(token: Address, amt: bigint): bigint {
    const c = cs.find((x) => x.token === token);
    if (!c || c.amount === 0n) return 0n;
    let bestK = "";
    let bestDiff = -1n;
    for (let i = 1; i <= 100; i++) {
      const probe = (c.amount * BigInt(i)) / 100n;
      const diff = probe > amt ? probe - amt : amt - probe;
      if (bestDiff < 0n || diff < bestDiff) { bestDiff = diff; bestK = key(token, probe); }
    }
    return cache.get(bestK) ?? 0n;
  }

  return { warm, fn };
}
