# 变更说明 — dsh-model-rotation 0.2.0

> 本轮目标：把插件从"未完成、未验证"推进到"隔离验证通过、可实际使用"。
> **未安装到生产 profile**，安装需用户明确授权。

---

## 一、本轮完成的工作

### 1.1 推翻并修正了上一轮的根因判断

上一轮 README 断言"虚拟 provider 与 DSH 的消息来源追踪根本冲突"。**这个判断是错的。**

真实根因：`src/adapter.js` 转发请求时用了

```js
const forwarded = { ...(prepared.config ?? options), provider, model }
```

`prepared.config` 只含 6 个控制字段（provider/model/reasoningEffort/temperature/maxTokens/stop），
**`messages`、`tools`、系统提示全被丢弃**。DSH 在 dispatch 前执行

```js
let projectedMessages = resolvedOptions.messages
if (projectedMessages.some(message => contentHasFile(message.content)))   // ← 这里炸
```

`messages` 是 `undefined`，于是报 `Cannot read properties of undefined (reading 'some')`。
错误发生在插件的 `#stream` 被调用**之前**，所以上一轮误判成架构冲突。

修复后最小复现立即通过，**虚拟 provider 方案可行**，无需改写成 `llm/stream`。

### 1.2 新增模块

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/attempt.js` | 328 | 单次尝试的流式与提交语义、超时看门狗、上游清理 |
| `src/capability.js` | 127 | 图像/工具/上下文能力筛选 |
| `src/http.js` | 160 | 设置 HTTP 接口（含来源校验） |
| `client.js` | 446 | 设置卡片（React，注入 `settings.plugins.tab`） |

### 1.3 重写模块

| 文件 | 变化 |
|---|---|
| `src/adapter.js` | 请求体完整转发、能力筛选、提交后固定路由、失败摘要、hooks |
| `index.js` | 挂载设置 API、收集诊断、可选能力容错 |
| `test/rotation.test.js` | 28 → 48 项，覆盖提交语义、能力筛选、并发、清理 |

### 1.4 新增测试

| 文件 | 项数 | 覆盖 |
|---|---|---|
| `test/client.test.js` | 8 | 设置卡片纯函数 |
| `test/lifecycle.test.js` | 7 | 挂载/卸载、effect 释放 |
| `test/retry-boundary.test.js` | 6 | 与 `dsh-llm-retry` 的边界 |

---

## 二、架构选择依据

### 2.1 虚拟 provider vs `llm/stream` waterfall

| 维度 | 虚拟 provider（采用） | `llm/stream` waterfall |
|---|---|---|
| 用户可选"链" | ✅ 选择器里直接是一个条目 | ❌ 无法表达 |
| 单模型选择不受影响 | ✅ 完全不走这条路径 | ⚠️ 需要自己判断是否介入 |
| 请求体控制 | ✅ 完全掌握 | ⚠️ 需接管整个生命周期 |
| 与 `source` 记录 | ✅ 记录为链 id，语义正确 | ⚠️ 改写 provider 可能触发 source 重写 |
| 改动量 | 中（本次已实现） | 大 |

**结论**：需求是"在选择器里选一条链"，这正是虚拟 provider 的语义。隔离验证已证明可行，
不需要为了"更底层"而重写。

社区同类实现 `dsh-llm-fallbacks`（MIT，26 星）也走虚拟 provider 路线，佐证了该判断。

### 2.2 提交语义的选择

目标要求"首个对外正文或工具调用提交后立即流式输出并固定路由"。

**关键决策**：`block-start` **不**提交。

理由：一个 text 块开始后可能最终为空（模型开了块但没产出）。如果 `block-start` 提交，
那么"仅思考后失败"的路由无法降级——这正是隔离测试暴露的缺陷（初版实现在场景 5 失败）。
只有非空 `text-delta`、`tool-call-delta`、有内容的 `block-end` 才提交。

---

## 三、测试证据

### 3.1 七层测试全绿

```
单元测试          80 / 80
隔离 E2E          40 / 40
真实 agent 流程   14 / 14
多轮续接           8 / 8
设置接口          17 / 17
README 核对       全部通过
```

一键复跑：`node 'D:\Deeseek_HARENSS\创建插件\_isolation\verify-all.mjs'`

### 3.2 真实 agent 流程（最重要的验证层）

目标明确要求"使用真实 DSH 的 prepareCall、waterfall、消息投影和 **agent 流程**"。

前几轮只验证了前三项，**缺少 agent 流程**。本轮补上：

链作为 profile 默认模型，由真实 agent 轮次发起调用：

| 场景 | 证据 |
|---|---|
| 首选成功 | agent exit=0，回答 `primary-ok`，上游收到 3 条消息 |
| 限流降级 | agent exit=0，回答 `backup-ok` |
| 下一请求回首选 | 恢复后 `primary-ok`，backup 0 次 |
| 全部失败 | agent exit=1，错误列出全部三条路由 |

**这一层同时推翻了一个旧结论**：早期判断"默认模型不能指向插件 provider"，
实际是 adapter 丢 `messages` 导致的崩溃，错误信息误导了归因。修好后链可直接作默认模型。

### 3.3 多轮续接（目标第 7 项的验证）

目标要求"验证持久化 source、replay、后续轮次及工具结果能够正确继续"。

同一会话连续四轮：

| 轮次 | 证据 |
|---|---|
| 第一轮 | `primary-ok` |
| 第二轮 | `primary-ok`，上游收到 **6 条消息**（历史持久化并传递） |
| 第三轮（primary 限流） | `backup-ok`，**跨 provider 切换** |
| 第四轮（primary 恢复） | `primary-ok`，**回到链头** |

关键：第三轮由 backup 服务后，第四轮仍能回到 primary 并带上完整历史。

### 3.4 隔离 E2E 的真实性

不是桩测试。每个场景：

1. 启动**真实 DSH 进程**（独立 `DSH_HOME`，不碰生产 profile）
2. 探针插件调用**真实** `ctx.llm.prepareCall()` / `prepared.stream()`
3. 请求打到**假上游**（三个独立端点，可分别控制行为）
4. **断言假上游实际收到的内容**：消息数、工具名、系统提示长度、调用次数

关键断言示例（场景 1）：

```
PASS  primary 收到 1 次           — count=1
PASS  backup 未被调用             — count=0
PASS  假上游收到完整消息          — messageCount=3
PASS  假上游收到工具声明          — tools=["read_file"]
PASS  系统提示到达上游            — chars=26
```

这些断言直接捕获了"请求体被丢弃"的缺陷——如果 `messages` 没转发，`messageCount` 会是 0。

### 3.3 验证中发现并修复的缺陷

| 缺陷 | 如何发现 | 修复 |
|---|---|---|
| 请求体被丢弃 | E2E 场景全部报 `.some` 错误 | 转发 `{...options, ...prepared.config, provider, model}` |
| 超时死锁 | 单测进程挂起 120s+ | 看门狗主动 settle + race `next()` + 关闭设 500ms 上限 |
| 块开始误判为提交 | E2E 场景 5 失败 | `block-start` 不再提交 |
| `contextWindow` 位置错 | 单测断言 `undefined` | 改为 `context: { contextWindow }` |
| 测试状态污染 | 场景间计数串味（primary=3 而非 1） | 假上游用 sentinel 标记区分探针请求 |
| **旧结论错误** | 真实 agent 流程验证 | "默认模型不能指向插件 provider"是 adapter bug 的误归因，已修正 |

---

## 四、未完成的项（明确标注）

### 4.1 图像能力筛选未端到端验证

**原因**：DSH 在 dispatch 前解析 `attachment.attachmentId`，伪造的附件会被拒绝
（实测报 `Cannot read properties of undefined (reading 'attachmentId')`），
无法在隔离环境构造合法的图像请求。

**已覆盖**：`requestHasImage()` 和 `routeCanServe()` 的图像分支有离线测试；
上下文窗口分支（同一条 `routeCanServe` 代码路径）已端到端验证。

**影响**：图像路由逻辑本身经过单测，但"真实请求带图时跳过无视觉路由"未在完整链路验证。

### 4.2 设置卡片未做真实浏览器渲染验证

**原因**：需要重启生产 DSH 并在 GUI 中操作。

**已覆盖**：卡片纯函数（深拷贝、排序、id 生成）8 项单测；HTTP 接口 17 项测试；
`apply()` 正确注册到 `settings.plugins.tab`。

**影响**：卡片的视觉呈现和交互未验证，但数据流已闭环。

### 4.3 未实现冷却

失败的路由不进冷却期，同一链的连续请求会重复尝试刚失败的路由。
参考实现有 `cooldownMs`，本插件未做。这是设计选择（保持实现精简），不是缺陷。

---

## 五、安装与回退

见 `README.md` 第七节。要点：

- 安装需要：junction + `package.json` 两处 + `pnpm-lock.yaml` 一处 + 重启 DSH
- 回退需要：反向操作 + 重启 DSH
- **生产安装留待用户明确授权**

---

## 六、环境隔离确认

本轮全程未触碰：

| 项 | 状态 |
|---|---|
| 生产 profile `D:\Data\dsh\profiles\desktop\` | 修改时间仍是 11-15 10:28（上一轮任务） |
| `app.asar` | 修改时间 11-13 15:30（安装时） |
| 真实网关 8791 / 8788 | 运行中，未被停止 |
| 插件是否装进生产 | 否 |

隔离环境占用 6.9 MB（`_isolation/`），可随时删除。
