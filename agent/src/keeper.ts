// The keeper loop, tying monitor → strategist → executor together. This is the
// product: watch a position, and when health crosses the Mandate trigger,
// decide the cheapest bounded rescue and execute it on-chain — logging the
// reasoning memo and the resulting health improvement as evidence.

import { readSignals, readTerms } from "./monitor.ts";
import { decide, decideWith, type Ranker } from "./strategist.ts";
import { executeRescue, type RescueResult } from "./executor.ts";
import type { Deployment } from "./config.ts";
import type { Address } from "./types.ts";

const fmtHf = (wad: bigint) => (wad > 10n ** 30n ? "∞" : (Number(wad) / 1e18).toFixed(3));

export interface KeeperOutcome {
  triggered: boolean;
  memo: string;
  rescue?: RescueResult;
}

/** One evaluation tick for one user. Returns what happened (for evidence).
 *  Pass `ranker` (e.g. makeClaudeRanker()) to have the LLM rank the vetted
 *  paths; omit it for the pure rule-based cheapest-path decision. */
export async function tick(
  dep: Deployment,
  keeperKey: `0x${string}`,
  user: Address,
  opts: { dryRun?: boolean; ranker?: Ranker | null } = {},
): Promise<KeeperOutcome> {
  const [signals, terms] = await Promise.all([readSignals(dep, user), readTerms(dep, user)]);
  console.log(`[monitor] ${user} HF=${fmtHf(signals.hf)} trigger=${fmtHf(terms.hfTriggerWad)} debt=${(Number(signals.debt) / 1e18).toFixed(2)}`);

  const decision = opts.ranker ? await decideWith(signals, terms, opts.ranker) : decide(signals, terms);
  console.log(`[strategist${opts.ranker ? "/llm" : ""}] ${decision.memo}`);

  if (!decision.plan) return { triggered: signals.hf < terms.hfTriggerWad, memo: decision.memo };
  if (opts.dryRun) {
    console.log("[executor] dry-run: not sending");
    return { triggered: true, memo: decision.memo };
  }

  const rescue = await executeRescue(dep, keeperKey, user, decision.plan, signals, terms);
  console.log(`[executor] rescued: HF ${fmtHf(rescue.hfBefore)} → ${fmtHf(rescue.hfAfter)}  spent ${(Number(rescue.spent) / 1e18).toFixed(2)} USDC  tx ${rescue.txHash}`);
  return { triggered: true, memo: decision.memo, rescue };
}
