// Owns the local demo devnet: a managed anvil child process + the DemoSetup
// deploy. A fresh anvil is deterministic, so the deployed addresses always
// equal deployments/local.json — no rewiring on reset. Anvil's default keys are
// public/well-known test keys; they live here only for the local demo devnet.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const CONTRACTS = resolve(__dir, "../../contracts");

// Anvil deterministic accounts (PUBLIC test keys — safe to commit, never used off local anvil).
export const ANVIL = {
  deployerPk: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  alicePk: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  keeperPk: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  keeperAddr: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  alice: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
} as const;

let anvil: ChildProcess | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForRpc(url: string, tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("anvil did not come up on " + url);
}

/** Start (or restart) anvil and deploy the DemoSetup scenario. Idempotent:
 *  kills any anvil we started first, so this doubles as reset. */
export async function deployScenario(): Promise<void> {
  if (anvil) {
    anvil.kill();
    anvil = null;
    await sleep(300);
  }
  anvil = spawn("anvil", ["--silent"], { stdio: "ignore" });
  await waitForRpc("http://127.0.0.1:8545");

  const r = spawnSync(
    "forge",
    ["script", "script/DemoSetup.s.sol:DemoSetup", "--rpc-url", "http://127.0.0.1:8545", "--broadcast"],
    {
      cwd: CONTRACTS,
      env: {
        ...process.env,
        DEPLOYER_PK: ANVIL.deployerPk,
        ALICE_PK: ANVIL.alicePk,
        KEEPER_ADDR: ANVIL.keeperAddr,
      },
      encoding: "utf8",
    },
  );
  if (r.status !== 0) throw new Error("DemoSetup failed:\n" + (r.stderr || r.stdout));
}

export function stopScenario(): void {
  if (anvil) {
    anvil.kill();
    anvil = null;
  }
}
