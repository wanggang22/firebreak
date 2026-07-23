// Thin HTTP + SSE server behind the demo dashboard. Self-manages a local anvil
// devnet (via scenario.ts) and reuses the keeper's monitor/strategist/executor
// unchanged. No framework. Run: npm run demo:server.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadDeployment } from "./config.ts";
import { readSignals, readTerms } from "./monitor.ts";
import { walletFor, publicClient } from "./chain.ts";
import { oracleAbi, mandateAbi } from "./abi.ts";
import { tick, type Stage } from "./keeper.ts";
import { makeClaudeRanker } from "./llm.ts";
import { ACTION, type Address } from "./types.ts";
import { deployScenario, stopScenario, ANVIL } from "./scenario.ts";

const __dir = dirname(fileURLToPath(import.meta.url));
const APP = resolve(__dir, "../app/index.html");
const DEP = loadDeployment(resolve(__dir, "../deployments/local.json"));
const USER = ANVIL.alice as Address;
const PORT = Number(process.env.PORT) || 8099;

process.env.RPC = "http://127.0.0.1:8545";
process.env.CHAIN_ID = "31337";

const MEURC = DEP.tokens[0].token;
// The DemoSetup scenario ends already drifted (mEURC 0.98, HF ~1.12). For the
// dashboard we want to START healthy and let the operator trigger the drift, so
// the server resets mEURC to 1.08 (HF ~1.234) after every deploy/reset, then
// `applyDrift` moves it to 0.98 — a moderate drift where the reserve-funded
// TOP-UP legitimately restores health to target (matches the on-chain evidence).
const HEALTHY_PRICE = 1080000000000000000n; // 1.08e18 → HF ~1.234 (above trigger)
const DRIFT_PRICE = 980000000000000000n; // 0.98e18 → HF ~1.12 (below trigger)

const fmt = (x: bigint) => Number(x) / 1e18;
const ACTION_CHIPS = (bits: number) =>
  [
    bits & ACTION.DELEVERAGE ? "DELEVERAGE" : null,
    bits & ACTION.ROTATE ? "ROTATE" : null,
    bits & ACTION.TOPUP ? "TOPUP" : null,
  ].filter(Boolean);

function json(res: ServerResponse, code: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

async function snapshot() {
  const [s, t, mo] = await Promise.all([
    readSignals(DEP, USER),
    readTerms(DEP, USER),
    publicClient().readContract({ address: DEP.mandate, abi: mandateAbi, functionName: "mandateOf", args: [USER] }),
  ]);
  const mandateActive = (mo as readonly [unknown, boolean, bigint])[1];
  const collateral = s.collaterals.find((c) => c.amount > 0n) ?? s.collaterals[0];
  const hf = Number(s.hf) / 1e18;
  const trigger = Number(t.hfTriggerWad) / 1e18;
  const phase = hf >= trigger ? "healthy" : "at_risk";
  return {
    phase,
    hf,
    trigger,
    mandateActive,
    position: {
      symbol: collateral.symbol,
      amount: fmt(collateral.amount),
      valueUsd: fmt((collateral.amount * collateral.priceWad) / 10n ** 18n),
      debt: fmt(s.debt),
    },
    mandate: {
      trigger,
      spendCap: fmt(t.maxSpendPerRescue),
      reserve: fmt(t.reserve),
      allowed: ACTION_CHIPS(t.allowedActions),
    },
  };
}

async function setPrice(price: bigint): Promise<number> {
  const wallet = walletFor(ANVIL.deployerPk as `0x${string}`);
  const hash = await wallet.writeContract({
    address: DEP.oracle, abi: oracleAbi, functionName: "setPrice", args: [MEURC, price],
  });
  await publicClient().waitForTransactionReceipt({ hash });
  const s = await readSignals(DEP, USER);
  return Number(s.hf) / 1e18;
}
/** Reset mEURC to a healthy price so the demo starts above the trigger. */
const setHealthy = () => setPrice(HEALTHY_PRICE);
/** The operator-triggered FX drift that pushes the position past the trigger. */
const applyDrift = () => setPrice(DRIFT_PRICE);

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((res, rej) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { rej(e); } });
    req.on("error", rej);
  });
}

/** Start the demo UNSIGNED so the operator experiences signing. DemoSetup
 *  pre-registers a mandate for a working out-of-the-box rescue; revoke it after
 *  each deploy/reset so the dashboard opens with "Sign your Mandate". */
async function revokeIfActive(): Promise<void> {
  const pc = publicClient();
  const [, active] = (await pc.readContract({
    address: DEP.mandate, abi: mandateAbi, functionName: "mandateOf", args: [USER],
  })) as readonly [unknown, boolean, bigint];
  if (!active) return;
  const alice = walletFor(ANVIL.alicePk as `0x${string}`);
  const h = await alice.writeContract({ address: DEP.mandate, abi: mandateAbi, functionName: "revoke", args: [] });
  await pc.waitForTransactionReceipt({ hash: h });
}

/** The borrower signs their Mandate: the bounds they choose land on-chain as a
 *  real register() tx from their own account. If one is already active, revoke
 *  it first (which refunds the old reserve) — so re-signing is safe. On the
 *  devnet the server holds the borrower's key; on mainnet this is a wallet sig. */
async function signMandate(body: {
  triggerWad?: string; spendCapWad?: string; reserveWad?: string; allowedActions?: number;
}): Promise<void> {
  const alice = walletFor(ANVIL.alicePk as `0x${string}`);
  const pc = publicClient();
  const [, active] = (await pc.readContract({
    address: DEP.mandate, abi: mandateAbi, functionName: "mandateOf", args: [USER],
  })) as readonly [unknown, boolean, bigint];
  if (active) {
    const h = await alice.writeContract({ address: DEP.mandate, abi: mandateAbi, functionName: "revoke", args: [] });
    await pc.waitForTransactionReceipt({ hash: h });
  }
  const terms = {
    pool: DEP.pool, swapVenue: DEP.amm, keeper: ANVIL.keeperAddr as Address,
    hfTrigger: BigInt(body.triggerWad ?? "1200000000000000000"),
    maxSpendPerRescue: BigInt(body.spendCapWad ?? "5000000000000000000000"),
    maxSlippageWad: 20000000000000000n, // 0.02
    minImprovementWad: 20000000000000000n, // 0.02
    keeperFee: 0n,
    allowedActions: Number(body.allowedActions ?? (ACTION.DELEVERAGE | ACTION.ROTATE | ACTION.TOPUP)),
  };
  const hash = await alice.writeContract({
    address: DEP.mandate, abi: mandateAbi, functionName: "register",
    args: [terms], value: BigInt(body.reserveWad ?? "200000000000000000000"),
  });
  await pc.waitForTransactionReceipt({ hash });
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      const html = readFileSync(APP);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      return json(res, 200, await snapshot());
    }
    if (req.method === "GET" && url.pathname === "/api/proof") {
      const p = JSON.parse(readFileSync(resolve(__dir, "../evidence/run-testnet-001.json"), "utf8"));
      return json(res, 200, p);
    }
    if (req.method === "POST" && url.pathname === "/api/register") {
      await signMandate(await readBody(req));
      return json(res, 200, await snapshot());
    }
    if (req.method === "POST" && url.pathname === "/api/drift") {
      const hf = await applyDrift();
      return json(res, 200, { hf });
    }
    if (req.method === "POST" && url.pathname === "/api/reset") {
      await deployScenario();
      await setHealthy();
      await revokeIfActive();
      return json(res, 200, await snapshot());
    }
    if (req.method === "GET" && url.pathname === "/api/rescue") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const send = (s: Stage) => res.write(`event: ${s.stage}\ndata: ${JSON.stringify(s.data)}\n\n`);
      const force = url.searchParams.get("force") === "1";
      try {
        for (let i = 0; !force && i < 60; i++) {
          const s = await readSignals(DEP, USER);
          const t = await readTerms(DEP, USER);
          if (s.hf < t.hfTriggerWad) break;
          send({ stage: "monitor", data: { hf: s.hf.toString(), trigger: t.hfTriggerWad.toString(), watching: true } });
          await new Promise((r) => setTimeout(r, 2000));
        }
        const ranker = makeClaudeRanker();
        await tick(DEP, ANVIL.keeperPk as `0x${string}`, USER, { ranker, onStage: send });
        res.write(`event: done\ndata: {}\n\n`);
      } catch (err) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: String((err as Error).message ?? err) })}\n\n`);
      }
      return res.end();
    }
    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, 503, { error: String((err as Error).message ?? err) });
  }
});

async function main() {
  console.log("[server] deploying local scenario (anvil + DemoSetup)...");
  await deployScenario();
  await setHealthy();
  await revokeIfActive(); // open the dashboard unsigned — the operator signs
  server.listen(PORT, () => console.log(`[server] http://localhost:${PORT}`));
}
process.on("SIGINT", () => { stopScenario(); process.exit(0); });
process.on("SIGTERM", () => { stopScenario(); process.exit(0); });
main().catch((e) => { console.error(e); stopScenario(); process.exit(1); });
