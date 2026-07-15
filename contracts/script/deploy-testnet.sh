#!/usr/bin/env bash
# Deploy Firebreak to Arc testnet via forge create + cast send, one tx at a time
# with spacing to stay under the public RPC's burst limit. Keys come from env;
# never echoed. Writes resolved addresses to deploy-out.env.
set -u
export PATH="$HOME/.foundry/bin:$PATH"

RPC=https://rpc.testnet.arc.network
GAP=${GAP:-4}
OUT="$(dirname "$0")/deploy-out.env"
: > "$OUT"

DEP=$DEPLOYER_PK
ALICE=$ALICE_PK
KEEPER=$KEEPER_ADDR
DEPLOYER_ADDR=$(cast wallet address --private-key "$DEP")
ALICE_ADDR=$(cast wallet address --private-key "$ALICE")

cf() { # create a contract: cf VARNAME "src:Name" [constructor args...]
  local var=$1; shift; local what=$1; shift
  local addr=""
  local i
  for i in 1 2 3 4 5 6; do
    addr=$(forge create "$what" --rpc-url "$RPC" --private-key "$DEP" --broadcast "$@" 2>&1 \
             | grep -oiE "Deployed to: 0x[0-9a-fA-F]{40}" | grep -oiE "0x[0-9a-fA-F]{40}")
    [ -n "$addr" ] && break
    echo "  retry $i for $var (rate-limited?)..."; sleep 20
  done
  if [ -z "$addr" ]; then echo "FATAL: $var deploy failed"; exit 1; fi
  echo "${var}=${addr}" | tee -a "$OUT"
  eval "$var=$addr"
  sleep "$GAP"
}

send_retry() { # send_retry <pk> <to> <sig> [args...]
  local pk=$1; shift; local i
  for i in 1 2 3 4 5 6; do
    if cast send "$1" "$2" "${@:3}" --rpc-url "$RPC" --private-key "$pk" >/dev/null 2>/tmp/fb_send_err; then
      sleep "$GAP"; return 0
    fi
    echo "  send $2 retry $i (rate-limited?)"; sleep 20
  done
  echo "FATAL send $2:"; cat /tmp/fb_send_err; exit 1
}
sd() { send_retry "$DEP" "$@"; }
sa() { send_retry "$ALICE" "$@"; }

echo ">> deploying contracts"
cf ORACLE  "src/MockOracle.sol:MockOracle"
cf MEURC   "src/MockERC20.sol:MockERC20" --constructor-args "Mock EURC" "mEURC"
cf MTBILL  "src/MockERC20.sol:MockERC20" --constructor-args "Mock T-Bill" "mTBILL"
cf POOL    "src/MiniLend.sol:MiniLend" --constructor-args "$ORACLE"
cf AMM     "src/MiniSwap.sol:MiniSwap"
cf MANDATE "src/FirebreakMandate.sol:FirebreakMandate"

echo ">> oracle prices + listings"
sd "$ORACLE" "setPrice(address,uint256)" "$MEURC" 1080000000000000000
sd "$ORACLE" "setPrice(address,uint256)" "$MTBILL" 1000000000000000000
sd "$POOL" "listCollateral(address,uint256,uint256)" "$MEURC" 700000000000000000 800000000000000000
sd "$POOL" "listCollateral(address,uint256,uint256)" "$MTBILL" 800000000000000000 900000000000000000

echo ">> fund pool + seed amm"
sd "$POOL" "fund()" --value 5500000000000000000
sd "$MEURC" "mint(address,uint256)" "$DEPLOYER_ADDR" 1000000000000000000000
sd "$MTBILL" "mint(address,uint256)" "$DEPLOYER_ADDR" 1000000000000000000000
sd "$MEURC" "approve(address,uint256)" "$AMM" 1000000000000000000000
sd "$MTBILL" "approve(address,uint256)" "$AMM" 1000000000000000000000
sd "$AMM" "addLiquidity(address,uint256)" "$MEURC" 370000000000000000 --value 400000000000000000
sd "$AMM" "addLiquidity(address,uint256)" "$MTBILL" 400000000000000000 --value 400000000000000000
sd "$MEURC" "mint(address,uint256)" "$ALICE_ADDR" 10000000000000000000

echo ">> alice opens position + signs mandate"
sa "$MEURC" "approve(address,uint256)" "$POOL" 1000000000000000000000
sa "$POOL" "depositCollateral(address,uint256)" "$MEURC" 10000000000000000000
sa "$POOL" "borrow(uint256)" 5000000000000000000
sa "$POOL" "setOperator(address,bool)" "$MANDATE" true
sa "$MANDATE" "register((address,address,address,uint256,uint256,uint8))" \
   "($POOL,$AMM,$KEEPER,1200000000000000000,50000000000000000000,7)" --value 1000000000000000000

echo ">> FX drift EURC 1.08 -> 0.70"
sd "$ORACLE" "setPrice(address,uint256)" "$MEURC" 700000000000000000

echo ">> done"
HF=$(cast call "$POOL" "healthFactor(address)(uint256)" "$ALICE_ADDR" --rpc-url "$RPC")
echo "ALICE_ADDR=$ALICE_ADDR" | tee -a "$OUT"
echo "HF=$HF" | tee -a "$OUT"
