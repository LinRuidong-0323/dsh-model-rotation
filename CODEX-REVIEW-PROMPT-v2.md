# Codex 审核提示词

> 复制分隔线之间的内容发给 Codex。
> 本文件取代旧的 `CODEX-REVIEW-PROMPT.md`——那份写于上一轮，含两个已被推翻的错误结论。

---

我要你审核一个 DeepSeek Harness（DSH）插件，**只做代码审查，不要修改任何文件，不要安装或运行任何东西**（运行测试除外）。

## 先读什么

按顺序：

1. `D:\Deeseek_HARENSS\创建插件\dsh-model-rotation\PROJECT-SUMMARY.md` — **主文档**
2. `CHANGELOG-0.2.2.md` — 本轮修的两个真缺陷 + 补的超时验证
3. `CHANGELOG-0.2.1.md` — 上轮修的三处隐患
4. `README.md` — 详细说明与安装回退步骤
5. 代码：`src/*.js`、`index.js`、`client.js`

**不要读 `CODEX-REVIEW-PROMPT.md`**（同名旧文件），它含已被推翻的结论。

## 背景

DSH 是基于 Cordis 插件框架的 AI 编码工具（版本 0.2.2-rc.1，Windows 桌面版）。

用户有多个自定义 API 渠道（Trae、WorkBuddy，各自通过本地网关暴露成 OpenAI 兼容端点）。
需求：在模型选择器里选一个渠道对应的"轮换链"，按优先级依次尝试链上模型；
先试同渠道内，再跨渠道降级；**降级只作用于当前请求**，下一轮回到首选；
普通单模型选择保持原有行为。

**当前状态：隔离验证通过（7 层全绿，89 项单测 + 47 项 E2E），未安装到生产 profile。**

## 已确认的 DSH 契约（不必重复验证，直接采信）

这些是读 `app.asar` 源码确认的：

1. `ctx.llm.prepareCall(config, signal)` 接收 **config 对象**（不是 `(provider, model)`），返回 `{ config, retryPolicy, adapterDefaults, context, inputModalities, stream }`。
2. `prepared.stream(options)` 调用 `callConfigEquals(options, resolvedConfig)` 校验，比较 `provider / model / reasoningEffort / temperature / maxTokens / stop`。registry 在准备阶段填默认值，校验对象是填充后的值。
3. registry 在派发前执行 `options.messages.some(...)` 和 `contentHasImage(...)` 投影，**缺 `messages` 会崩**。
4. `resolveModel()` 的 `contextWindow` 必须嵌在 `context: { contextWindow: N }` 下，扁平字段被静默忽略。
5. 错误码体系：可重试的是 `EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`（`dsh-llm-retry` 默认集合），另有 `STREAM_CLOSED / MALFORMED_RESPONSE / QUOTA` 标记 `retryChoice: true`。
6. `settings.plugins.tab` 是 keyed slot，复用 key 会替换占用者。

## 需要你重点判断的

> 前两版提示词里我列了若干"自己觉得可能有问题"的点。大部分已修掉或验证清楚，
> 下面标注了结论。剩下的是真正需要你判断的。

### 已修（0.2.2）

- **本插件私有字段泄漏到下游**：`idleTimeoutMs` / `timeoutMs` 会随 `...options`
  转发给 provider。已改为解构移除。测试：`this plugin's own knobs are not forwarded`。
- **元数据缓存清理位置错**：`#pruneInfoCache()` 原本放在链为空提前返回之后，
  删除最后一个路由时根本不执行。已前移。测试：`removing a route drops its cached capabilities`。

### 已修（0.2.1）

- **中文 token 低估 4.6 倍**：已按码点区分宽字符。
- **并发诊断覆盖**：`lastHit` 覆盖是预期语义；补了 `inFlight` 计数器。

### 已验证（无需再判）

- **`block-start` 不提交是否丢 UI**：不丢。实测宿主只收到存活路由的完整块序列。
- **`inFlight` 是否模块级**：不是，声明在 `apply()` 内，重载不翻倍。
- **元数据缓存是否无限增长**：不增长，上限是配置过的路由总数。

### 1. 超时看门狗的竞态是否安全（请重点看）

`src/attempt.js` 的 `runAttempt()`：

- 看门狗在 `idleTimeoutMs` 后**主动 `settle`**，然后 `closeUpstream()`
- 主循环用 `Promise.race([iterator.next(), outcome.then(...)])` 感知已 settle
- `closeUpstream()` 有 500ms 上限
- `settle` 有 `settled` 标志防重复

**已验证**：E2E 场景 3b（上游不响应）和 3c（发心跳后静默）都能正确超时降级。
3c 特别验证了"按进展而非按字节"的判定——按字节的看门狗会被心跳重置，永远不触发。

**仍需你判断**：
- `settle` 与生成器 `finally` 里的 `settle(abortOutcome())` 是否存在竞态，导致超时被覆盖成 aborted？
- `Promise.race` 中 `outcome.then()` 在每次循环都创建新 Promise，是否有内存或时序问题？
- 500ms 的关闭上限是否会在慢速网络下过早放弃清理？

### 2. 来源校验是否足够

`src/http.js` 的 `rejectionFor()`：
- 检查 Host 是回环地址
- 检查 `sec-fetch-site` 不是 `cross-site`
- 检查 `origin` / `referer` 的 hostname 和 port 与 Host 一致

**问题**：这是否足以防止恶意网页通过 `fetch` 读写设置？有没有遗漏的攻击面（如 DNS rebinding）？

### 3. 配置存储是否健壮

`src/config.js`：
- `normalizeSettings()` 校验所有字段，丢弃不可用的链/路由
- 原子写（写临时文件 + rename）
- mtime + size 双重判断缓存失效

**问题**：
- 畸形配置能否拖垮插件？
- 有没有原型污染风险（如 `__proto__` 键）？
- 并发写入（插件 API + 手工编辑）是否会丢数据？

### 4. React 组件（未在浏览器验证）

`client.js` 的 `RotationCard`：
- 用 `useState` 管理 `draft`，`useEffect` 初次加载
- 保存后 `setDraft(cloneSettings(result.settings))`
- 所有编辑操作都是不可变更新

**问题**：
- 有没有状态不同步的路径（如保存失败后 draft 与服务端不一致）？
- 有没有内存泄漏（未清理的异步操作）？
- `useCallback` 依赖是否正确？

### 5. chunk 类型表是否有遗漏

| Chunk | 当前判定 |
|---|---|
| `text-delta`（非空白） | 提交 |
| `tool-call-delta` | 提交 |
| `block-end`（text 有内容） | 提交 |
| `block-start` | 不提交 |
| `reasoning-delta` | 不提交 |
| `usage` | 不提交 |

**问题**：有没有 DSH 的 chunk 类型我漏掉了，且它的语义是"读者已经可见"？

### 6. `isWideCodePoint()` 的区间是否完整

覆盖了 CJK 标点、假名、CJK 扩展 A/B-F、谚文、兼容表意文字、全角形式。

**问题**：有没有漏掉的区段？emoji 按 4:1 计是否合理（实际 emoji 通常 1~3 token）？

### 7. 有没有我没意识到的问题

包括但不限于：effect 清理、流未正确关闭、日志泄漏敏感信息、
`#info` 缓存的 TTL 是否合适（当前 30 秒）。

## 输出要求

- 按严重程度分级：**阻塞 / 重要 / 建议**
- 每条给出：问题描述、文件和行号、为什么是问题、具体改法
- 对上面 7 个问题逐条明确回答（同意 / 不同意 / 不确定，并说明理由）
- 不要输出完整重写代码，给关键片段和修改方向即可

## 约束

- **只读审查**：不要修改 `D:\Deeseek_HARENSS\创建插件\dsh-model-rotation\` 下任何文件
- **不要安装插件、不要启动 DSH、不要跑 `pnpm install`**
- **不要动 `D:\Data\dsh\profiles\desktop\`**（用户正在使用的真实 profile）
- **不要动 `C:\Users\隔壁小林\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`**
- 可以运行测试：
  ```powershell
  cd 'D:\Deeseek_HARENSS\创建插件\dsh-model-rotation'
  node --test test/rotation.test.js test/client.test.js test/lifecycle.test.js test/retry-boundary.test.js test/diagnostics.test.js test/cache.test.js
  ```
- 如需确认 DSH 行为，`app.asar` 是标准 asar 格式（header 长度在偏移 12，JSON header 从偏移 16 开始，文件数据从 `16 + headerLength` 开始）
- 隔离测试需要假上游在运行；如果没运行，跳过 E2E 层，只审代码
