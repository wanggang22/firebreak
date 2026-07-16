// Thin CLI over the keeper. Usage:
//   RPC=... CHAIN_ID=... DEPLOYMENT=deployments/local.json KEEPER_PK=0x... \
//     npx tsx src/cli.ts <monitor|rescue> <userAddress>
//
// monitor = dry run (read + decide, no tx). rescue = execute on-chain.
// If ANTHROPIC_API_KEY is set, Claude ranks the vetted rescue paths; otherwise
// the keeper falls back to the deterministic cheapest-path rule.

import { loadDeployment } from "./config.ts";
import { tick } from "./keeper.ts";
import { makeClaudeRanker } from "./llm.ts";
import type { Address } from "./types.ts";

async function main() {
  const [cmd, user] = process.argv.slice(2);
  if (!cmd || !user) {
    console.error("usage: cli.ts <monitor|rescue> <userAddress>");
    process.exit(2);
  }
  const depPath = process.env.DEPLOYMENT ?? "deployments/local.json";
  const dep = loadDeployment(depPath);
  const keeperKey = (process.env.KEEPER_PK ?? "0x") as `0x${string}`;

  const ranker = makeClaudeRanker();
  if (ranker) console.log("[strategist] LLM ranking enabled (claude-opus-4-8)");
  const outcome = await tick(dep, keeperKey, user as Address, { dryRun: cmd === "monitor", ranker });
  if (cmd === "rescue" && !outcome.rescue && outcome.triggered) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
