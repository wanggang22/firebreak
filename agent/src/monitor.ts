// Monitor: read the full health snapshot for a user straight off-chain.
// Everything the strategist reasons over is a real on-chain read — HF, debt,
// per-token collateral, oracle prices, live swap quotes.

import { publicClient } from "./chain.ts";
import { miniLendAbi, miniSwapAbi, oracleAbi, mandateAbi } from "./abi.ts";
import type { Deployment } from "./config.ts";
import type { Signals, Terms, Collateral, Address } from "./types.ts";

/** Retry a read through the "request limit reached" (-32011) burst cap the
 *  public Arc RPC returns as a 200-with-error (viem won't auto-retry those).
 *  Exponential backoff; anvil never trips this so local runs pay nothing. */
export async function rpcRetry<T>(fn: () => Promise<T>, tries = 8): Promise<T> {
  let delay = 400;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      const limited = msg.includes("request limit") || msg.includes("-32011") || msg.includes("429");
      if (!limited || i >= tries) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 6000);
    }
  }
}

/** Run async jobs with a bounded concurrency, so we never fire more than
 *  `limit` in-flight requests at the shared RPC. */
async function mapLimit(jobs: Array<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const i = next++;
      await jobs[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
}

export async function readSignals(dep: Deployment, user: Address): Promise<Signals> {
  const pc = publicClient();
  const [hf, debt] = await Promise.all([
    rpcRetry(() => pc.readContract({ address: dep.pool, abi: miniLendAbi, functionName: "healthFactor", args: [user] })),
    rpcRetry(() => pc.readContract({ address: dep.pool, abi: miniLendAbi, functionName: "debtOf", args: [user] })),
  ]);

  const collaterals: Collateral[] = [];
  for (const tm of dep.tokens) {
    const [amount, listing, price] = await Promise.all([
      rpcRetry(() => pc.readContract({ address: dep.pool, abi: miniLendAbi, functionName: "collateralOf", args: [user, tm.token] })),
      rpcRetry(() => pc.readContract({ address: dep.pool, abi: miniLendAbi, functionName: "listings", args: [tm.token] })),
      rpcRetry(() => pc.readContract({ address: dep.oracle, abi: oracleAbi, functionName: "getPrice", args: [tm.token] })),
    ]);
    collaterals.push(collateralFrom(tm, amount, listing, price));
  }
  return finishSignals(dep, user, hf as bigint, debt as bigint, collaterals);
}

function collateralFrom(
  tm: { token: Address; symbol: string; isStable: boolean },
  amount: unknown, listing: unknown, price: unknown,
): Collateral {
  return {
    token: tm.token,
    symbol: tm.symbol,
    amount: amount as bigint,
    priceWad: price as bigint,
    ltWad: (listing as readonly [boolean, bigint, bigint])[2],
    isStable: tm.isStable,
  };
}

async function finishSignals(dep: Deployment, user: Address, hf: bigint, debt: bigint, collaterals: Collateral[]): Promise<Signals> {
  const quoteUsdcOut = makeCachedQuoter(dep, collaterals);
  await quoteUsdcOut.warm();
  return { user, hf, debt, collaterals, quoteUsdcOut: quoteUsdcOut.fn };
}

export async function readTerms(dep: Deployment, user: Address): Promise<Terms> {
  const pc = publicClient();
  const res = (await rpcRetry(() => pc.readContract({
    address: dep.mandate, abi: mandateAbi, functionName: "mandateOf", args: [user],
  }))) as readonly [
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

  // Probe grid: 20 fractions per token. Coarser than before so the shared Arc
  // RPC isn't flooded; the constant-product curve is smooth enough that snapping
  // to the nearest 5%-step probe keeps the sizing well inside slippage tolerance.
  const STEPS = 20;

  async function warm() {
    const jobs: Array<() => Promise<void>> = [];
    for (const c of cs) {
      for (let i = 1; i <= STEPS; i++) {
        const amt = (c.amount * BigInt(i)) / BigInt(STEPS);
        if (amt === 0n) continue;
        jobs.push(async () => {
          const out = (await rpcRetry(() =>
            pc.readContract({ address: dep.amm, abi: miniSwapAbi, functionName: "getUsdcOut", args: [c.token, amt] }),
          )) as bigint;
          cache.set(key(c.token, amt), out);
        });
      }
    }
    await mapLimit(jobs, 4); // ≤4 concurrent calls — under the RPC burst cap
  }

  // Synchronous lookup: snap the requested amount to the nearest warmed probe.
  function fn(token: Address, amt: bigint): bigint {
    const c = cs.find((x) => x.token === token);
    if (!c || c.amount === 0n) return 0n;
    let bestK = "";
    let bestDiff = -1n;
    for (let i = 1; i <= STEPS; i++) {
      const probe = (c.amount * BigInt(i)) / BigInt(STEPS);
      const diff = probe > amt ? probe - amt : amt - probe;
      if (bestDiff < 0n || diff < bestDiff) { bestDiff = diff; bestK = key(token, probe); }
    }
    return cache.get(bestK) ?? 0n;
  }

  return { warm, fn };
}
