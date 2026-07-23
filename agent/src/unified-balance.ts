// Circle Unified Balance — the cross-chain side of the reserve.
//
// This is the I/O half of ammunition management; the policy half (when and how
// much to refill) lives in reserve.ts as pure functions. Keeping them apart
// means the arithmetic that decides how much of a borrower's money to move is
// unit-tested without a network, and this file stays a thin, auditable shim.
//
// Chain support is read live from Circle Gateway rather than hardcoded, so a
// wrong assumption surfaces as an error here instead of a silent mis-send.
import { UnifiedBalanceKit, UnifiedBalanceChain } from "@circle-fin/unified-balance-kit";
import { parseEther, formatEther } from "viem";
import type { Address } from "./types.ts";

/** Arc testnet, as Firebreak already knows it. Cross-checked against Gateway. */
export const ARC_TESTNET_CHAIN_ID = 5042002;

export interface ChainInfo {
  chain: string;
  chainId: number;
  isTestnet: boolean;
  usdcAddress?: string;
  explorerUrl?: string;
}

let kit: UnifiedBalanceKit | null = null;
export function getKit(): UnifiedBalanceKit {
  if (!kit) kit = new UnifiedBalanceKit();
  return kit;
}

/** Live chain list from Gateway. Throws if the network is unreachable. */
export async function supportedChains(): Promise<ChainInfo[]> {
  const raw = await getKit().getSupportedChains();
  const list = Array.isArray(raw) ? raw : ((raw as any)?.chains ?? []);
  return list as ChainInfo[];
}

/**
 * Confirm Gateway agrees with us about Arc before moving any money. A chain-id
 * mismatch means our constant is stale, and sending to a stale chain id is how
 * funds get lost — so this is a hard failure, not a warning.
 */
export async function assertArcSupported(): Promise<ChainInfo> {
  const chains = await supportedChains();
  const arc = chains.find((c) => c.chain === UnifiedBalanceChain.Arc_Testnet);
  if (!arc) {
    throw new Error(
      `Circle Gateway does not list ${UnifiedBalanceChain.Arc_Testnet} as supported. ` +
        `Refusing to route a refill through a chain the provider does not acknowledge.`,
    );
  }
  if (arc.chainId !== ARC_TESTNET_CHAIN_ID) {
    throw new Error(
      `Arc chain id mismatch: Gateway says ${arc.chainId}, Firebreak expects ${ARC_TESTNET_CHAIN_ID}.`,
    );
  }
  return arc;
}

/** Testnets a borrower can realistically hold reserve USDC on. */
export async function testnetSources(): Promise<ChainInfo[]> {
  return (await supportedChains()).filter((c) => c.isTestnet);
}

export interface UnifiedBalanceSnapshot {
  totalWad: bigint;
  perChain: { chain: string; amountWad: bigint }[];
}

/**
 * Total spendable USDC across every chain the borrower holds it on.
 *
 * Gateway reports human-decimal strings; we normalise to 18-dec wei because
 * that is what Arc's native USDC and every Firebreak bound already use. Mixing
 * the two is the obvious way to overspend by six orders of magnitude.
 */
export async function readUnifiedBalance(owner: Address): Promise<UnifiedBalanceSnapshot> {
  const res: any = await getKit().getBalances({
    token: "USDC",
    sources: [{ address: owner }],
  } as any);

  const perChain: { chain: string; amountWad: bigint }[] = [];
  for (const b of res?.breakdown ?? []) {
    const human = String(b.confirmedBalance ?? b.balance ?? "0");
    perChain.push({ chain: String(b.chain ?? "?"), amountWad: parseEther(human as `${number}`) });
  }
  const totalHuman = String(res?.totalConfirmedBalance ?? "0");
  return { totalWad: parseEther(totalHuman as `${number}`), perChain };
}

/** Is the keeper currently authorized to spend this borrower's balance? */
export async function isDelegateAuthorized(owner: Address, delegate: Address): Promise<boolean> {
  try {
    const st: any = await getKit().getDelegateStatus({
      token: "USDC",
      owner,
      delegate,
    } as any);
    return Boolean(st?.isDelegate ?? st?.authorized ?? false);
  } catch {
    return false;                                    // unknown → treat as not authorized
  }
}

/**
 * Move `amountWad` of the borrower's cross-chain USDC onto Arc, to `recipient`.
 *
 * The keeper signs as the borrower's delegate; the borrower stays the owner and
 * can revoke with removeDelegate at any time — the same shape as revoking the
 * Mandate on Arc. Verified against Gateway's own chain list first.
 */
export async function spendToArc(args: {
  owner: Address;
  recipient: Address;
  amountWad: bigint;
  fromAdapter: unknown;
  toAdapter: unknown;
}): Promise<{ ok: true; result: unknown } | { ok: false; reason: string }> {
  try {
    await assertArcSupported();
    const result = await getKit().spend({
      token: "USDC",
      // formatEther, never Number(). Number() loses the low digits of an
      // 18-decimal amount (…456789 becomes …4567) and renders small values in
      // exponent form ("1e-9"), either of which sends the wrong amount or none.
      amount: formatEther(args.amountWad),
      from: { adapter: args.fromAdapter },
      to: {
        adapter: args.toAdapter,
        chain: UnifiedBalanceChain.Arc_Testnet,
        recipientAddress: args.recipient,
      },
    } as any);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
