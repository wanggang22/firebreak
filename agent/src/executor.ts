// Executor: turn a strategist Plan into a real on-chain rescue transaction.
// Deterministic — it does not decide anything, it only sends what the strategist
// chose, and re-checks the spend cap locally before spending gas (the contract
// re-checks everything again; this is the off-chain half of the double guard).

import { publicClient, walletFor, txUrl } from "./chain.ts";
import { mandateAbi, miniSwapAbi } from "./abi.ts";
import type { Deployment } from "./config.ts";
import type { Plan, Terms, Signals, Address } from "./types.ts";
import { spendOf } from "./strategist.ts";
import { rpcRetry } from "./monitor.ts";
import { ACTION } from "./types.ts";

export interface RescueResult {
  txHash: `0x${string}`;
  url: string;
  hfBefore: bigint;
  hfAfter: bigint;
  spent: bigint;
}

/** Fill the rotate second-leg slippage guard from a fresh quote (leg-2 min is
 *  left 0 by the strategist because it depends on leg-1 proceeds). */
async function finalizePlan(dep: Deployment, plan: Plan, s: Signals): Promise<Plan> {
  if (plan.action !== ACTION.ROTATE) return plan;
  const pc = publicClient();
  const usdcOut = s.quoteUsdcOut(plan.collateralToken, plan.collateralAmount);
  const tokenOut = (await rpcRetry(() => pc.readContract({
    address: dep.amm, abi: miniSwapAbi, functionName: "getTokenOut", args: [plan.rotateTo, usdcOut],
  }))) as bigint;
  return { ...plan, minSwapOut2: (tokenOut * 99n) / 100n };
}

export async function executeRescue(
  dep: Deployment,
  keeperKey: `0x${string}`,
  user: Address,
  plan: Plan,
  s: Signals,
  terms: Terms,
): Promise<RescueResult> {
  // off-chain guard: refuse to even send if the plan breaks the spend cap
  const spend = spendOf(plan, s);
  if (spend > terms.maxSpendPerRescue) {
    throw new Error(`plan spend ${spend} exceeds cap ${terms.maxSpendPerRescue}`);
  }

  const finalized = await finalizePlan(dep, plan, s);
  const wallet = walletFor(keeperKey);
  const pc = publicClient();

  const hash = await wallet.writeContract({
    address: dep.mandate,
    abi: mandateAbi,
    functionName: "rescue",
    args: [user, structToTuple(finalized)],
  });
  // The write itself we do NOT retry (a blind resend risks a double-send); but
  // waiting for the receipt is a read that Arc's burst limiter can 200-error, so
  // wrap it — the tx is already on-chain, we're only polling for it.
  const receipt = await rpcRetry(() => pc.waitForTransactionReceipt({ hash }));
  if (receipt.status !== "success") throw new Error(`rescue tx reverted: ${hash}`);

  // read the emitted RescueExecuted for the authoritative before/after/spent
  const evt = receipt.logs
    .map((l) => tryDecode(l))
    .find((e) => e && e.eventName === "RescueExecuted");
  const args = (evt?.args ?? {}) as { spent?: bigint; hfBefore?: bigint; hfAfter?: bigint };

  return {
    txHash: hash,
    url: txUrl(hash),
    hfBefore: args.hfBefore ?? 0n,
    hfAfter: args.hfAfter ?? 0n,
    spent: args.spent ?? spend,
  };
}

function structToTuple(p: Plan) {
  return {
    action: p.action,
    collateralToken: p.collateralToken,
    collateralAmount: p.collateralAmount,
    rotateTo: p.rotateTo,
    minSwapOut: p.minSwapOut,
    minSwapOut2: p.minSwapOut2,
    topUpAmount: p.topUpAmount,
  };
}

import { decodeEventLog, type Log } from "viem";
function tryDecode(log: Log): { eventName: string; args: unknown } | null {
  try {
    return decodeEventLog({ abi: mandateAbi, data: log.data, topics: log.topics }) as {
      eventName: string; args: unknown;
    };
  } catch {
    return null;
  }
}
