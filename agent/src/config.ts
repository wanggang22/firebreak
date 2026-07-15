// Deployment config. Written by the Forge deploy/scenario scripts to
// deployments/<network>.json, loaded here. Token metadata (symbol, isStable)
// is keeper policy, not on-chain state, so it lives alongside.

import { readFileSync } from "node:fs";
import type { Address } from "./types.ts";

export interface TokenMeta {
  token: Address;
  symbol: string;
  isStable: boolean; // rotate target candidate (low expected drift)
}

export interface Deployment {
  network: string;
  oracle: Address;
  pool: Address;
  amm: Address;
  mandate: Address;
  tokens: TokenMeta[];
}

export function loadDeployment(path: string): Deployment {
  return JSON.parse(readFileSync(path, "utf8")) as Deployment;
}
