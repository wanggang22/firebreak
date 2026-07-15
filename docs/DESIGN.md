# Firebreak — Design Doc

> **Programmable Money Hackathon (Encode × Arc × Circle) · 2026-07-13 → 08-09**
> Tracks: **DeFi**（主）+ **Agentic Economy**（双赛道提交）
> Status: approved 2026-07-15

## One-liner

**Firebreak — 稳定币借贷的清算防火墙。** 非托管 keeper agent：借款人签一份带边界的链上委托（Mandate），agent 盯着健康度，在清算人到场之前执行最便宜的那条自救路径，USDC 亚秒结算。

> *"Liquidation is a fire. By the time you smell smoke, it's too late. Firebreak is the line the fire can't cross."*

## Problem

清算是双输：借款人被罚 5–15% 押金，协议损失一个本可存活的仓位。绝大多数清算不是黑天鹅，是仓位没人看着——健康度慢慢滑过线。以太坊上 DeFi Saver / Instadapp 验证了付费意愿；**Arc 上这个位置是空的**。

**为什么在 Arc 上这个问题形态更好**：Arc 是稳定币原生链，抵押品是 EURC（外汇敞口）、代币化国债、RWA——健康度恶化是**缓慢漂移**（汇率、折价）而非闪崩。漂移恰恰是自动化最擅长、人类最容易忽略的。加上亚秒结算（自救抢在清算人前）和 USDC 计价 gas（keeper 经济学与省下的钱同单位），叙事成立。

## Core loop

```
用户签 Mandate（链上委托，带硬边界）
  → agent 监控健康度 HF（真实链上信号）
  → HF < 阈值 → agent 比价三条自救路径：
      A. Deleverage：卖一部分抵押品还债（降杠杆）
      B. Rotate：把下跌的抵押品换成稳的（换仓）
      C. Top-up：动用用户预存的救援储备金还债（补仓）
  → LLM 选最便宜路径 + 写 reasoning memo（可解释）
  → 确定性执行：单笔原子交易在 Mandate 边界内完成自救
```

## Trust model — Mandate 是灵魂

用户签的不是"把钱给你"，而是一条**带边界的条件指令**：

```
Mandate {
  pool,                // 守护哪个借贷仓位
  hfTrigger,           // 只有 HF 低于此值才允许行动
  maxSpendPerRescue,   // 单次自救花费上限
  allowedActions,      // 路径白名单 (bitmask: DELEVERAGE | ROTATE | TOPUP)
  keeper,              // 授权的 keeper 地址
  reserve              // 可选：预存的原生 USDC 救援储备
}
```

资金永不离开用户仓位/Mandate 合约；keeper 只有触发条件内的受限执行权。
这同时是 DeFi 赛道判分原文 *"conditional payments, onchain automation, multi-step settlement"* 的逐字实现。

## Agent 架构 — LLM 决策、合约执行

- **执行必须确定性**：真金白银的动作不靠 LLM 现场发挥。
- **LLM 在策略层**：评估三条路径的取舍（swap 深度、费用、再触发概率），输出选择 + 书面 reasoning memo。Letta 已验证这个模式的评委缘。
- 架构：**LLM 决策 + memo（可解释）→ 确定性合约执行（可审计）→ Mandate 约束（可信任）**。
- Agentic 赛道判分 *"clear decision logic tied to real signals"*：健康度、汇率、swap 报价，全是真实链上信号。

## Chain facts（决定合约设计）

| 参数 | 值 |
|---|---|
| chainId | `5042002`（Arc Testnet） |
| RPC | `https://rpc.testnet.arc.network` |
| Explorer | `https://testnet.arcscan.app` |
| **USDC** | **原生 gas 币，18 decimals** —— 借贷池吐出/收回的是原生币（payable），不是 ERC20 |
| 抵押品 | 我们部署的 ERC20 mock（mEURC、mTBILL），18 decimals 统一，避免小数换算 bug |

## Contracts（全部窗口内新写，Foundry + TDD）

| 合约 | 职责 |
|---|---|
| `MockOracle` | `setPrice(token, priceWad)` —— demo 可控价格源（testnet 无真 oracle；可控性反而让 demo 剧本可编排） |
| `MiniLend` | 靶场借贷池：`depositCollateral / borrow(native out) / repay(payable) / healthFactor / liquidate(10% penalty)`。**通过 `IPosition` 适配器接口暴露**，Firebreak 本体协议无关 |
| `MiniSwap` | 极简恒定乘积 AMM：原生 USDC ↔ ERC20 抵押品（App Kits Swap 不可用时的降级路径，也是 demo 可控深度） |
| `FirebreakMandate` | 核心：注册/撤销 Mandate、托管救援储备、`rescue(user, plan)` —— 链上校验 HF < trigger、plan 在边界内，原子执行 A/B/C 路径 |

**协议无关（IPosition adapter）**：keeper 对接的是 `IPosition`（健康度 + 抵押操作的最小接口），MiniLend 只是第一个适配器。叙事从"玩具池+机器人"变成"兼容 Arc 上任何借贷协议的清算防火墙基础设施"——判分第 3 条 *credible path to production* 的答案。

## Agent（TypeScript, viem）

- `monitor.ts`：轮询 HF（+汇率、swap 报价快照）
- `strategist.ts`：LLM（Claude）输入信号快照 → 输出 `{action, params, memo}`（JSON schema 约束）
- `executor.ts`：校验 LLM 输出在 Mandate 边界内（**双重校验：链下先验 + 链上合约再验**）→ 发 `rescue()` 交易
- `evidence/`：每次自救落盘 run.json（信号、memo、tx hash、省了多少钱 vs 清算罚金）—— Letta 证明过 evidence pack 的价值

## Demo 剧本（3 分钟视频的骨架）

1. Alice 抵押 mEURC 借原生 USDC，签 Mandate（hfTrigger 1.2，上限、白名单、预存储备）
2. Oracle 推 EURC/USD 下跌 → HF 从 1.8 滑向 1.15
3. Firebreak 触发：LLM memo 上屏（"Rotate 成本 0.3% vs Deleverage 0.5% vs 清算罚 10% → 选 Rotate"）→ 单笔原子 tx 自救 → HF 回 1.6
4. **对照组**：同样仓位无 Firebreak → 被清算，损失 10%。屏幕上并排量化：`saved $X (Y%)`
5. Sub-second finality、USDC gas、arcscan 链接全程可验

## Week-1 必须验证的外部依赖

- [ ] **App Kits**（Swap/Send）在 Arc testnet 可用？→ 可用则 Rotate 路径走 App Kits（判分第 2 条）；不可用降级 MiniSwap
- [ ] **Agent Stack** starter kit 接钱包可行？→ 可用则 keeper 钱包走 Agent Stack；不可用降级 viem 裸钱包
- [ ] **Circle Wallets**（email/PIN，Letta 已跑通过的模式）→ 用户端 onboarding，W3 再接

结论回填本节。**无论验证结果如何，产品都能完成**——降级路径全部自有。

## 判分对照表

| 判分标准 | Firebreak 的回答 |
|---|---|
| 1. Arc & USDC integration | 全部合约部署 Arc testnet；原生 USDC 借贷/结算/gas |
| 2. 用对核心产品 | App Kits Swap（Rotate 路径）、Agent Stack（keeper 钱包）、Circle Wallets（用户 onboarding）——W1 验证，有降级 |
| 3. Use case & impact | 真实问题（以太坊付费意愿已验证）+ IPosition 协议无关 = path to production |
| 4. Execution & presentation | 对照组量化 demo（saved $X vs 清算罚金）、reasoning memo 上屏、arcscan 全程可验 |

## 不做的（YAGNI）

- ❌ 多用户仪表盘/批量仓位管理（单仓位 MVP，表格是 UI 糖）
- ❌ 真实 oracle 集成（testnet 无；mock 即 demo 优势）
- ❌ Mandate 收费/订阅模型（提一句 roadmap 即可）
- ❌ 主网部署、审计、治理

## Honest weaknesses（评委可能戳的点 + 应答）

- **"自导自演的靶场池"** → IPosition 适配器 + "第一个适配器" 叙事
- **testnet 无真实用户** → 所有 testnet 黑客松同题；靠对照组量化 + path to production 论述
- **LLM 决策金融动作的安全性** → LLM 只选策略不碰执行；双重边界校验；memo 可审计
