// The keeper loop, tying monitor → strategist → executor together. This is the
// product: watch a position, and when health crosses the Mandate trigger,
// decide the cheapest bounded rescue and execute it on-chain — logging the
// reasoning memo and the resulting health improvement as evidence.

import { readSignals, readTerms } from "./monitor.ts";
import { decide, decideWith, computeCandidates, type Ranker } from "./strategist.ts";
import { executeRescue, type RescueResult } from "./executor.ts";
import { ACTION } from "./types.ts";
import type { Deployment } from "./config.ts";
import type { Address } from "./types.ts";

const fmtHf = (wad: bigint) => (wad > 10n ** 30n ? "∞" : (Number(wad) / 1e18).toFixed(3));
const ACTION_NAME: Record<number, string> = {
  [ACTION.DELEVERAGE]: "DELEVERAGE",
  [ACTION.ROTATE]: "ROTATE",
  [ACTION.TOPUP]: "TOPUP",
};

export type StageName = "monitor" | "candidates" | "llm" | "executor" | "restored" | "idle";
export interface Stage {
  stage: StageName;
  data: Record<string, unknown>;
}

export interface KeeperOutcome {
  triggered: boolean;
  memo: string;
  rescue?: RescueResult;
}

/** One evaluation tick for one user. Returns what happened (for evidence).
 *  Pass `ranker` (e.g. makeClaudeRanker()) to have the LLM rank the vetted
 *  paths; omit it for the pure rule-based cheapest-path decision. Pass
 *  `onStage` to receive structured, streamable progress (the server uses this
 *  for SSE); omit it for the plain CLI path. */
export async function tick(
  dep: Deployment,
  keeperKey: `0x${string}`,
  user: Address,
  opts: { dryRun?: boolean; ranker?: Ranker | null; onStage?: (s: Stage) => void } = {},
): Promise<KeeperOutcome> {
  const emit = opts.onStage ?? (() => {});
  const [signals, terms] = await Promise.all([readSignals(dep, user), readTerms(dep, user)]);
  console.log(`[monitor] ${user} HF=${fmtHf(signals.hf)} trigger=${fmtHf(terms.hfTriggerWad)} debt=${(Number(signals.debt) / 1e18).toFixed(2)}`);
  emit({ stage: "monitor", data: { hf: signals.hf.toString(), trigger: terms.hfTriggerWad.toString(), debt: signals.debt.toString() } });

  const set = computeCandidates(signals, terms);
  if (!set.triggered) {
    emit({ stage: "idle", data: { hf: signals.hf.toString(), trigger: terms.hfTriggerWad.toString() } });
    const memo = `HF ${fmtHf(signals.hf)} ≥ trigger ${fmtHf(terms.hfTriggerWad)} — no rescue needed.`;
    console.log(`[strategist] ${memo}`);
    return { triggered: false, memo };
  }
  emit({
    stage: "candidates",
    data: {
      target: set.target.toString(),
      viable: set.viable.map((c) => ({ action: ACTION_NAME[c.action] ?? String(c.action), why: c.why, cost: c.cost.toString() })),
    },
  });

  const decision = opts.ranker ? await decideWith(signals, terms, opts.ranker) : decide(signals, terms);
  console.log(`[strategist${opts.ranker ? "/llm" : ""}] ${decision.memo}`);
  emit({
    stage: "llm",
    data: {
      chosenAction: decision.plan ? (ACTION_NAME[decision.plan.action] ?? String(decision.plan.action)) : null,
      memo: decision.memo,
      usedLlm: Boolean(opts.ranker),
    },
  });

  if (!decision.plan) return { triggered: true, memo: decision.memo };
  if (opts.dryRun) {
    console.log("[executor] dry-run: not sending");
    return { triggered: true, memo: decision.memo };
  }

  const rescue = await executeRescue(dep, keeperKey, user, decision.plan, signals, terms);
  console.log(`[executor] rescued: HF ${fmtHf(rescue.hfBefore)} → ${fmtHf(rescue.hfAfter)}  spent ${(Number(rescue.spent) / 1e18).toFixed(2)} USDC  tx ${rescue.txHash}`);
  emit({ stage: "executor", data: { txHash: rescue.txHash, spent: rescue.spent.toString(), url: rescue.url } });
  emit({ stage: "restored", data: { hfBefore: rescue.hfBefore.toString(), hfAfter: rescue.hfAfter.toString() } });
  return { triggered: true, memo: decision.memo, rescue };
}
