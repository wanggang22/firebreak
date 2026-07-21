// End-to-end smoke: boot the demo server, drive drift → forced rescue → reset,
// assert the health factor crosses the trigger and is restored. Requires
// foundry (anvil + forge) on PATH; ANTHROPIC_API_KEY optional (falls back to
// deterministic). Run: npm run smoke
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/** Kill the server AND its grandchildren (tsx→node, anvil). On Windows a plain
 *  kill only reaps the npx/cmd wrapper and orphans anvil, so use taskkill /T. */
function killTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  else { try { process.kill(-pid); } catch { try { process.kill(pid); } catch {} } }
}

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
  const text = await res.text();
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
    check("starts UNSIGNED (operator must sign)", s0.mandateActive === false, `active=${s0.mandateActive}`);

    const signed = await fetch(BASE + "/api/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ triggerWad: "1200000000000000000", spendCapWad: "5000000000000000000000", reserveWad: "200000000000000000000", allowedActions: 7 }),
    }).then((r) => r.json());
    check("signing the Mandate lands on-chain", signed.mandateActive === true, `active=${signed.mandateActive}`);
    const trigger = signed.trigger; // terms only exist once signed

    const drift = await fetch(BASE + "/api/drift", { method: "POST" }).then((r) => r.json());
    check("drift crosses the trigger", drift.hf < trigger, `hf=${drift.hf} trigger=${trigger}`);

    const st = await sseRescue();
    check("streamed candidates", Array.isArray((st.candidates as any)?.viable) && (st.candidates as any).viable.length >= 1);
    check("streamed an llm/strategist choice", Boolean((st.llm as any)?.chosenAction));
    check("streamed an executor tx", typeof (st.executor as any)?.txHash === "string");
    const after = Number((st.restored as any)?.hfAfter) / 1e18;
    check("restored HF above trigger", after > trigger, `after=${after}`);

    const reset = await fetch(BASE + "/api/reset", { method: "POST" }).then((r) => r.json());
    check("reset returns to healthy", reset.hf > reset.trigger, `hf=${reset.hf}`);
  } finally {
    killTree(srv.pid);
  }
  console.log(failed === 0 ? "\nsmoke: PASS" : `\nsmoke: ${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
