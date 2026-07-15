// viem clients for Arc testnet (native USDC gas, 18-decimal wei) or local anvil.
// Mirrors the pattern proven in the Letta project (arcpay/letta/src/chain.ts).

import { createPublicClient, createWalletClient, http, defineChain, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const ARC_TESTNET = {
  chainId: 5042002,
  name: "Arc Testnet",
  rpc: "https://rpc.testnet.arc.network",
  explorer: "https://testnet.arcscan.app",
} as const;

/** RPC override lets the same code target local anvil (http://127.0.0.1:8545). */
export function arcChain(): Chain {
  const rpc = process.env.RPC ?? ARC_TESTNET.rpc;
  const id = process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : ARC_TESTNET.chainId;
  return defineChain({
    id,
    name: id === ARC_TESTNET.chainId ? ARC_TESTNET.name : `Local ${id}`,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
}

export function publicClient() {
  return createPublicClient({ chain: arcChain(), transport: http() });
}

export function walletFor(pk: `0x${string}`) {
  return createWalletClient({ account: privateKeyToAccount(pk), chain: arcChain(), transport: http() });
}

export const txUrl = (hash: string) => `${ARC_TESTNET.explorer}/tx/${hash}`;
