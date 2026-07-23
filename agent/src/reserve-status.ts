// `npm run reserve` — the ammunition report.
//
// Shows both halves of the reserve: what is already on Arc under the Mandate,
// and what is reachable cross-chain through Circle Unified Balance. Then prints
// what the keeper would do about it.
//
// Every number here is read live. Nothing is stubbed; where a check cannot be
// performed (no cross-chain funds deposited yet) it says so instead of printing
// a comfortable zero.
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mandateAbi } from "./abi.ts";
import { planRefill, describe, DEFAULT_POLICY, fmt } from "./reserve.ts";
import { assertArcSupported, readUnifiedBalance, isDelegateAuthorized, testnetSources } from "./unified-balance.ts";
import type { Address } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const dep = JSON.parse(readFileSync(resolve(HERE, "../deployments/testnet.json"), "utf8"));

const RPC = "https://rpc.testnet.arc.network";
const arc = { id: 5042002, name: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;

/** Addresses come from the same env keys the rest of the agent uses. */
function addrFrom(envKey: string): Address | null {
  const pk = process.env[envKey];
  if (!pk || !pk.startsWith("0x") || pk.length !== 66) return null;
  try { return privateKeyToAccount(pk as `0x${string}`).address; } catch { return null; }
}

async function main() {
  const user = (process.argv[2] as Address) ?? addrFrom("ALICE_PK") ?? addrFrom("USER_PK");
  const keeper = addrFrom("KEEPER_PK") ?? ("0x0000000000000000000000000000000000000000" as Address);
  if (!user) {
    console.error("用法: npm run reserve -- <borrower address>");
    console.error("  或设置 ALICE_PK / USER_PK 环境变量（keeper 地址取自 KEEPER_PK）");
    process.exit(1);
  }

  console.log("\n\x1b[1mFirebreak — 弹药报告\x1b[0m");
  console.log(`  borrower ${user}`);
  console.log(`  keeper   ${keeper}\n`);

  // ── 1. what is on Arc, under the Mandate ────────────────────────
  const client = createPublicClient({ chain: arc as any, transport: http(RPC) });
  let onArcWad = 0n, active = false;
  try {
    const [, isActive, reserve] = (await client.readContract({
      address: dep.mandate as Address, abi: mandateAbi, functionName: "mandateOf", args: [user],
    })) as [unknown, boolean, bigint];
    active = isActive; onArcWad = reserve;
    console.log(`  Arc 上的 Mandate: ${active ? "有效" : "\x1b[33m未注册\x1b[0m"}`);
    console.log(`  Arc 上的 reserve: ${fmt(onArcWad)}`);
  } catch (e) {
    console.log(`  \x1b[31mArc 读取失败\x1b[0m: ${(e as Error).message.slice(0, 90)}`);
  }

  // ── 2. what Circle Gateway actually supports ────────────────────
  let arcOk = false;
  try {
    const info = await assertArcSupported();
    arcOk = true;
    console.log(`\n  Circle Gateway: Arc Testnet 已支持 (chainId ${info.chainId}) \x1b[32m✓\x1b[0m`);
    const nets = (await testnetSources()).map((c) => c.chain).filter((c) => c !== "Arc_Testnet");
    console.log(`  可作为储备来源的测试网: ${nets.slice(0, 6).join(", ")}${nets.length > 6 ? ` …共 ${nets.length} 条` : ""}`);
  } catch (e) {
    console.log(`\n  \x1b[31mGateway 校验失败\x1b[0m: ${(e as Error).message.slice(0, 120)}`);
  }

  // ── 3. cross-chain balance + delegate authorization ─────────────
  let unifiedWad = 0n, delegated = false, balanceKnown = false;
  if (arcOk) {
    try {
      const snap = await readUnifiedBalance(user);
      unifiedWad = snap.totalWad; balanceKnown = true;
      console.log(`\n  跨链统一余额: ${fmt(unifiedWad)}`);
      for (const p of snap.perChain) if (p.amountWad > 0n) console.log(`      ${p.chain}: ${fmt(p.amountWad)}`);
      if (unifiedWad === 0n) {
        console.log("      \x1b[33m(尚未存入。deposit 需要在来源链上持有测试 USDC)\x1b[0m");
      }
    } catch (e) {
      console.log(`\n  \x1b[33m跨链余额未知\x1b[0m: ${(e as Error).message.slice(0, 100)}`);
    }
    delegated = await isDelegateAuthorized(user, keeper);
    console.log(`  keeper 的 delegate 授权: ${delegated ? "\x1b[32m已授权 ✓\x1b[0m" : "\x1b[33m未授权\x1b[0m"}`);
  }

  // ── 4. what the keeper would do ─────────────────────────────────
  const status = planRefill(onArcWad, unifiedWad, DEFAULT_POLICY);
  console.log(`\n  \x1b[1m决策\x1b[0m: ${describe(status, DEFAULT_POLICY)}`);
  if (status.needsRefill && !delegated) {
    console.log("  \x1b[33m需要补充，但 keeper 尚未被授权为 delegate — 借款人需先 addDelegate\x1b[0m");
  }
  if (!balanceKnown) {
    console.log("  \x1b[2m(跨链余额读取失败时按 0 计算，所以上面的决策是保守的)\x1b[0m");
  }
  console.log();
}

main().catch((e) => { console.error(e); process.exit(1); });
