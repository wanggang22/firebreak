# Firebreak — Implementation Plan

> 对齐 checkpoint：**CP2 = 7/26**（repo + 进度摘要）· **CP3 = 8/9**（MVP + 视频 + deck + repo）
> 纪律：TDD（先失败测试）· conventional commits · atomic · 每个任务完成即 commit
> 平台项目：Firebreak（projectId cefc2a81，主账号，DeFi 341 已关联，Agentic 342 待加）

## Week 1（7/15–7/19）— 合约核心 + 依赖验证

### T1. 脚手架 ✅(本 commit)
- repo + docs + foundry init + .gitignore + README

### T2. MockOracle + mock 抵押品（TDD）
- `test/MockOracle.t.sol`：setPrice/getPrice、非 owner revert
- `src/MockOracle.sol`、`src/MockERC20.sol`（mEURC、mTBILL，18 dec，公开 mint 限 owner）
- 验收：`forge test` 绿

### T3. MiniLend（TDD，最大的合约任务）
- `test/MiniLend.t.sol` 用例：
  - depositCollateral / withdraw（HF 检查内不许提到不健康）
  - borrow：原生 USDC 转出（池子预先 payable 注资）；LTV 上限
  - repay（payable，支持部分还款）
  - healthFactor：collateralValue × liqThreshold / debt（WAD 数学）
  - liquidate：HF < 1 才允许；10% penalty；清算人付 USDC 得抵押品
  - 边界：零抵押借款 revert、重复清算 revert、oracle 价格为 0 revert
- `src/MiniLend.sol` + `src/interfaces/IPosition.sol`（healthFactor/collateral/debt/操作的最小接口，MiniLend 实现之）
- 验收：forge test 绿，gas report 过目

### T4. 依赖验证 spike（与 T3 并行推进）
- App Kits Swap 在 Arc testnet：跑通一次 swap 或确认不可用
- Agent Stack starter kit：keeper 钱包能建能签
- 结论回填 DESIGN.md「Week-1 必须验证」小节，决定 Rotate 路径实现
- 时间盒：半天。超时即降级（MiniSwap + viem），不纠缠

## Week 2（7/20–7/26）— Mandate + agent v1 + **CP2 提交**

### T5. MiniSwap（TDD）
- 恒定乘积 AMM：原生 USDC ↔ mEURC/mTBILL；addLiquidity/swap/报价 view
- （若 T4 确认 App Kits 可用，MiniSwap 仍保留为 demo 深度可控的 fallback）

### T6. FirebreakMandate（TDD，核心合约）
- `test/FirebreakMandate.t.sol` 用例：
  - register/revoke Mandate；reserve 存取（payable）
  - rescue 前置校验：HF ≥ trigger 时 revert；非授权 keeper revert
  - 路径 A Deleverage：卖抵押品→repay，原子；花费 ≤ maxSpendPerRescue
  - 路径 B Rotate：swap 抵押品 X→Y，仓位健康度必须上升
  - 路径 C Top-up：动用 reserve repay
  - action 不在白名单 bitmask 内 revert
  - rescue 后 HF 必须 > rescue 前（不变量）
- `src/FirebreakMandate.sol`
- 验收：forge test 全绿 + 不变量 fuzz（rescue 永不降低 HF、永不超支）

### T7. 部署 Arc testnet + 部署记录
- 仿 arcpay deploy.sh：forge create + deployments/*.json 落盘
- 注资：MiniLend 池、MiniSwap 池、demo 用户钱包
- 验收：arcscan 上全部合约可见，一次手动 rescue 走通

### T8. Agent loop v1（先确定性，LLM W3 接入）
- monitor.ts（轮询 HF）+ executor.ts（规则版路径选择 + Mandate 边界校验 + 发 rescue）
- **真实链上跑通一次完整自救**，evidence/run-001.json 落盘
- 验收：tx hash 上 arcscan 可验

### T9. CP2 提交（deadline 7/26，目标 7/25 交）
- GitHub push public（wanggang22/firebreak）
- README 更新：架构图 + 已部署地址 + evidence 链接
- 平台 project 页交 mid-submission：repo link + progress summary
- **顺手：项目页把 Agentic Track (342) 也关联上（双赛道）**

## Week 3（7/27–8/2）— LLM 策略层 + 前端

### T10. strategist.ts：LLM 决策 + reasoning memo
- 输入信号快照（HF、价格、swap 报价、储备）→ JSON schema 约束输出 {action, params, memo}
- executor 改为消费 strategist 输出（保留链下+链上双重边界校验）
- 至少 3 次不同市况的真实链上自救，memo 各异，evidence 落盘

### T11. Dashboard（单页，直连 RPC）
- 仓位健康度仪表 + Mandate 状态 + 自救历史（memo 全文 + tx 链接 + saved $X 对比）
- 品牌：延续 ivory paper + forest green + Fraunces（自有视觉系统，视频/deck 同源）
- Circle Wallets email/PIN onboarding（Letta 验证过的集成，若 T4 结论允许）

## Week 4（8/3–8/9）— 打磨 + **CP3 提交**

### T12. Demo 视频（3 分钟，HyperFrames 管线）
- 剧本即 DESIGN.md「Demo 剧本」：签 Mandate → 汇率下跌 → memo 上屏 → 原子自救 → 对照组量化
- 真实链上 run 录屏 + arcscan 佐证

### T13. Deck + 提交包
- 问题→机制→Mandate→评分对照→path to production→accelerator 愿景
- CP3 表单（deadline 8/9 AoE，**目标 8/7 交**，平台到点锁死）
- ⚠️ 冲奖前置：把主账号显示名 Sinead Kaur 改回真名

### T14. Buffer + 复盘
- 8/8–8/9 留白吸收溢出；提交后 /retro

## 风险登记

| 风险 | 概率 | 缓解 |
|---|---|---|
| App Kits/Agent Stack testnet 不可用 | 中 | T4 时间盒半天，降级路径全自有（MiniSwap/viem） |
| Mandate 合约复杂度失控 | 中 | 三路径砍成 A+C 也能 demo；B (Rotate) 是加分不是地基 |
| testnet RPC 不稳/水龙头枯竭 | 低 | arcpay 期间已有经验；提前囤测试币 |
| 视频/deck 挤占 W4 | 中 | HyperFrames 管线现成（3 个项目用过）；T12 从 8/3 就开始 |
