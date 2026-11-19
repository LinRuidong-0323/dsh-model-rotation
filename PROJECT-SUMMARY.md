# dsh-model-rotation 项目总结

> 供代码审核使用。本文档只陈述经本会话工具验证的事实；未验证的内容明确标注。
>
> 生成时间：2026-11-15
> 插件版本：0.2.5
> 状态：**隔离验证通过，未安装到生产 profile**

---

## 一、项目目标

在 DeepSeek Harness（DSH）里实现"自动模型切换"：

- 用户有多个自定义 API 渠道（Trae、WorkBuddy 等，各自通过本地网关暴露成 OpenAI 兼容端点）
- 在模型选择器里选一个渠道对应的"轮换链"，按配置的优先级依次尝试链上模型
- 先试同渠道内的模型，再按配置跨渠道降级
- **降级只作用于当前请求**，下一次请求重新从首选开始
- 普通单模型选择保持原有行为

---

## 二、最终架构

### 2.1 采用方案：虚拟 provider

插件注册一个名为 `model-rotation` 的 provider 路由，每条链是这条路由下的一个"虚拟模型"：

```
选择器显示：模型轮换 / Trae 优先
实际派发：  { provider: 'model-rotation', model: 'trae' }
adapter 解析 'trae' → [trae-cn/DeepSeek-V4.1-Flash, trae-cn/GLM-5.3, wb-cn/deepseek-v4.1-flash, ...]
```

### 2.2 为什么不用 `llm/stream` waterfall

| 维度 | 虚拟 provider（采用） | `llm/stream` waterfall |
|---|---|---|
| 选择器里能选"链" | ✅ 直接是一个条目 | ❌ 无法表达 |
| 单模型选择是否受影响 | ✅ 完全不经过该路径 | ⚠️ 需自己判断是否介入 |
| 请求体控制 | ✅ 完全掌握 | ⚠️ 需接管整个生命周期 |
| `source` 语义 | ✅ 记录为链 id | ⚠️ 改写 provider 可能触发 source 重写 |
| 改动量 | 中（已实现） | 大 |

需求是"在选择器里选一条链"，这正是虚拟 provider 的语义。隔离验证已证明可行（见第四节）。

社区同类实现 `dsh-llm-fallbacks`（MIT，26 星）也走虚拟 provider 路线，佐证该判断。**未复制其代码。**

### 2.3 一次请求的执行流程

```
agent loop
  → ctx.llm.prepareCall({provider:'model-rotation', model:'trae'})
      → RotationAdapter.prepareCall
          → resolveModel: 聚合各路由的 contextWindow（取最大）、inputModalities（取并集）
  → prepared.stream(options)
      → RotationAdapter.#stream
          → 对每个路由：
              1. 能力筛选（图像/工具/上下文）
              2. ctx.llm.prepareCall({provider: route.provider, model: route.model})
              3. 转发请求：{...options, ...prepared.config, provider, model}
              4. runAttempt：缓冲直到提交，提交后流式输出并固定路由
              5. 提交前失败 → 下一个路由；提交后失败 → 明确结束
          → 恰好一个终止 chunk
```

---

## 三、实现清单

### 3.1 文件结构

```
dsh-model-rotation/
├── package.json               723 B  包清单（dsh.bundle.patch + dsh.client）
├── cordis.patch.yml           282 B  loader 插入行
├── index.js                   346 行 挂载：注册 adapter、设置 API、诊断收集
├── client.js                  470 行 设置卡片（React，注入 settings.plugins.tab）
├── README.md               16030 B  完整说明
├── CHANGELOG-0.2.0.md       8732 B  本轮变更说明
├── CODEX-REVIEW-PROMPT.md   6544 B  上一轮的审核提示词（已过时，见第五节）
├── src/
│   ├── chain.js               125 行 错误分类、链路构建（纯函数，无依赖）
│   ├── config.js              189 行 配置存储（原子写、mtime 失效、输入校验）
│   ├── attempt.js             328 行 单次尝试：提交语义、超时看门狗、上游清理
│   ├── capability.js          172 行 图像/工具/上下文能力筛选
│   ├── adapter.js             517 行 适配器：逐路由尝试、失败降级、诊断
│   └── http.js                160 行 设置 HTTP 接口（含来源校验）
└── test/
    ├── rotation.test.js       834 行  53 项：核心语义
    ├── client.test.js         136 行   7 项：设置卡片纯函数
    ├── lifecycle.test.js      168 行   9 项：挂载/卸载
    ├── retry-boundary.test.js 161 行   7 项：与 llm-retry 边界
    └── diagnostics.test.js    192 行   9 项：in-flight 计数与诊断
```

总计约 3,100 行（含测试）。

### 3.2 目标逐项对应

| 目标 | 实现位置 | 状态 |
|---|---|---|
| 1. 完整保留消息/系统提示/工具/取消信号 | `adapter.js` 转发 `{...options, ...prepared.config, provider, model}` | ✅ E2E 验证 |
| 2. 提交前缓冲、提交后固定路由 | `attempt.js` 的 `commitsAttempt()` + `runAttempt()` | ✅ 单测 + E2E |
| 3. 空回答/断流分类、终止 chunk 唯一 | `attempt.js` 的 `classifyUnfinishedStream()` | ✅ 单测 + E2E |
| 4. 超时/取消/消费者退出清理 | `attempt.js` 的看门狗 + `closeUpstream()` + `Promise.race` | ✅ 单测（含死锁回归） |
| 5. 能力筛选、错误策略 | `capability.js` + `chain.js` | ⚠️ 上下文已 E2E；图像仅单测 |
| 6. 并发隔离、诊断展示、日志无敏感 | `adapter.js` hooks + `index.js` + `client.js` | ✅ E2E 并发 |
| 7. 与 dsh-llm-retry 边界、多轮续接 | `adapter.js` 的 `providerRetryPolicy()` 返回 undefined | ✅ 专项测试 + 多轮 E2E |
| 8. 链配置界面 | `client.js` + `http.js` | ✅ 接口 17 项 + 浏览器 UI 15 项 |

---

## 四、关键实现细节

### 4.1 请求体转发（目标第 1 项）

**这是本项目的核心修复。** 早期版本写成：

```js
const forwarded = { ...(prepared.config ?? options), provider, model }   // ❌ 丢失 messages
```

`prepared.config` 只含 6 个控制字段（provider/model/reasoningEffort/temperature/maxTokens/stop）。
DSH 在派发前执行 `options.messages.some(...)`，拿到 `undefined` 就崩在
`Cannot read properties of undefined (reading 'some')`。

正确写法（当前实现）：

```js
const forwarded = {
  ...options,                    // 请求体：messages、tools、signal、systemPrompt...
  ...(prepared.config ?? {}),    // 控制字段：registry 在准备阶段填充的默认值
  provider: route.provider,      // 只改路由
  model: route.model,
}
```

**为什么控制字段必须来自 `prepared.config`**：`prepared.stream()` 会调用
`callConfigEquals(options, resolvedConfig)` 校验，比较 `provider/model/reasoningEffort/
temperature/maxTokens/stop`。registry 在准备阶段填了默认值（如 `maxTokens`、`stop`），
校验对象是填充后的值。传调用方原始 options 会报 `INVALID_PREPARED_CALL`。

### 4.2 提交语义（目标第 2 项）

一次"尝试"= 一个路由。读者看到第一个**可见输出**之前可以静默放弃；之后该尝试拥有
这一轮，失败必须上报而不能切换。

| Chunk | 提交 | 理由 |
|---|---|---|
| `text-delta`（非空白） | ✅ | 读者已看到正文 |
| `tool-call-delta` | ✅ | 工具已开始，切换会重复执行 |
| `block-end`（text 有内容） | ✅ | 块完整且非空 |
| `block-start` | ❌ | **块可能最终为空**，开块不等于有内容 |
| `block-end`（reasoning） | ❌ | 思考不是读者要的答案 |
| `reasoning-delta` | ❌ | 同上 |
| `usage` | ❌ | 只是记账 |

**`block-start` 不提交是一个关键决策。** 初版实现让 `block-start` 提交，导致
"仅思考后失败"的路由无法降级——模型开了块、产出思考、然后死掉，但块开始已经
被当作提交，于是无法切换。E2E 场景 5 暴露了这个问题。

### 4.3 终止 chunk 唯一性（目标第 3 项）

`#stream()` 的每条退出路径恰好产出一个 `finish`：

- 链不存在 / 链为空 → `UNKNOWN_MODEL`
- 全部路由失败 → 聚合摘要，code 取最后一个失败码
- 提交后失败 → 该路由的失败码
- 不可降级的失败 → 该路由的失败码
- 用户取消 → `{kind:'aborted'}`

断流分类：

- 完全无输出 → `EMPTY_RESPONSE`
- 有输出但无 `finish` → `STREAM_CLOSED`（DSH 自己的中断码）

### 4.4 资源清理（目标第 4 项）

三种结束路径都会取消上游并清理定时器：

| 风险 | 防护 | 代码位置 |
|---|---|---|
| 上游卡在 `next()` 不返回 | 看门狗主动 `settle`，并 `Promise.race` 掉 `next()` | `attempt.js:261` |
| 上游拒绝被关闭 | `closeUpstream()` 有 500ms 上限 | `attempt.js:9, 195` |
| 消费者提前退出 | 生成器 `finally` 里 close + settle | `attempt.js` |

**这三个防护都对应已复现的故障。** 初版在"上游卡死"时会让整个进程挂起——单测
超时 120 秒才暴露出来。在生产上，这意味着模型卡住时对话永久挂起。

### 4.5 能力筛选（目标第 5 项）

派发前按需筛掉不兼容路由：

| 能力 | 判定 | 未知时 |
|---|---|---|
| 图像 | 请求含 image 块，但路由只声明 text | 放行 |
| 工具 | 请求带 tools，但路由不接受工具声明 | 放行 |
| 上下文 | 估算输入 token + 预留输出 > 路由窗口 | 放行 |

**未知能力一律放行**：因为宿主没报告窗口就拒绝该路由，会静默把链缩到空。

### 4.5.1 链级模态声明：未知 ≠ 看不见（0.2.10 修）

链要通过 `inputModalities` 告诉宿主自己能看什么，而这个字段会被宿主用来做**不可逆**
的决定：**存在**且不含 `image` → 图片被压成文字，上传阶段直接拒绝；**不存在** → 宿主
不干预。

| 情况 | 修复前 | 修复后 |
|---|---|---|
| 所有路由都不声明模态 | `['text']`（替厂商断言"瞎"） | `undefined`（未知） |
| 任一路由声明 `image` | `['text']`（错） | `['text','image']`（并集） |
| 全部路由明确 `['text']` | `['text']` | `['text']`（如实转达） |
| 链不存在/为空 | `['text']` | `undefined` |

**这个 bug 存在了 6 个版本（0.2.4–0.2.9）没被发现**，因为 0.2.4 的验证只覆盖了
路由级筛选（"文本路由 0 次调用、视觉路由 1 次"），没有验证链级声明是否如实。
筛选逻辑本身是对的，但它的**输入前提**是错的，于是整体行为错。

宿主侧消费点（读 `app.asar` 确认）：

| 位置 | 行为 |
|---|---|
| `dsh-llm:2447` | 压平图片为文字 |
| `dsh-api-session-controller:921` | 上传前抛 `MODEL_DOES_NOT_SUPPORT_IMAGES` |
| `dsh-tool-fs` / `dsh-tool-office` / `dsh-subagent` / `dsh-mcp-client` | 直接拒绝 |

### 4.6 错误策略（目标第 5 项）

**可降级**（9 个）：
```
EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, STREAM_CLOSED, MALFORMED_RESPONSE, QUOTA, CONTEXT_WINDOW_EXCEEDED
```

**不可降级**（7 个）：
```
ABORTED, AUTH, INVALID_REQUEST, MODEL_UNSUPPORTED, NO_ADAPTER, UNKNOWN_MODEL, UNSUPPORTED_CONTENT
```

**未知错误码默认停止**——对一个不理解的错误猜"换个地方重试"，是把一个清晰错误变成
三个令人困惑的错误。

**整条链都因超限失败时，摘要追加可操作提示**（`allRejectedForLength` + `contextWindowHint`）。
理由：此时"换厂商"正是链已经做过的动作，普通摘要会让用户无从下手。提示明确排除换厂商，
指出压缩对话或开新会话，并给出估算规模。**仅在全部失败都是超限时追加**——混合失败
（一条超时、一条超限）保留普通摘要，避免把长度误报成唯一原因。

### 4.7 链间隔离（有意设计）

**一个请求只在它被选中的那条链内部降级。** 链内逐条尝试，全部失败才报错；链与链之间
**不互相兜底**。

这条设计曾被推翻过一次又恢复，理由值得记下来：

| 方案 | 结果 |
|---|---|
| 合并成长链 | 技术上可行，但会把"日常"和"强推理"合成一个档位 |
| 链间自动级联 | A 全失败后跳 B，用户选的档位被悄悄换掉 |
| **链间隔离（采用）** | 每个链是一个独立档位，选谁就只在谁内部降级 |

关键是**档位语义**：A 链全失败本身就是用户需要知道的信号。若自动跳到 B 链，B 的成功
会把这个信号掩盖掉，用户以为"日常"还正常，其实早就全线不可用了。

`buildChain` 按 `provider+model` 去重，所以想在多个档位里试同一个模型是安全的。

### 4.8 请求日志

设置卡片只保留每条链最近一次命中，宿主 logger 不持久化 info 行，因此"这次用了哪个
模型"重启后无处可查。`src/request-log.js` 把每次请求的路由结果写到
`$DSH_HOME/model-rotation/request-log.json`。

| 约束 | 实现 | 理由 |
|---|---|---|
| 有界 | 最多 200 条 | 日志不能随会话无限增长 |
| 原子写 | 临时文件 + rename | 半个文件比没有文件更糟 |
| 写失败不影响路由 | `try/catch` + 警告 | 诊断设施不能成为故障点 |
| 损坏可恢复 | 按空日志处理 | 手改坏一个 JSON 不该让模型调用失败 |
| 不含请求内容 | 只记链/路由/码/耗时 | 用户可能把这份文件贴到 issue 里 |

### 4.9 路由备注

每条路由可带一个 `note`，显示在模型选择器的链描述里（`provider/model（备注）`），
在卡片里与下拉框、删除按钮同行。

**它是纯展示字段**：适配器只转发 `provider`/`model` 和解析出的控制字段，所以备注不会
进入下游请求；请求日志也不记它。上限 200 字符。

没有备注的路由**保持旧的两字段形状**，不写成 `note: ""`——否则读一次配置就会把所有
路由改写成带空字段的形式。

### 4.10 排序交互：选中 + 固定调整条

原来每行自带 ↑↓，点一次后列表重排，光标下的行换成另一条，必须重新点目标行才能继续。
移动 N 步要点 N 次，且很容易看错。

现在的做法：

| 机制 | 说明 |
|---|---|
| 选中 | 点行空白处选中，`data-selected` 驱动样式 |
| 固定条 | 调整条不随列表移动，↑↓ 作用于选中行 |
| 连续 | `step()` 返回新索引，选中跟随，可连按 |
| 边界 | 到头时对应箭头禁用，不越界 |
| 不误触 | 点 select/input/button 不改变选中 |

**选中态的颜色有个坑**：浅色主题下 `bg-base`、`bg-layer-1`、`bg-layer-2` 解析出来
都是 `#fff`，拿它们当底色等于没有高亮——第一次实现就踩了这个，测试还"通过"了，因为
断言只比较了"与卡片不同"，而卡片背景是透明的 `rgba(0,0,0,0)`。

修法是用 `color-mix` 从**品牌色**混出淡底纹，品牌色在深色主题下自动变成近白，两种主题
都可见。验证脚本改为在 light/dark 两种 `colorScheme` 下各跑一遍并检查计算样式。

顺带修掉一个既有缺陷：CSS 里用的 `--dsw-alias-bg-l1` 在这个主题里**根本不存在**，
导致输入框和按钮背景是透明的。已改为 `--dsw-alias-bg-layer-1`。

### 4.11 链启停开关

复选框改为开关样式：轨道用 `state-idle-primary` / `state-success-primary`，
滑块固定白色。底层 `<input type="checkbox">` 保留，键盘与读屏可用。

### 4.12 与 dsh-llm-retry 的边界（目标第 7 项）

- `providerRetryPolicy()` 返回 `undefined`，**不声明自己的重试策略**
  - 否则宿主的重试执行器会叠加在链遍历之上，一次限流放大成 N×M 次调用
- 一次遍历对每个路由**最多尝试一次**
- 遍历失败只产出一个终止 chunk，这正是 `dsh-llm-retry` 反应的信号
- `dsh-llm-retry` 重新进入时是**全新遍历**，从链头开始（有测试断言）

### 4.13 设置界面（目标第 8 项）

设置卡片注入 `settings.plugins.tab`，通过 `/api/model-rotation` 读写：

- `GET /state`：返回链配置 + provider 目录 + 诊断
- `POST /save`：保存并立即生效
- 来源校验：回环 host、非跨站、Origin 匹配

卡片功能：选择渠道和模型（下拉联动）、链内排序、链间排序、启停单链、显示最近命中与
最近失败。

**日志不含密钥、不含请求内容**——只记录链 id、路由、错误码。

---

## 五、被推翻的两个旧结论

这两个是上一轮基于错误信息做出的判断，本轮验证推翻了它们。审核时请以本文档为准。

### 5.1 "虚拟 provider 与 source 根本冲突"

**错误。** 真实原因是 4.1 描述的请求体丢失。修复后最小复现立即通过。

### 5.2 "默认模型不能指向插件提供的 provider"

**错误。** 同样是请求体丢失导致的崩溃，错误信息（`reading 'some'`）误导了归因。
修复后，链可以**直接作为 profile 默认模型**，真实 agent 轮次验证通过：

```
agent exit=0, 回答 primary-ok
```

### 5.3 已过时的文件

`CODEX-REVIEW-PROMPT.md` 写于上一轮，其中包含上述两个错误结论。**审核时请忽略它，
以本文档和 `README.md` 为准。**

---

## 六、验证证据

### 6.1 七层测试全绿

```
单元测试          158 / 158
隔离 E2E          63 / 63
真实 agent 流程   14 / 14
多轮续接           8 / 8
设置接口          17 / 17
README 核对       全部通过
总结核对          全部通过
```

一键复跑：

```powershell
node 'D:\Deeseek_HARENSS\创建插件\_isolation\verify-all.mjs'
```

前置条件：假上游必须在运行

```powershell
node 'D:\Deeseek_HARENSS\创建插件\_isolation\fake-upstream.mjs'
```

### 6.2 隔离环境

| 项 | 值 |
|---|---|
| 隔离 DSH_HOME | `D:\Deeseek_HARENSS\创建插件\_isolation\dsh-home` |
| 假上游 primary | `127.0.0.1:57900`（可控制失败） |
| 假上游 backup | `127.0.0.1:57901`（可控） |
| 假上游 vision | `127.0.0.1:57902`（可控，声明支持图像） |
| 隔离占用 | 约 9 MB |

假上游支持模式：`ok / rate_limit / server_error / auth / timeout / stall /
reasoning_then_fail / text_then_break / tool_call / empty`，并记录每个请求的完整
body（消息数、工具名、采样参数、系统提示长度）。

### 6.3 隔离 E2E 的 16 个场景

| 场景 | 关键证据 |
|---|---|
| 首选成功 | primary 1 次、backup 0 次；上游收到 3 条消息、`read_file` 工具、系统提示 26 字符 |
| 429 降级 | primary 1 次 → backup 1 次，回答 `backup-ok` |
| 5xx 降级 | backup 被调用 |
| **超时降级** | 上游接受连接但永不响应，看门狗结束尝试并切到 backup |
| **停滞降级** | 上游发一个心跳后静默，按进展的看门狗触发，心跳未泄漏为正文 |
| 空响应 | `EMPTY_RESPONSE` 触发降级 |
| 仅思考后失败 | 思考内容未泄漏，回答来自 backup |
| 提交后断流 | 部分输出保留、未拼接 backup、失败明确上报 |
| 工具调用 | 工具调用被计为有效输出 |
| 全部失败 | 摘要列出全部三条路由，恰好一个 finish |
| 下一请求回首选 | 恢复后 primary 1 次、backup 0 次 |
| 并发隔离 | 3 个并发调用各一个终止 chunk、各有输出 |
| 能力筛选（上下文） | 128K 窗口路由被跳过，大窗口路由被使用 |
| **能力筛选（图像）** | 真实 PNG 附件；文本 primary/backup 均 0 次调用，vision 1 次 |
| 插件重载 | 连续两次运行都 PASS |
| **用户取消** | 首个正文后取消，终止原因为 aborted，backup/vision 均 0 次调用 |

### 6.4 真实 agent 流程（最重要的验证层）

链作为 profile 默认模型，由**真实 agent 轮次**发起调用：

| 场景 | 证据 |
|---|---|
| 首选成功 | agent exit=0，回答 `primary-ok`，上游收到 3 条消息 |
| 限流降级 | agent exit=0，回答 `backup-ok` |
| 下一请求回首选 | 恢复后 `primary-ok`，backup 0 次 |
| 全部失败 | agent exit=1，错误列出全部三条路由 |

### 6.5 多轮续接（目标第 7 项的验证）

同一会话连续四轮：

| 轮次 | 证据 |
|---|---|
| 第一轮 | `primary-ok` |
| 第二轮 | `primary-ok`，上游收到 **6 条消息**（历史持久化并传递） |
| 第三轮（primary 限流） | `backup-ok`，**跨 provider 切换** |
| 第四轮（primary 恢复） | `primary-ok`，**回到链头** |

关键：第三轮由 backup 服务后，第四轮仍能回到 primary 并带上完整历史。

### 6.6 设置接口 17 项

`/state` 读取、`/save` 保存、重新加载、顺序保留、停用保留、拒绝非对象/非法 JSON、
拒绝跨站/异源、未知路由 404、来源校验单元断言。

---

## 七、验证中发现并修复的缺陷

不是"写完就通过"。以下都是测试先失败、定位后修复的：

| 缺陷 | 如何发现 | 修复 |
|---|---|---|
| **请求体被丢弃** | E2E 全报 `.some` 错误 | 转发 `{...options, ...prepared.config, provider, model}` |
| **超时死锁** | 单测进程挂起 120s+ | 看门狗主动 settle + race `next()` + 关闭设 500ms 上限 |
| **块开始误判为提交** | E2E 场景 5 失败 | `block-start` 不再提交 |
| **`contextWindow` 位置错** | 单测断言拿到 `undefined` | 改为 `context: { contextWindow }` |
| **测试状态污染** | 场景间计数串味（primary=3 而非 1） | 假上游用 sentinel 标记区分探针请求 |
| **BOM 导致启动失败** | `Unexpected token '\uFEFF'` | 用 Node 以 UTF-8 无 BOM 写入 |

---

## 八、已知限制（明确标注未验证）

### 8.1 图像能力筛选（已端到端验证，此项不再是限制）

**此前的障碍**：DSH 在派发前解析 `attachment.attachmentId` 并对存储对象做完整性校验，
伪造的摘要会被拒绝（`ATTACHMENT_CORRUPT`）。

**解决办法**：附件是**内容寻址**的，对象存在
`$DSH_HOME/attachments/v1/objects/<sha256前2位>/<sha256>`。
`_isolation/make-attachment.mjs` 生成一张真实 PNG（74 字节、8×8），
算出 sha256 并写入该地址，引用就变成合法的。

引用字段必须是 `mediaType`（不是 `mimeType`），且 `bytes` / `width` / `height`
必须与对象实际内容一致，否则校验失败。

**E2E 场景 11b 的结果**：

| 断言 | 证据 |
|---|---|
| 文本 primary 被跳过 | `primary=0` |
| 文本 backup 被跳过 | `backup=0` |
| 视觉路由被使用 | `vision=1` |
| 视觉路由收到图像块 | `messageCount=3` |

**结论**：图像能力筛选在真实链路上工作正常。

### 8.2 设置卡片（已端到端验证，此项不再是限制）

0.2.6 在隔离 web profile 里用 Playwright + Chromium 驱动真实浏览器，15 项断言全过：

| 断言 | 结果 |
|---|---|
| 插件列表出现模型轮换 | ✅ |
| 卡片渲染出路由 provider / model | ✅ |
| 保存按钮、新增链、添加模型 | ✅ |
| 保存写入磁盘 | ✅ 链名确实被改写 |
| 无未捕获的页面错误 | ✅ |

截图：`_isolation/settings-card.png`。

**剩余风险**：schemastery 通过 junction 解析的方式在正式 `dsh plugin add` 布局下未验证。

### 8.3 冷却机制（已实现，此项不再是限制）

0.2.5 实现了冷却：失败的路由被排到链尾，冷却期内下次请求跳过它。

| 参数 | 值 |
|---|---|
| 基础冷却 | 15 秒 |
| 增长 | 指数（×2） |
| 上限 | 10 分钟 |
| 遗忘 | 30 分钟 |

**关键约束**：冷却只能重排，不能清空链。所有路由都冷却时，链仍按原序遍历。

**已验证**：13 项单测 + E2E 场景 14（同进程两次调用，第二次跳过冷却中的 primary）。

---

## 九、环境与安全

本轮全程未触碰：

| 项 | 状态 |
|---|---|
| 生产 profile `D:\Data\dsh\profiles\desktop\` | 修改时间 `11-15 10:28`（上一轮任务），未改动 |
| `app.asar` | 修改时间 `11-13 15:30`（安装时），未改动 |
| 真实网关 8791 / 8788 | 运行中，未被停止 |
| 插件是否装进生产 | **否** |

隔离环境 `_isolation/` 约 9 MB，可随时删除。

---

## 十、安装与回退

见 `README.md` 第七节。要点：

**安装**（需要用户明确授权）：
1. 备份 `package.json` 和 `pnpm-lock.yaml`
2. 建 junction：`node_modules\@local\dsh-model-rotation` → 插件源码目录
3. `package.json`：dependencies 加 link，bundles 加条目
4. `pnpm-lock.yaml`：importers 段加对应条目
5. 完全退出 DSH 后重启

**回退**：反向操作 + 重启。

**配置**：`$DSH_HOME/model-rotation/settings.json`

```json
{
  "version": 1,
  "chains": [
    {
      "id": "trae",
      "name": "Trae 优先",
      "enabled": true,
      "routes": [
        { "provider": "trae-cn", "model": "DeepSeek-V4.1-Flash" },
        { "provider": "trae-cn", "model": "GLM-5.3-Flash" },
        { "provider": "wb-cn", "model": "deepseek-v4.1-flash" }
      ]
    }
  ]
}
```

---

## 十一、开源参考

按 `AGENTS.md` 要求搜索了同类实现（该文件在项目中不存在，按目标文本要求执行）。
**未引入任何依赖，未复制代码。**

| 项目 | 许可证 | 可借鉴之处 | 限制 |
|---|---|---|---|
| [dsh-llm-fallbacks](https://github.com/btspoony/dsh-llm-fallbacks) | MIT | 虚拟 provider 路线、提交语义、与 llm-retry 的边界划分 | TypeScript + 依赖 dsh-llm 类型包；功能远多于此需求 |
| [dsh-model-fallback](https://github.com/CarlCN2003/dsh-model-fallback) | MIT | 错误分类为 8 类、冷却与恢复作用域 | 走 `llm/stream` 路线；自带设置面板较重 |
| [dsh-fallback-router](https://github.com/hongxin-y/dsh-fallback-router) | MIT | 每模型一条链、时间窗口轮换 | TypeScript；路由语义与本需求不同 |
| [dsh-echelon](https://github.com/Abnerluo123/dsh-echelon) | MIT | 档位式路由、能力路由（图像/上下文） | 无设置页；配置需手改 |

许可证均允许参考思路，不复制代码即无合规风险。

---

## 十二、审核建议重点

按优先级：

1. **`src/attempt.js` 的 `runAttempt()`**（约 150-310 行）：提交语义、看门狗、`Promise.race`
   的竞态是否有遗漏；`settle` 是否可能被调用两次；生成器 `finally` 的清理是否完整。
2. **`src/adapter.js` 的 `#stream()`**（约 290-400 行）：降级循环、提交后固定路由、
   错误聚合、能力筛选与降级的交互。
3. **`src/capability.js` 的 `estimateRequestTokens()`**：token 估算很粗糙（4 字符 = 1 token），
   是否会导致误判跳过。
4. **`src/http.js` 的来源校验**：`rejectionFor()` 是否足以防止跨站请求伪造。
5. **`src/config.js` 的 `normalizeSettings()`**：畸形配置能否拖垮插件，有无原型污染风险。
6. **`client.js` 的 React 组件**：已在浏览器验证渲染与保存，但未测并发编辑；请检查保存失败后的状态同步与异步清理。

---

## 十三、可复现的验证命令

```powershell
# 1. 启动假上游（必须）
node 'D:\Deeseek_HARENSS\创建插件\_isolation\fake-upstream.mjs'

# 2. 一键跑全部七层
node 'D:\Deeseek_HARENSS\创建插件\_isolation\verify-all.mjs'

# 或单独跑
cd 'D:\Deeseek_HARENSS\创建插件\dsh-model-rotation'
node --test test/rotation.test.js test/client.test.js test/lifecycle.test.js test/retry-boundary.test.js
node 'D:\Deeseek_HARENSS\创建插件\_isolation\e2e-full.mjs'
node 'D:\Deeseek_HARENSS\创建插件\_isolation\e2e-agent.mjs'
node 'D:\Deeseek_HARENSS\创建插件\_isolation\e2e-multiturn.mjs'
node 'D:\Deeseek_HARENSS\创建插件\_isolation\e2e-settings.mjs'
node 'D:\Deeseek_HARENSS\创建插件\_isolation\verify-readme.mjs'
```
