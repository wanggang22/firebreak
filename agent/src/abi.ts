// Hand-written minimal ABIs for the calls the keeper makes. Kept small and
// readable; the source of truth is contracts/src/*.sol.

export const miniLendAbi = [
  { type: "function", name: "healthFactor", stateMutability: "view", inputs: [{ name: "user", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "debtOf", stateMutability: "view", inputs: [{ name: "user", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "collateralOf", stateMutability: "view", inputs: [{ name: "user", type: "address" }, { name: "token", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "listings", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ name: "listed", type: "bool" }, { name: "ltvWad", type: "uint256" }, { name: "liqThresholdWad", type: "uint256" }] },
] as const;

export const miniSwapAbi = [
  { type: "function", name: "getUsdcOut", stateMutability: "view", inputs: [{ name: "token", type: "address" }, { name: "tokenIn", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getTokenOut", stateMutability: "view", inputs: [{ name: "token", type: "address" }, { name: "usdcIn", type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;

export const oracleAbi = [
  { type: "function", name: "getPrice", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "setPrice", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }, { name: "priceWad", type: "uint256" }], outputs: [] },
] as const;

// Plan tuple mirrors FirebreakMandate.Plan (order matters for abi encoding).
const planComponents = [
  { name: "action", type: "uint8" },
  { name: "collateralToken", type: "address" },
  { name: "collateralAmount", type: "uint256" },
  { name: "rotateTo", type: "address" },
  { name: "minSwapOut", type: "uint256" },
  { name: "minSwapOut2", type: "uint256" },
  { name: "topUpAmount", type: "uint256" },
] as const;

const termsComponents = [
  { name: "pool", type: "address" },
  { name: "swapVenue", type: "address" },
  { name: "keeper", type: "address" },
  { name: "hfTrigger", type: "uint256" },
  { name: "maxSpendPerRescue", type: "uint256" },
  { name: "maxSlippageWad", type: "uint256" },
  { name: "minImprovementWad", type: "uint256" },
  { name: "allowedActions", type: "uint8" },
] as const;

export const mandateAbi = [
  {
    type: "function",
    name: "register",
    stateMutability: "payable",
    inputs: [{ name: "terms", type: "tuple", components: termsComponents }],
    outputs: [],
  },
  { type: "function", name: "revoke", stateMutability: "nonpayable", inputs: [], outputs: [] },
  {
    type: "function",
    name: "rescue",
    stateMutability: "nonpayable",
    inputs: [
      { name: "user", type: "address" },
      { name: "plan", type: "tuple", components: planComponents },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "mandateOf",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      {
        name: "terms",
        type: "tuple",
        components: [
          { name: "pool", type: "address" },
          { name: "swapVenue", type: "address" },
          { name: "keeper", type: "address" },
          { name: "hfTrigger", type: "uint256" },
          { name: "maxSpendPerRescue", type: "uint256" },
          { name: "maxSlippageWad", type: "uint256" },
          { name: "minImprovementWad", type: "uint256" },
          { name: "allowedActions", type: "uint8" },
        ],
      },
      { name: "active", type: "bool" },
      { name: "reserve", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "RescueExecuted",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "action", type: "uint8", indexed: false },
      { name: "spent", type: "uint256", indexed: false },
      { name: "hfBefore", type: "uint256", indexed: false },
      { name: "hfAfter", type: "uint256", indexed: false },
    ],
  },
] as const;

export const ACTION = { DELEVERAGE: 1, ROTATE: 2, TOPUP: 4 } as const;
export type Action = (typeof ACTION)[keyof typeof ACTION];
