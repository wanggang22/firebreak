// The LLM strategist: Claude ranks the rescue paths the deterministic core
// already sized and bounds-checked. It picks ONE candidate by action id and
// writes the borrower-facing reason. The choice is constrained by a strict tool
// whose enum is the viable actions — Claude literally cannot name a path that
// wasn't vetted, and strategist.decideWith falls back to the cheapest on any
// error. So the model adds judgement (durability vs. cost, side-effects) without
// ever holding the power to execute an unsafe action.

import Anthropic from "@anthropic-ai/sdk";
import { ACTION } from "./types.ts";
import type { Ranker, RankInput, RankChoice } from "./strategist.ts";

const MODEL = "claude-opus-4-8";

const ACTION_NAME: Record<number, string> = {
  [ACTION.DELEVERAGE]: "DELEVERAGE",
  [ACTION.ROTATE]: "ROTATE",
  [ACTION.TOPUP]: "TOPUP",
};

const wad = (x: bigint) => (Number(x) / 1e18).toFixed(3);
const usdc = (x: bigint) => (Number(x) / 1e18).toFixed(2);

const SYSTEM = `You are the strategist for Firebreak, a non-custodial liquidation firewall on a stablecoin-native chain. A borrower's health factor has drifted below the trigger in their signed Mandate, and you must choose how to rescue the loan before liquidators can seize the collateral at a penalty.

You are given a short list of candidate rescue actions. Each has been sized toward the target and checked against the borrower's spend cap and action whitelist — so every candidate is safe and executable. But sizing can be limited by a finite reserve or held balance, so some candidates only PARTIALLY restore health: each one states the health factor it actually reaches and whether that clears the target. Your job is to pick the single best one and explain why in one or two plain sentences the borrower would read in their audit log.

How to weigh the paths:
- A candidate that FULLY restores health (reaches the target) is strongly preferred over a cheaper one that only partially fixes the position and leaves it still at risk. Durability beats a smaller fee.
- TOPUP repays debt from the borrower's own prepaid reserve. Cheapest — no swap, no slippage, no collateral sold — but it spends down a finite reserve, and a small reserve may leave it a partial fix.
- ROTATE swaps a drifting asset into a steadier, higher-quality one. Keeps market exposure; costs two swap fees.
- DELEVERAGE sells collateral to repay debt. Always works, but permanently shrinks the position and realizes swap slippage.

Among candidates that fully restore health, prefer the cheapest durable fix; reserve DELEVERAGE for when nothing gentler fully works. Call select_rescue exactly once with your choice.`;

function buildPrompt(input: RankInput): string {
  const lines = [
    `Health factor ${wad(input.hfWad)} is below the trigger ${wad(input.triggerWad)}. Target after rescue: ${wad(input.targetWad)}.`,
    `Outstanding debt: ${usdc(input.debt)} USDC. Per-rescue spend cap: ${usdc(input.spendCap)} USDC.`,
    ``,
    `Candidate rescues (all pre-sized and within cap):`,
  ];
  for (const c of input.candidates) {
    const restore = c.reachesTarget
      ? `restores HF to ${wad(c.projectedHf)} (fully clears the target)`
      : `only reaches HF ${wad(c.projectedHf)} — PARTIAL, still below the target`;
    lines.push(`- action ${c.action} (${ACTION_NAME[c.action] ?? "?"}): ${c.why}. Cost to borrower now: ${usdc(c.cost)} USDC. ${restore}.`);
  }
  lines.push(``, `Pick the single best action id.`);
  return lines.join("\n");
}

/**
 * Build a Claude-backed ranker, or return null when ANTHROPIC_API_KEY is unset
 * (keeper then stays fully rule-based). The tool's chosen_action enum is the
 * exact viable action set, so the response is guaranteed in-bounds.
 */
export function makeClaudeRanker(): Ranker | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const client = new Anthropic({ apiKey });

  return async (input: RankInput): Promise<RankChoice> => {
    const actions = input.candidates.map((c) => c.action);
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      tools: [
        {
          name: "select_rescue",
          description: "Record which rescue action to execute and why.",
          strict: true,
          input_schema: {
            type: "object",
            properties: {
              chosen_action: {
                type: "integer",
                enum: actions,
                description: "The action id of the chosen candidate.",
              },
              reasoning: {
                type: "string",
                description: "One or two sentences for the borrower's audit log explaining the choice.",
              },
            },
            required: ["chosen_action", "reasoning"],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: { type: "tool", name: "select_rescue" },
      messages: [{ role: "user", content: buildPrompt(input) }],
    });

    const call = response.content.find((b) => b.type === "tool_use");
    if (!call || call.type !== "tool_use") {
      throw new Error("Claude did not return a select_rescue tool call");
    }
    const out = call.input as { chosen_action?: unknown; reasoning?: unknown };
    const chosenAction = Number(out.chosen_action);
    if (!Number.isInteger(chosenAction)) {
      throw new Error(`Claude returned non-integer chosen_action: ${String(out.chosen_action)}`);
    }
    return {
      chosenAction,
      reasoning: typeof out.reasoning === "string" ? out.reasoning : "(no reasoning returned)",
    };
  };
}
