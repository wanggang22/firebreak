export const WAD = 10n ** 18n;

export type Address = `0x${string}`;

/** A listed collateral, as the keeper sees it. */
export interface Collateral {
  token: Address;
  symbol: string;
  amount: bigint; // user's balance (wei)
  priceWad: bigint; // native USDC per token (WAD)
  ltWad: bigint; // liquidation threshold (WAD)
  isStable: boolean; // rotate target candidate (low drift)
}

/** A snapshot of everything the strategist reasons over — all real on-chain. */
export interface Signals {
  user: Address;
  hf: bigint; // WAD; MAX_UINT when no debt
  debt: bigint; // native USDC wei
  collaterals: Collateral[];
  /** quote fn: USDC out for selling `amt` of `token` (from the swap venue). */
  quoteUsdcOut: (token: Address, amt: bigint) => bigint;
}

export interface Terms {
  hfTriggerWad: bigint;
  maxSpendPerRescue: bigint; // max collateral VALUE (oracle) moved per rescue
  maxSlippageWad: bigint; // swap must recover >= (1 - this) of collateral value
  minImprovementWad: bigint; // rescue must lift HF by at least this
  keeperFee: bigint; // flat fee paid to the keeper from reserve on success
  allowedActions: number; // bitmask
  reserve: bigint; // prepaid native USDC
}

export interface Plan {
  action: number; // 1|2|4
  collateralToken: Address;
  collateralAmount: bigint;
  rotateTo: Address;
  minSwapOut: bigint;
  minSwapOut2: bigint;
  topUpAmount: bigint;
}

export interface Decision {
  plan: Plan | null;
  memo: string; // human-readable reasoning, surfaced in the demo + dashboard
}

export const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Address;
export const ACTION = { DELEVERAGE: 1, ROTATE: 2, TOPUP: 4 } as const;
