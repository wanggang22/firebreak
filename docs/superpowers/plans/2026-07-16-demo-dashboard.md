# Firebreak Demo Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A judge-facing single-screen dashboard that shows Alice's health factor drifting past the liquidation trigger, then the autonomous keeper (Claude ranks the vetted rescue paths) fixing it live on a local anvil, with a permanent strip anchoring credibility to the real Arc-testnet rescue already on-chain.

**Architecture:** A thin Node `http` + SSE server (`agent/src/server.ts`) self-manages an anvil child process, deploys the `DemoSetup` scenario, and reuses the existing `monitor` / `strategist` / `executor` code. It streams keeper stages over SSE to a single self-contained frontend (`agent/app/index.html`). No wallet, no framework, no build step.

**Tech Stack:** TypeScript + tsx, Node `http` + `child_process`, viem, `@anthropic-ai/sdk`, Foundry (anvil + forge). Frontend is vanilla HTML/CSS/JS (Geist Mono, inline).

**Verification note:** The server is anvil-dependent, so backend tasks are verified by an end-to-end smoke test (Task 11) and by curl with exact expected output, not pure unit tests. Decision correctness is already covered by `strategist` (8/8) and `strategist-llm` (11/11) — the server reuses that code unchanged.

---

## Task 1: Structured `onStage` stages on `tick`

**Files:**
- Modify: `agent/src/keeper.ts`

Give `tick` an optional structured callback so the server can stream each keeper stage. CLI passes nothing → behavior unchanged. `computeCandidates` is pure and reads only the already-warmed quote cache, so recomputing it here costs no extra RPC.

- [ ] **Step 1: Rewrite `keeper.ts` with the `onStage` hook**

```ts
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
```

- [ ] **Step 2: Typecheck**

Run: `cd agent && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Confirm CLI path unchanged**

Run: `cd agent && npx tsx src/strategist-llm.test.ts && npx tsx src/strategist.test.ts`
Expected: `11 passed, 0 failed` and `8 passed, 0 failed` (tick's decision logic is untouched).

- [ ] **Step 4: Commit**

```bash
git add agent/src/keeper.ts
git commit -m "feat(keeper): structured onStage hook on tick for SSE streaming"
```

---

## Task 2: Server skeleton — static serve + `/api/state`

**Files:**
- Create: `agent/src/server.ts`
- Create: `agent/src/scenario.ts` (anvil + forge lifecycle, shared by server + reset)

**scenario.ts** owns the anvil child process and the DemoSetup deploy, so the server and the reset endpoint share one implementation.

- [ ] **Step 1: Write `agent/src/scenario.ts`**

```ts
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
```

- [ ] **Step 2: Write `agent/src/server.ts` (skeleton + `/` + `/api/state`)**

```ts
// Thin HTTP + SSE server behind the demo dashboard. Self-manages a local anvil
// devnet (via scenario.ts) and reuses the keeper's monitor/strategist/executor
// unchanged. No framework. Run: npm run demo:server.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadDeployment } from "./config.ts";
import { readSignals, readTerms } from "./monitor.ts";
import { ACTION, type Address } from "./types.ts";
import { deployScenario, stopScenario, ANVIL } from "./scenario.ts";

const __dir = dirname(fileURLToPath(import.meta.url));
const APP = resolve(__dir, "../app/index.html");
const DEP = loadDeployment(resolve(__dir, "../deployments/local.json"));
const USER = ANVIL.alice as Address;
const PORT = Number(process.env.PORT) || 8099;

process.env.RPC = "http://127.0.0.1:8545";
process.env.CHAIN_ID = "31337";

const fmt = (x: bigint) => (Number(x) / 1e18);
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
  const [s, t] = await Promise.all([readSignals(DEP, USER), readTerms(DEP, USER)]);
  const collateral = s.collaterals.find((c) => c.amount > 0n) ?? s.collaterals[0];
  const hf = Number(s.hf) / 1e18;
  const trigger = Number(t.hfTriggerWad) / 1e18;
  const phase = hf >= trigger ? "healthy" : "at_risk";
  return {
    phase,
    hf,
    trigger,
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
    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, 503, { error: String((err as Error).message ?? err) });
  }
});

async function main() {
  console.log("[server] deploying local scenario (anvil + DemoSetup)...");
  await deployScenario();
  server.listen(PORT, () => console.log(`[server] http://localhost:${PORT}`));
}
process.on("SIGINT", () => { stopScenario(); process.exit(0); });
process.on("SIGTERM", () => { stopScenario(); process.exit(0); });
main().catch((e) => { console.error(e); stopScenario(); process.exit(1); });
```

- [ ] **Step 3: Manual verify (foundry must be on PATH)**

Run:
```bash
cd agent && npx tsx src/server.ts &
sleep 8
curl -s http://localhost:8099/api/state | npx --yes json 2>/dev/null || curl -s http://localhost:8099/api/state
```
Expected: JSON with `"phase":"healthy"`, `"hf":1.234...` (above trigger 1.2 before drift), `position.debt` 700, `mandate.allowed` `["DELEVERAGE","ROTATE","TOPUP"]`. Then `kill %1`.

- [ ] **Step 4: Commit**

```bash
git add agent/src/scenario.ts agent/src/server.ts
git commit -m "feat(server): anvil-managed demo server with /api/state"
```

---

## Task 3: `POST /api/drift`

**Files:**
- Modify: `agent/src/server.ts`

Apply the FX drift on-chain so HF crosses the trigger. Uses a wallet on the deployer key (oracle owner).

- [ ] **Step 1: Add drift handler + imports to `server.ts`**

Add imports near the top:
```ts
import { walletFor, publicClient } from "./chain.ts";
import { oracleAbi } from "./abi.ts";
```

Add a helper above `snapshot()`:
```ts
const MEURC = DEP.tokens[0].token;
const DRIFT_PRICE = 700000000000000000n; // 0.70e18

async function applyDrift(): Promise<number> {
  const wallet = walletFor(ANVIL.deployerPk as `0x${string}`);
  const hash = await wallet.writeContract({
    address: DEP.oracle, abi: oracleAbi, functionName: "setPrice", args: [MEURC, DRIFT_PRICE],
  });
  await publicClient().waitForTransactionReceipt({ hash });
  const s = await readSignals(DEP, USER);
  return Number(s.hf) / 1e18;
}
```

Add the route inside the request handler (before the 404):
```ts
    if (req.method === "POST" && url.pathname === "/api/drift") {
      const hf = await applyDrift();
      return json(res, 200, { hf });
    }
```

- [ ] **Step 2: Manual verify**

Run:
```bash
cd agent && npx tsx src/server.ts & sleep 8
curl -s -X POST http://localhost:8099/api/drift
```
Expected: `{"hf":1.12}` (HF now below the 1.2 trigger). Then `kill %1`.

- [ ] **Step 3: Commit**

```bash
git add agent/src/server.ts
git commit -m "feat(server): POST /api/drift crosses the trigger"
```

---

## Task 4: `POST /api/reset`

**Files:**
- Modify: `agent/src/server.ts`

Redeploy a fresh scenario (restart anvil + DemoSetup) so the demo repeats.

- [ ] **Step 1: Add the reset route**

```ts
    if (req.method === "POST" && url.pathname === "/api/reset") {
      await deployScenario();
      return json(res, 200, await snapshot());
    }
```

- [ ] **Step 2: Manual verify (drift, then reset back to healthy)**

Run:
```bash
cd agent && npx tsx src/server.ts & sleep 8
curl -s -X POST http://localhost:8099/api/drift >/dev/null
curl -s -X POST http://localhost:8099/api/reset
```
Expected: JSON with `"phase":"healthy"` and HF back above 1.2. Then `kill %1`.

- [ ] **Step 3: Commit**

```bash
git add agent/src/server.ts
git commit -m "feat(server): POST /api/reset redeploys the scenario"
```

---

## Task 5: SSE `/api/rescue` + autonomy loop

**Files:**
- Modify: `agent/src/server.ts`

Stream keeper stages over SSE. On connect, the server watches HF; once `hf < trigger` (naturally, after a drift) it runs one tick with the Claude ranker and streams every stage. `?force=1` triggers immediately (live-demo backup). This models the autonomous keeper: it discovers and acts; the operator never clicks "rescue".

- [ ] **Step 1: Add imports + handler to `server.ts`**

Add imports:
```ts
import { tick, type Stage } from "./keeper.ts";
import { makeClaudeRanker } from "./llm.ts";
```

Add the SSE route inside the handler (before the 404):
```ts
    if (req.method === "GET" && url.pathname === "/api/rescue") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const send = (s: Stage) => res.write(`event: ${s.stage}\ndata: ${JSON.stringify(s.data)}\n\n`);
      const force = url.searchParams.get("force") === "1";
      try {
        // Wait (poll) until the position is actually at risk, unless forced.
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
```

- [ ] **Step 2: Manual verify (drift, then forced rescue stream)**

Run:
```bash
cd agent && set -a; . C:/Users/ASUS/.claude-apis.env; set +a
npx tsx src/server.ts & sleep 8
curl -s -X POST http://localhost:8099/api/drift >/dev/null
curl -s -N "http://localhost:8099/api/rescue?force=1" | head -30
```
Expected: SSE frames in order — `event: monitor`, `event: candidates` (3 viable), `event: llm` (chosenAction TOPUP + memo), `event: executor` (txHash), `event: restored` (hfAfter ≈ 1.38e18), `event: done`. Then `kill %1`.

- [ ] **Step 3: Commit**

```bash
git add agent/src/server.ts
git commit -m "feat(server): SSE /api/rescue streams the autonomous keeper tick"
```

---

## Task 6: `package.json` scripts

**Files:**
- Modify: `agent/package.json`

- [ ] **Step 1: Add the `demo:server` script**

In `"scripts"`, add:
```json
    "demo:server": "tsx src/server.ts",
    "smoke": "tsx src/server.smoke.ts"
```

- [ ] **Step 2: Commit**

```bash
git add agent/package.json
git commit -m "chore(agent): demo:server + smoke scripts"
```

---

## Task 7: Frontend — HTML skeleton + terminal visual tokens

**Files:**
- Create: `agent/app/index.html`

Single self-contained file. This task lays down the document, the CSS design tokens (risk-ops terminal dark), and the empty region containers. Later tasks fill each region.

- [ ] **Step 1: Write `agent/app/index.html` (skeleton + tokens)**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Firebreak — liquidation firewall</title>
<style>
  :root {
    --bg: #09090b; --panel: #111113; --panel-2: #161619; --line: #26262b;
    --ink: #e4e4e7; --dim: #8b8b93; --faint: #5b5b63;
    --amber: #f59e0b; --amber-2: #f97316; --teal: #2dd4bf; --red: #ef4444;
    --mono: "Geist Mono", ui-monospace, "SF Mono", "IBM Plex Mono", Menlo, monospace;
    --sans: "Geist", ui-sans-serif, system-ui, sans-serif;
  }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--ink); font-family: var(--mono);
    font-variant-numeric: tabular-nums; line-height: 1.4; padding: 24px; }
  a { color: var(--teal); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .wrap { max-width: 1180px; margin: 0 auto; }
  header { display: flex; align-items: baseline; justify-content: space-between;
    border-bottom: 1px solid var(--line); padding-bottom: 14px; margin-bottom: 20px; }
  .brand { font-weight: 600; letter-spacing: 0.04em; }
  .brand b { color: var(--amber); }
  .tagline { color: var(--dim); font-size: 13px; margin-left: 12px; }
  .badge { font-size: 12px; color: var(--dim); border: 1px solid var(--line);
    border-radius: 4px; padding: 4px 8px; }
  .grid { display: grid; grid-template-columns: 300px 1fr; gap: 18px; align-items: start; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
  .panel h2 { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase;
    color: var(--faint); font-weight: 600; margin-bottom: 12px; }
  .row { display: flex; justify-content: space-between; padding: 5px 0; font-size: 14px; }
  .row .k { color: var(--dim); }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip { font-size: 11px; border: 1px solid var(--line); border-radius: 999px;
    padding: 3px 9px; color: var(--dim); }
  .stack { display: grid; gap: 18px; }
  .controls { display: flex; gap: 10px; margin-top: 4px; }
  button { font-family: var(--mono); font-size: 13px; cursor: pointer;
    border-radius: 6px; padding: 9px 16px; border: 1px solid var(--line);
    background: var(--panel-2); color: var(--ink); transition: opacity .15s; }
  button.primary { background: var(--amber); color: #1a1206; border-color: var(--amber); font-weight: 600; }
  button:disabled { opacity: .45; cursor: default; }
  .muted { color: var(--faint); font-size: 12px; }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <span class="brand">■ <b>FIREBREAK</b></span>
        <span class="tagline">the line the fire can't cross</span>
      </div>
      <a class="badge" id="tn-badge" target="_blank" rel="noopener">● Live on Arc testnet ↗</a>
    </header>

    <div class="grid">
      <div class="stack">
        <div class="panel" id="position"><h2>Position</h2></div>
        <div class="panel" id="mandate"><h2>Mandate</h2></div>
        <div class="controls">
          <button class="primary" id="btn-drift">Apply FX drift</button>
          <button id="btn-reset">Reset</button>
        </div>
      </div>

      <div class="stack">
        <div class="panel" id="gauge-panel"><h2>Health Factor <span class="muted" id="devnet-tag">· local devnet (live)</span></h2></div>
        <div class="panel" id="log-panel"><h2>Keeper</h2><div id="log"></div></div>
        <div class="panel" id="proof-panel"><h2>Proven on Arc testnet</h2></div>
      </div>
    </div>
  </div>
  <script>
  // Filled in by later tasks.
  const $ = (id) => document.getElementById(id);
  const API = "";
  </script>
</body>
</html>
```

- [ ] **Step 2: Manual verify**

Run: `cd agent && npx tsx src/server.ts & sleep 8 && open http://localhost:8099 || start http://localhost:8099`
Expected: dark page renders with header, empty Position/Mandate/gauge/log/proof panels, two buttons. Then `kill %1`.

- [ ] **Step 3: Commit**

```bash
git add agent/app/index.html
git commit -m "feat(app): dashboard skeleton + terminal visual tokens"
```

---

## Task 8: Frontend — position/mandate cards + HF gauge wired to `/api/state`

**Files:**
- Modify: `agent/app/index.html`

- [ ] **Step 1: Add the gauge CSS (inside `<style>`, before `</style>`)**

```css
  .gauge { position: relative; height: 220px; display: flex; align-items: flex-end;
    gap: 20px; padding: 10px 4px 0; }
  .track { position: relative; width: 46px; height: 100%; background: var(--panel-2);
    border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
  .fill { position: absolute; left: 0; right: 0; bottom: 0; transform-origin: bottom;
    background: linear-gradient(180deg, var(--teal), #0f766e);
    transition: transform .9s cubic-bezier(.4,0,.2,1), background .4s; }
  .fill.risk { background: linear-gradient(180deg, var(--amber-2), var(--amber)); }
  .line { position: absolute; left: -4px; right: -4px; height: 0; border-top: 2px dashed var(--amber); }
  .line.target { border-top-color: rgba(45,212,191,.5); }
  .line span { position: absolute; right: 100%; margin-right: 8px; white-space: nowrap;
    font-size: 11px; color: var(--amber); transform: translateY(-50%); }
  .line.target span { color: var(--teal); }
  .readout { display: flex; flex-direction: column; justify-content: flex-end; }
  .hf-num { font-size: 46px; font-weight: 600; line-height: 1; }
  .pill { display: inline-block; margin-top: 10px; font-size: 12px; padding: 4px 10px;
    border-radius: 999px; border: 1px solid var(--line); color: var(--dim); width: fit-content; }
  .pill.healthy { color: var(--teal); border-color: rgba(45,212,191,.4); }
  .pill.at_risk { color: var(--amber); border-color: rgba(245,158,11,.4); }
  .pill.rescuing { color: var(--amber); }
  .pill.rescued { color: var(--teal); border-color: rgba(45,212,191,.4); }
```

- [ ] **Step 2: Replace the `<script>` block with state rendering**

```html
  <script>
  const $ = (id) => document.getElementById(id);
  // Gauge maps HF ∈ [1.0, 1.5] → [0%, 100%] fill height.
  const LO = 1.0, HI = 1.5;
  const pct = (hf) => Math.max(0, Math.min(1, (hf - LO) / (HI - LO)));

  function renderPosition(p) {
    $("position").innerHTML = `<h2>Position</h2>
      <div class="row"><span class="k">${p.symbol}</span><span>${p.amount.toFixed(0)} · $${p.valueUsd.toFixed(0)}</span></div>
      <div class="row"><span class="k">debt</span><span>${p.debt.toFixed(2)} USDC</span></div>`;
  }
  function renderMandate(m) {
    $("mandate").innerHTML = `<h2>Mandate</h2>
      <div class="row"><span class="k">trigger</span><span>${m.trigger.toFixed(2)}</span></div>
      <div class="row"><span class="k">spend cap</span><span>${m.spendCap.toFixed(0)} USDC</span></div>
      <div class="row"><span class="k">reserve</span><span>${m.reserve.toFixed(2)} USDC</span></div>
      <div class="row"><span class="k">actions</span></div>
      <div class="chips">${m.allowed.map((a) => `<span class="chip">${a}</span>`).join("")}</div>`;
  }
  function renderGauge(hf, trigger, phase) {
    const fillH = (pct(hf) * 100).toFixed(1);
    const trigH = (pct(trigger) * 100).toFixed(1);
    const targH = (pct(1.38) * 100).toFixed(1);
    const risk = hf < trigger ? "risk" : "";
    const labels = { healthy: "Healthy", at_risk: "At risk", rescuing: "Rescuing…", rescued: "Rescued" };
    $("gauge-panel").innerHTML = `<h2>Health Factor <span class="muted" id="devnet-tag">· local devnet (live)</span></h2>
      <div class="gauge">
        <div class="track">
          <div class="fill ${risk}" style="height:100%; transform: scaleY(${(pct(hf)).toFixed(3)})"></div>
          <div class="line" style="bottom:${trigH}%"><span>trigger ${trigger.toFixed(2)}</span></div>
          <div class="line target" style="bottom:${targH}%"><span>target 1.38</span></div>
        </div>
        <div class="readout">
          <div class="hf-num">${hf.toFixed(3)}</div>
          <div class="pill ${phase}">${labels[phase] || phase}</div>
        </div>
      </div>`;
  }

  let TRIGGER = 1.2;
  async function loadState() {
    const s = await fetch("/api/state").then((r) => r.json());
    TRIGGER = s.trigger;
    renderPosition(s.position);
    renderMandate(s.mandate);
    renderGauge(s.hf, s.trigger, s.phase);
  }
  loadState();
  </script>
```

- [ ] **Step 3: Manual verify**

Run: `cd agent && npx tsx src/server.ts & sleep 8 && start http://localhost:8099`
Expected: Position shows mEURC 1000 · $1080, debt 700; Mandate shows trigger 1.20, cap 5000, 3 chips; gauge fill teal, HF ≈ 1.234, pill "Healthy". Then `kill %1`.

- [ ] **Step 4: Commit**

```bash
git add agent/app/index.html
git commit -m "feat(app): position/mandate cards + HF gauge from /api/state"
```

---

## Task 9: Frontend — drift control + SSE keeper log

**Files:**
- Modify: `agent/app/index.html`

- [ ] **Step 1: Add log/table/memo CSS**

```css
  .log { display: grid; gap: 8px; font-size: 13px; }
  .evt { border-left: 2px solid var(--line); padding: 6px 12px; opacity: 0;
    transform: translateY(6px); animation: rise .35s forwards; }
  @keyframes rise { to { opacity: 1; transform: none; } }
  .evt .tag { color: var(--faint); font-size: 11px; text-transform: uppercase; letter-spacing: .1em; }
  .evt.mono b { color: var(--amber); }
  table.cand { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 13px; }
  table.cand td, table.cand th { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); }
  table.cand th { color: var(--faint); font-weight: 500; font-size: 11px; }
  tr.chosen td { color: var(--teal); }
  .memo { border: 1px solid rgba(45,212,191,.35); background: rgba(45,212,191,.05);
    border-radius: 6px; padding: 12px; margin-top: 8px; font-size: 13px; color: var(--ink); }
  .memo .who { color: var(--teal); font-size: 11px; text-transform: uppercase; letter-spacing: .1em; margin-bottom: 4px; }
```

- [ ] **Step 2: Extend the `<script>` with drift + SSE handling**

Append inside the `<script>` block (before `loadState();`):
```js
  const ACT = { TOPUP: "TOP-UP", ROTATE: "ROTATE", DELEVERAGE: "DELEVERAGE" };
  function addEvt(tag, html, cls = "") {
    const d = document.createElement("div");
    d.className = "evt mono " + cls;
    d.innerHTML = `<div class="tag">${tag}</div>${html}`;
    $("log").appendChild(d);
  }
  function clearLog() { $("log").innerHTML = ""; }

  function candTable(target, viable, chosen) {
    const rows = viable.map((c) =>
      `<tr class="${c.action === chosen ? "chosen" : ""}"><td>${ACT[c.action] || c.action}</td>
        <td>${(Number(c.cost) / 1e18).toFixed(2)} USDC</td><td>${c.why}</td></tr>`).join("");
    return `<table class="cand"><tr><th>path</th><th>cost</th><th>detail</th></tr>${rows}</table>`;
  }

  function streamRescue(force) {
    clearLog();
    setPhase("rescuing");
    let viable = [];
    const es = new EventSource("/api/rescue" + (force ? "?force=1" : ""));
    es.addEventListener("monitor", (e) => {
      const d = JSON.parse(e.data);
      const hf = Number(d.hf) / 1e18, tr = Number(d.trigger) / 1e18;
      renderGauge(hf, tr, hf < tr ? "rescuing" : "healthy");
      if (d.watching) addEvt("monitor", `watching… HF ${hf.toFixed(3)} vs trigger ${tr.toFixed(2)}`);
      else addEvt("monitor", `HF <b>${hf.toFixed(3)}</b> &lt; trigger ${tr.toFixed(2)}`);
    });
    es.addEventListener("candidates", (e) => {
      const d = JSON.parse(e.data);
      viable = d.viable;
      addEvt("strategist", `${d.viable.length} viable paths sized to target ${(Number(d.target) / 1e18).toFixed(2)}` + candTable(d.target, d.viable, null));
    });
    es.addEventListener("llm", (e) => {
      const d = JSON.parse(e.data);
      addEvt(d.usedLlm ? "claude" : "strategist", `chose <b>${d.chosenAction}</b>` +
        `<div class="memo"><div class="who">${d.usedLlm ? "Claude" : "deterministic"} memo</div>${d.memo}</div>`);
    });
    es.addEventListener("executor", (e) => {
      const d = JSON.parse(e.data);
      addEvt("executor", `tx <b>${d.txHash.slice(0, 10)}…</b> · spent ${(Number(d.spent) / 1e18).toFixed(2)} USDC <span class="muted">(local devnet)</span>`);
    });
    es.addEventListener("restored", (e) => {
      const d = JSON.parse(e.data);
      const after = Number(d.hfAfter) / 1e18;
      renderGauge(after, TRIGGER, "rescued");
      addEvt("restored", `HF ${(Number(d.hfBefore) / 1e18).toFixed(3)} → <b>${after.toFixed(3)}</b>`);
    });
    es.addEventListener("done", () => es.close());
    es.addEventListener("error", () => es.close());
  }
  function setPhase(p) { const pill = document.querySelector(".pill"); if (pill) pill.className = "pill " + p; }

  $("btn-drift").onclick = async () => {
    $("btn-drift").disabled = true;
    const { hf } = await fetch("/api/drift", { method: "POST" }).then((r) => r.json());
    renderGauge(hf, TRIGGER, "at_risk");
    streamRescue(true); // keeper acts on the now-at-risk position
  };
  $("btn-reset").onclick = async () => {
    const s = await fetch("/api/reset", { method: "POST" }).then((r) => r.json());
    clearLog();
    TRIGGER = s.trigger;
    renderPosition(s.position); renderMandate(s.mandate); renderGauge(s.hf, s.trigger, s.phase);
    $("btn-drift").disabled = false;
  };
```

- [ ] **Step 3: Manual verify (the full show)**

Run: `cd agent && set -a; . C:/Users/ASUS/.claude-apis.env; set +a; npx tsx src/server.ts & sleep 8 && start http://localhost:8099`
Click "Apply FX drift". Expected: gauge fill turns amber and drops below the trigger line; log streams monitor → candidate table (3 rows) → Claude memo card (chosen TOP-UP highlighted teal) → executor tx → restored; gauge snaps back to 1.38 teal, pill "Rescued". Click "Reset" → back to healthy. Then `kill %1`.

- [ ] **Step 4: Commit**

```bash
git add agent/app/index.html
git commit -m "feat(app): drift control + live SSE keeper log with Claude memo"
```

---

## Task 10: Frontend — Arc testnet proof strip

**Files:**
- Modify: `agent/app/index.html`
- Reads: `agent/evidence/run-testnet-001.json` (served via a new `/api/proof` endpoint)

- [ ] **Step 1: Add `/api/proof` to `server.ts`**

Add near the other routes:
```ts
    if (req.method === "GET" && url.pathname === "/api/proof") {
      const p = JSON.parse(readFileSync(resolve(__dir, "../evidence/run-testnet-001.json"), "utf8"));
      return json(res, 200, p);
    }
```

- [ ] **Step 2: Render the proof strip in `index.html`**

Append inside `<script>` (before `loadState();`), then call `loadProof()`:
```js
  async function loadProof() {
    const p = await fetch("/api/proof").then((r) => r.json());
    const tx = p.result.txHash, exp = p.result.explorerUrl;
    $("tn-badge").href = exp;
    $("proof-panel").innerHTML = `<h2>Proven on Arc testnet <span class="muted">· verified</span></h2>
      <div class="row"><span class="k">rescue</span><span>HF ${p.result.hfBefore} → ${p.result.hfAfter} · ${p.result.spent}</span></div>
      <div class="row"><span class="k">chosen by Claude</span><span>${p.ranking.chosenAction}</span></div>
      <div class="row"><span class="k">tx</span><a href="${exp}" target="_blank" rel="noopener">${tx.slice(0, 12)}… ↗</a></div>
      <div class="memo"><div class="who">Claude memo (testnet)</div>${p.ranking.memo.split("Reason: ")[1] || p.ranking.memo}</div>`;
  }
  loadProof();
```

- [ ] **Step 3: Manual verify**

Run: `cd agent && npx tsx src/server.ts & sleep 8 && start http://localhost:8099`
Expected: bottom strip shows "HF 1.120 → 1.380 · 0.94 USDC", chosen TOPUP, a tx link that opens arcscan, and Claude's testnet memo; the header badge links the same tx. Then `kill %1`.

- [ ] **Step 4: Commit**

```bash
git add agent/src/server.ts agent/app/index.html
git commit -m "feat(app): Arc testnet proof strip from run-testnet-001 evidence"
```

---

## Task 11: End-to-end smoke test

**Files:**
- Create: `agent/src/server.smoke.ts`

Boots the server in-process, exercises the full flow, asserts, exits non-zero on failure.

- [ ] **Step 1: Write `agent/src/server.smoke.ts`**

```ts
// End-to-end smoke: boot the demo server, drive drift → forced rescue → reset,
// assert the health factor crosses the trigger and is restored. Requires
// foundry (anvil + forge) on PATH; ANTHROPIC_API_KEY optional (falls back to
// deterministic). Run: npm run smoke
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const BASE = "http://localhost:8099";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.log(`  ✗ ${name} ${detail}`); }
};

async function waitUp(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(BASE + "/api/state")).ok) return; } catch {}
    await sleep(1000);
  }
  throw new Error("server did not come up");
}

async function sseRescue(): Promise<Record<string, unknown>> {
  const res = await fetch(BASE + "/api/rescue?force=1");
  const text = await res.text(); // stream ends at `done`
  const stages: Record<string, unknown> = {};
  for (const block of text.split("\n\n")) {
    const ev = block.match(/event: (\w+)/)?.[1];
    const data = block.match(/data: (.*)/)?.[1];
    if (ev && data) stages[ev] = JSON.parse(data);
  }
  return stages;
}

async function main() {
  const srv = spawn("npx", ["tsx", resolve(__dir, "server.ts")], { stdio: "inherit", shell: process.platform === "win32" });
  try {
    await waitUp();
    const s0 = await fetch(BASE + "/api/state").then((r) => r.json());
    check("starts healthy (HF > trigger)", s0.hf > s0.trigger, `hf=${s0.hf}`);

    const drift = await fetch(BASE + "/api/drift", { method: "POST" }).then((r) => r.json());
    check("drift crosses the trigger", drift.hf < s0.trigger, `hf=${drift.hf}`);

    const st = await sseRescue();
    check("streamed candidates", Array.isArray((st.candidates as any)?.viable) && (st.candidates as any).viable.length >= 1);
    check("streamed an llm/strategist choice", Boolean((st.llm as any)?.chosenAction));
    check("streamed an executor tx", typeof (st.executor as any)?.txHash === "string");
    const after = Number((st.restored as any)?.hfAfter) / 1e18;
    check("restored HF above trigger", after > s0.trigger, `after=${after}`);

    const reset = await fetch(BASE + "/api/reset", { method: "POST" }).then((r) => r.json());
    check("reset returns to healthy", reset.hf > reset.trigger, `hf=${reset.hf}`);
  } finally {
    srv.kill();
  }
  console.log(failed === 0 ? "\nsmoke: PASS" : `\nsmoke: ${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run the smoke test**

Run: `cd agent && set -a; . C:/Users/ASUS/.claude-apis.env; set +a; npm run smoke`
Expected: all `✓`, final line `smoke: PASS`, exit 0.

- [ ] **Step 3: Commit**

```bash
git add agent/src/server.smoke.ts
git commit -m "test(server): end-to-end smoke — drift → rescue → reset"
```

---

## Task 12: README + status

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a "Run the demo" section and check the status box**

Add under the architecture section:
```markdown
## Run the demo

Requires foundry (anvil + forge) on PATH and `ANTHROPIC_API_KEY` in the env
(optional — falls back to the deterministic strategist).

    cd agent
    set -a; . C:/Users/ASUS/.claude-apis.env; set +a   # ANTHROPIC_API_KEY
    npm run demo:server        # boots anvil + DemoSetup + server on :8099

Open http://localhost:8099 → click **Apply FX drift** → watch the keeper detect
the at-risk position and, with Claude ranking the vetted paths, rescue it live.
The bottom strip links the same rescue already executed on Arc testnet.
```

Change the status line:
```markdown
- [ ] Dashboard + demo video
```
to:
```markdown
- [x] Dashboard — single-screen live console (local anvil rescue + Arc-testnet proof strip); `npm run demo:server`
- [ ] Demo video
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: demo dashboard run instructions + status"
```

---

## Self-Review

- **Spec coverage:** architecture (Task 2 scenario+server), 4 endpoints (Tasks 2–5, 10), autonomy loop (Task 5), single-screen regions (Tasks 7–9), testnet proof strip (Task 10), terminal visual (Task 7 tokens), error handling (503 in Task 2, `error`/`done` SSE frames in Task 5, deterministic fallback surfaced in Task 9's `llm` handler), testing (Task 11). All covered.
- **Type consistency:** SSE stage names (`monitor`/`candidates`/`llm`/`executor`/`restored`/`idle`/`done`/`error`) match between `keeper.ts` (Task 1), the server route (Task 5), and the frontend listeners (Task 9). `ACTION_NAME` strings (`TOPUP`/`ROTATE`/`DELEVERAGE`) match the frontend `ACT` map. `snapshot()` field names (`position`/`mandate`/`hf`/`trigger`/`phase`) match the frontend renderers.
- **No placeholders:** every step has complete code or an exact command + expected output.
```
