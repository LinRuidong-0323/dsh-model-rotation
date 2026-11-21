# dsh-model-rotation — 模型轮换插件

> **状态：0.2.10，已安装并在生产 profile 中日常使用。**
> 160 项单元测试、63 项隔离端到端、14 项真实 agent 流程、8 项多轮续接、17 项设置接口。

一个 DeepSeek Harness（DSH）插件，把一组 `provider/model` 路由打包成一条"链"，
在模型选择器里显示为一个条目。选中后按顺序尝试链上每个路由，遇到可重试的失败
（限流、超时、5xx、空响应）自动降级到下一个。

## 安装

```powershell
git clone https://github.com/LinRuidong-0323/dsh-model-rotation.git
```

然后在 DSH 里通过 **设置 → 插件 → 添加插件** 指向该目录，或把目录建 junction 到
profile 的 `node_modules/@local/dsh-model-rotation` 并在 `package.json` 的
`dsh.profile.bundles` 中加入 `@local/dsh-model-rotation`。

**注意**：本插件的包名是 `@local/dsh-model-rotation`（`@local` 前缀表示本地链接）。
若你从 GitHub 安装，请按自己的 profile 布局调整包名与路径。

## 快速开始

1. 设置 → 插件 → **模型轮换**，新建一条链
2. 按优先级添加路由（渠道 + 模型）
3. 可选：给每条路由写备注（如"便宜"、"强推理"）
4. 保存后，该链会出现在模型选择器里，直接选中即可


---

## 一、需求

用户的 DSH 里同时配置了多个自定义 API 渠道（Trae、WorkBuddy 等，各自通过本地网关
暴露成 OpenAI 兼容端点）。需求：

- 选定一个渠道后，在该渠道内按自设优先级自动切换模型
- 同渠道内全部失败后，再跨渠道降级
- **只在当前这次请求内降级**，下一轮回到首选模型
- 每个 provider 一条有序链
- 普通单模型选择保持正常行为

---

## 二、架构选择

### 2.1 两种候选方案

| 方案 | 做法 | 取舍 |
|---|---|---|
| **虚拟 provider**（采用） | 注册 `model-rotation` 路由，每条链是它下面的一个虚拟模型 | 选择器里直接可选；`source` 记录为链 id；与单模型选择天然隔离 |
| `llm/stream` waterfall | 不注册路由，在流式水位上拦截失败并改写 provider/model | 需要自己接管整个请求生命周期；无法在选择器里表达"链" |

**采用虚拟 provider**，理由：

1. 用户要的是"在选择器里选 Trae 链"——这正是虚拟 provider 的语义
2. 普通单模型选择完全不走这条路径，`source` 仍是真实 provider，行为不变
3. 隔离验证已证明可行（见第四节），不需要接管整个请求生命周期

社区同类实现（`dsh-llm-fallbacks`，MIT，26 星）也采用虚拟 provider 路线，与本方案的
关键契约判断一致。**未复制其代码**，仅参考了它对提交语义和冷却边界的处理思路。

### 2.2 关键契约（读 `app.asar` 源码确认）

这些是踩过的坑，全部有测试覆盖：

| 契约 | 说明 |
|---|---|
| `prepareCall(config, signal)` | 参数是 **config 对象**，不是 `(provider, model)` |
| `prepared.stream(options)` 校验 | `callConfigEquals` 比较 `provider/model/reasoningEffort/temperature/maxTokens/stop`；必须用 `prepared.config` 的值 |
| **请求体必须完整转发** | registry 在 dispatch 前投影 `options.messages`，缺 `messages` 会崩在 `content.some is not a function` |
| `resolveModel` 的 `contextWindow` | 必须嵌在 `context: { contextWindow: N }` 下，扁平字段被静默忽略 |
| JSON 文件编码 | 不能有 BOM |
| 客户端模块清单 | 启动时生成，插件增删需重启 DSH |

> **一个被推翻的旧结论**：早期版本曾判断"默认模型不能指向插件提供的 provider"。
> 实际是 adapter 丢弃 `messages` 导致请求投影崩溃，错误信息（`reading 'some'`）
> 误导了归因。adapter 修好后，链可以**直接作为 profile 默认模型**，真实 agent 轮次
> 验证通过（见第四节 4.3）。

---

## 三、实现

### 3.1 文件结构

```
dsh-model-rotation/
├── package.json              723 B  包清单
├── cordis.patch.yml          282 B  loader 插入行
├── index.js                  346 行 挂载：注册 adapter + 设置 API
├── client.js                 470 行 设置卡片（React，注入 settings.plugins.tab）
├── README.md                        本文档
├── CHANGELOG-0.2.0.md               本轮变更说明
├── src/
│   ├── chain.js              125 行 错误分类、链路构建（纯函数）
│   ├── config.js             189 行 配置存储（原子写、mtime 失效）
│   ├── attempt.js            328 行 单次尝试的流式与提交语义
│   ├── capability.js         172 行 图像/工具/上下文能力筛选
│   ├── adapter.js            517 行 适配器：逐路由尝试、失败降级
│   └── http.js               160 行 设置 HTTP 接口（含来源校验）
└── test/
    ├── cache.test.js              127 行   5 项：元数据缓存与清理
    ├── card-render.test.js        156 行  13 项：undefined
    ├── client.test.js             212 行  15 项：设置卡片纯函数
    ├── cooldown.test.js           299 行  13 项：undefined
    ├── diagnostics.test.js        192 行   9 项：in-flight 计数与诊断
    ├── lifecycle.test.js          168 行   9 项：挂载/卸载、重载隔离
    ├── move-bar.test.js           129 行  10 项：undefined
    ├── retry-boundary.test.js     161 行   7 项：与 llm-retry 边界
    └── rotation.test.js          1264 行  79 项：核心语义
```

### 3.2 提交语义（目标第 2 项）

一次"尝试"= 一个路由。读者看到第一个**可见输出**之前，该尝试可以被静默放弃；
之后该尝试拥有这一轮，失败必须上报而不能切换。

| Chunk | 是否提交 | 理由 |
|---|---|---|
| `text-delta`（非空白） | ✅ | 读者已经看到正文 |
| `tool-call-delta` | ✅ | 工具已开始执行，切换会重复执行 |
| `block-start` | ❌ | 块可能最终为空，开块不等于有内容 |
| `block-end`（text 有内容） | ✅ | 块已完整且非空 |
| `block-end`（reasoning） | ❌ | 思考不是读者要的答案 |
| `reasoning-delta` | ❌ | 同上 |
| `usage` | ❌ | 只是记账 |

**提交前的可恢复失败 → 切换**；**提交后的失败 → 明确结束**，禁止拼接另一模型的回答。
这条规则由 `commitsAttempt()` 实现，并有 6 项测试覆盖（含"仅思考后失败"和"提交后断流"）。

### 3.3 终止 chunk 唯一性（目标第 3 项）

`#stream()` 的每条退出路径都恰好产出一个 `finish`。断流按真实协议归类：

- 完全无输出 → `EMPTY_RESPONSE`
- 有输出但无 `finish` → `STREAM_CLOSED`（DSH 自己的中断码）

### 3.4 资源清理（目标第 4 项）

三种结束路径都会取消上游并清理定时器：

| 风险 | 防护 |
|---|---|
| 上游卡在 `next()` 不返回 | 看门狗在 `idleTimeoutMs` 后**主动 settle**，并 race 掉 `next()` |
| 上游拒绝被关闭 | `closeUpstream()` 有 500ms 上限，不能阻塞这一轮 |
| 消费者提前退出 | 生成器 `finally` 里 close + settle，调用方不会永久等待 |

**这三个防护都对应已复现的故障**：初版实现在"上游卡死"时会导致整个测试进程挂起，
是测试超时暴露出来的真实缺陷（见第五节）。

### 3.5 能力筛选（目标第 5 项）

派发前按需筛掉不兼容的路由，避免静默丢失输入：

| 能力 | 判定 | 未知时 |
|---|---|---|
| 图像 | 请求含 image 块，但路由只声明 text | 放行（不因未知缩小链） |
| 工具 | 请求带 tools，但路由不接受工具声明 | 放行 |
| 上下文 | 估算输入 token + 预留输出 > 路由窗口 | 放行 |

### 3.5.1 链的模态声明：未知 ≠ 看不见

链路要把自己的 `inputModalities` 报给宿主，而宿主用这个字段做一个**不可逆**的决定：
字段**存在**且不含 `image`，就把图片压成文字再发（`dsh-llm` 的
`projectImagesForTextModel`），并在上传阶段直接拒绝
（`MODEL_DOES_NOT_SUPPORT_IMAGES`）。字段**不存在**时宿主不干预。

因此本插件的规则是：

| 情况 | 链报告 |
|---|---|
| 有任何一条路由声明 `image` | `['text','image']`（并集，请求再由能力筛选落到那条路由） |
| 所有路由都明确声明 `['text']` | `['text']`（如实转达，宿主压平是正确行为） |
| **没有任何路由声明模态** | **`undefined`**（未知，交给宿主判断） |
| 链不存在 / 链为空 | `undefined` |

**最后一行是重点。** `trae2api-hub`、`wb-proxy` 这类自定义代理端点通常不声明模态，
早期版本在这里填 `['text']`，等于替厂商断言"这个模型瞎"，结果整个插件的图片功能
全被关掉——不只是聊天发图，连 `read` 图片、Office 渲染、子代理带图都会被拒。

**不要把它改回固定值。** 有 160 项单元测试守着这个语义（含"未知保持未知"）。

### 3.6 错误策略（目标第 5 项）

**可降级**（换模型可能成功）：
`EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, STREAM_CLOSED, MALFORMED_RESPONSE, QUOTA, CONTEXT_WINDOW_EXCEEDED, INVALID_PREPARED_CALL`

**不可降级**：
`ABORTED`（用户取消，立即停止）、`AUTH`、`INVALID_REQUEST`、`MODEL_UNSUPPORTED`、
`NO_ADAPTER`、`UNKNOWN_MODEL`、`UNSUPPORTED_CONTENT`

`CONTEXT_WINDOW_EXCEEDED` **是可降级的**：不同 provider 对"超限"的判定标准不同
（token / 字符 / 是否含 system prompt），一个说超了，另一个未必。

`INVALID_PREPARED_CALL` **也是可降级的**，理由不同：它说的是**句柄坏了**，不是对话
坏了。宿主把 prepared call 绑定到一次性派发，重复派发或控制字段漂移都会报这个码；
而链上的下一条路由是用**全新句柄**准备的，所以它完全可能成功。0.2.11 之前这个码没有
分类，走了"未知码默认终止"的分支，导致第一个模型失败后整条链停下——请求日志里 40 次
失败有 30 次是它，每次 `tried=1`。

> **不要**把它当成"未知码一律降级"的理由。`AUTH`、`INVALID_REQUEST` 这类错误在每条
> 路由上都会同样失败，降级只会让用户多看几次同样的错误。未知码默认终止这条边界要守住。

**整条链都因超限失败时，摘要会追加可操作提示。** 此时"换厂商"恰恰是已经发生过的
动作，所以提示会明确排除它，改为指出该压缩对话或开新会话，并给出估算的请求规模：

```
every route in chain "chain-1" failed — wb-proxy/deepseek-v4.1-flash: CONTEXT_WINDOW_EXCEEDED; wb-proxy/glm-5.3-flash: CONTEXT_WINDOW_EXCEEDED

提示：所有候选模型都判定上下文超限，这不是某一个厂商的限制，换厂商不会更宽松。当前请求约 1050K tokens（估算）。请开一个新会话继续，或先压缩这段对话再重试。
```

提示只在**全部**失败都是超限时才追加。若一条路由超时、另一条超限，长度就不是唯一
原因，指向长度的提示会把用户带错方向，因此保留普通摘要。

**未知错误码默认停止**——对一个不理解的错误猜"换个地方重试"，是把一个清晰的错误变成三个。

### 3.7 与 dsh-llm-retry 的边界（目标第 7 项）

- 本插件 `providerRetryPolicy()` 返回 `undefined`，**不声明自己的重试策略**，
  否则宿主的重试执行器会叠加在链遍历之上，一次限流放大成 N×M 次调用
- 一次遍历对每个路由**最多尝试一次**
- 遍历失败只产出一个终止 chunk，这正是 `dsh-llm-retry` 反应的信号
- `dsh-llm-retry` 重新进入时是**全新的一次遍历**，从当前健康的链头开始（有测试断言）

### 3.8 冷却机制

失败的路由被排到链尾，冷却期内下一次请求跳过它。

| 参数 | 值 | 理由 |
|---|---|---|
| 基础冷却 | 15 秒 | 足够跳过一波限流，又不至于长期不可用 |
| 增长 | 指数（×2） | 连续失败的路由越来越不值得试 |
| 上限 | 10 分钟 | 防止偶发故障把路由永久拉黑 |
| 遗忘 | 30 分钟 | 长期无失败的条目自动清理 |

**关键约束：冷却只能重排，不能清空链。** 所有路由都在冷却时，`partition()` 返回
原始顺序，链仍会被遍历——一条"什么都不试"的链比一条慢的链更糟。

**只有可降级的错误码触发冷却。** `AUTH` 等终止码下次还会同样失败，拉黑只会掩盖
真正的问题；用户取消不是路由的错，也不触发。

### 3.9 设置界面（目标第 8 项）

设置卡片注入 `settings.plugins.tab`，通过 `/api/model-rotation` 读写：

- 选择已配置的渠道和模型（下拉联动）
- 链内路由排序（选中一行后用 ↑↓ 连续调整）
- 链之间排序
- 用开关一键启停单条链
- 给每条路由写备注（见 3.10）
- 显示最近命中的渠道/模型与最近失败摘要
- 显示最近 20 条请求记录（实际命中的路由、耗时、结果）

### 3.10 路由备注

每条路由可以写一句备注，比如"便宜"、"强推理"、"别用于代码"。备注显示在模型选择器的
链描述里，写成 `provider/model（备注）`，所以不用打开设置页也能看出这条链的构成意图。

备注与下拉框、删除按钮**在同一行**，位于 ✕ 左侧，一条路由占一行。

**备注只给自己看。** 它保存在设置文件里，但：

- 不会发给任何 provider——适配器只转发 `provider`/`model` 和解析出的控制字段
- 不进入请求日志——日志只记链、路由、错误码、耗时
- 长度上限 200 字符，超出截断

**没有备注的路由保持旧的两字段形状**（`{provider, model}`），不会写成 `note: ""`。
这样已有的设置文件不会因为被读一次就被改写。

### 3.11 排序与选中

调整路由顺序不再点每一行上的箭头。现在的流程是：

1. 点一行（任意空白处）选中它，该行出现**品牌色描边 + 淡色底纹**
2. 链底部固定的调整条随之高亮，显示"正在调整第 N 个"
3. 按 ↑ 或 ↓ 可以**连续调整**，选中状态跟着这一行走，不用再点一次

**为什么改**：原来每行有自己的箭头，点一次后列表会重排，光标下的行换成了另一条，
必须重新点一次目标行才能继续移动。连续移动 N 步就要点 N 次，很容易看错行。

**为什么选中态不只用底色**：浅色主题下 `bg-base`、`bg-layer-1`、`bg-layer-2` 三个
surface 令牌解析出来都是 `#fff`，用它们做底色等于没有高亮。所以选中态用**品牌色描边
+ `color-mix` 混合的淡底纹**，品牌色在深色主题下会自动变成近白色，两种主题都可见。

点下拉框、输入框或按钮**不会**改变选中状态——否则选个模型就把选中行换掉了。

### 3.12 链启停开关

每条链标题右侧是一个开关（而不是复选框），颜色状态与文字一致：启用为绿色、停用为灰色。
底层的 `<input type="checkbox">` 仍在 DOM 里，所以键盘和读屏软件照常可用。

### 3.13 请求日志

设置卡片只保留每条链**最近一次**命中，宿主 logger 也不持久化 info 行，所以
"这次到底用了哪个模型"重启后无处可查。`src/request-log.js` 把每次请求的**路由结果**
写到 `$DSH_HOME/model-rotation/request-log.json`：

| 记录字段 | 说明 |
|---|---|
| `at` | 请求时间 |
| `chainId` | 命中的链 |
| `provider` / `model` | 实际回答（或最后失败）的路由 |
| `elapsedMs` | 整个遍历的耗时 |
| `outcome` | `answered` 或 `failed` |
| `code` | 失败码（仅 `failed`） |
| `tried` | 之前试过的路由及各自错误码 |

**最多保留 200 条**，超出丢弃最旧的；写入是"临时文件 + rename"的原子替换，写失败
只记一条警告，绝不影响路由。文件损坏时按空日志处理而不是让路由失败。

日志**不含密钥，不含请求内容**——只记录链 id、路由、错误码、耗时。这一点有测试断言，
因为这份文件可能在报 bug 时被用户分享出去。

---

## 四、测试证据

### 4.1 单元测试 160/160

```powershell
cd 'D:\Deeseek_HARENSS\创建插件\dsh-model-rotation'
node --test test/cache.test.js test/card-render.test.js test/client.test.js test/cooldown.test.js test/diagnostics.test.js test/lifecycle.test.js test/move-bar.test.js test/retry-boundary.test.js test/rotation.test.js
```

| 文件 | 断言数 | 覆盖 |
|---|---|---|
| `cache.test.js` | 5 | 元数据缓存与清理 |
| `card-render.test.js` | 13 | undefined |
| `client.test.js` | 15 | 设置卡片纯函数 |
| `cooldown.test.js` | 13 | undefined |
| `diagnostics.test.js` | 9 | in-flight 计数与诊断 |
| `lifecycle.test.js` | 9 | 挂载/卸载、重载隔离 |
| `move-bar.test.js` | 10 | undefined |
| `retry-boundary.test.js` | 7 | 与 llm-retry 边界 |
| `rotation.test.js` | 5 | 核心语义 |

### 4.2 隔离端到端 47/47

```powershell
node 'D:\Deeseek_HARENSS\创建插件\_isolation\e2e-full.mjs'
```

真实 DSH 进程（独立 `DSH_HOME`）+ 真实 `prepareCall`/`stream` + 三个假上游端点。
**每个断言都核对假上游实际收到的请求**（消息数、工具名、系统提示、调用次数）。

| 场景 | 关键证据 |
|---|---|
| 首选成功 | primary 收到 1 次，backup 0 次；假上游收到 3 条消息、`read_file` 工具、系统提示 26 字符 |
| 429 降级 | primary 1 次 → backup 1 次，回答 `backup-ok` |
| 5xx 降级 | backup 被调用 |
| 空响应 | `EMPTY_RESPONSE` 触发降级 |
| 仅思考后失败 | 思考内容未泄漏，回答来自 backup |
| 提交后断流 | 部分输出保留、未拼接 backup、失败明确上报 |
| 工具调用 | 工具调用被计为有效输出 |
| 全部失败 | 摘要列出全部三条路由，恰好一个 finish |
| 下一请求回首选 | 恢复后 primary 1 次、backup 0 次 |
| 并发隔离 | 3 个并发调用各一个终止 chunk、各有输出 |
| 能力筛选 | 128K 路由被跳过，大窗口路由被使用 |
| 插件重载 | 连续两次运行都 PASS |

### 4.3 真实 agent 流程 14/14

```powershell
node 'D:\Deeseek_HARENSS\创建插件\_isolation\e2e-agent.mjs'
```

链作为 **profile 默认模型**，由真实 agent 轮次发起调用（不是探针直接调 adapter）：

| 场景 | 证据 |
|---|---|
| 首选成功 | agent exit=0，回答 `primary-ok`，primary 收到 3 次（含工具/系统提示轮次），backup 0 次 |
| 限流降级 | agent exit=0，回答 `backup-ok`，backup 被调用 |
| 下一请求回首选 | 恢复后回答 `primary-ok`，backup 0 次 |
| 全部失败 | agent exit=1，错误完整列出三条路由 |

**这一层是最重要的验证**：它证明插件在真实 agent 循环里工作，而不只是在探针里。

### 4.4 多轮续接 8/8

```powershell
node 'D:\Deeseek_HARENSS\创建插件\_isolation\e2e-multiturn.mjs'
```

同一会话连续四轮，验证持久化历史、跨 provider 切换、以及恢复后回到链头：

| 轮次 | 证据 |
|---|---|
| 第一轮 | 回答 `primary-ok` |
| 第二轮 | 回答 `primary-ok`，**上游收到 6 条消息**（历史确实持久化并传递） |
| 第三轮（primary 限流） | 回答 `backup-ok`，backup 收到 2 次请求 |
| 第四轮（primary 恢复） | 回答 `primary-ok`，**回到链头** |

**关键点**：第三轮由 backup 服务，第四轮仍能回到 primary 并带上完整历史——
证明 `source` 持久化、replay 状态和跨 provider 续接都正确。

### 4.5 设置接口 17/17

```powershell
node 'D:\Deeseek_HARENSS\创建插件\_isolation\e2e-settings.mjs'
```

`/state` 读取、`/save` 保存、重新加载、顺序保留、停用保留、
拒绝非对象/非法 JSON、拒绝跨站/异源、未知路由 404。

---

## 五、验证中发现并修复的真实缺陷

不是"测试写完就通过"，以下都是测试先失败、定位后修复的：

| 缺陷 | 现象 | 修复 |
|---|---|---|
| **请求体被丢弃** | `content.some is not a function` | 转发时用 `{...options, ...prepared.config, provider, model}` |
| **超时死锁** | 上游卡在 `next()` 时整个进程挂起 | 看门狗主动 settle + race `next()` + 关闭设上限 |
| **块开始误判为提交** | "仅思考后失败"无法降级 | `block-start` 不再提交；只有非空文本或工具调用提交 |
| **`contextWindow` 位置错** | 窗口被静默忽略 | 改为 `context: { contextWindow }` |
| **BOM 导致启动失败** | `Unexpected token '\uFEFF'` | 用 Node 以 UTF-8 无 BOM 写入 |
| **测试状态污染** | 场景间计数串味 | 假上游用 sentinel 标记区分探针请求 |

---

## 六、已知限制

1. **链间不级联，这是有意设计。** 一个请求只在它被选中的那条链内部降级：链内第 1 条
   失败就试第 2 条，直到**整条链**都失败才报错。链与链之间**不会**互相兜底。

   这样每条链就是一个独立档位——"日常"、"强推理"、"便宜"——用户选中哪个就只在那档里
   降级。若 A 链全失败后自动跳到 B 链，用户选的"日常"就会悄悄变成"强推理"，档位失去
   意义，而且 A 链的失败（可能正是用户想知道的信号）会被 B 链的成功掩盖。

   需要跨档兜底时，把想试的模型排进同一条链即可；`buildChain` 按 `provider+model`
   去重，重复项不会被执行两次。

   有 25 项断言守住这个语义（`_isolation/verify-chain-isolation.mjs`），包括
   "A 链全失败时 B 链的路由一次都没被调用"。

2. **设置卡片已在真实浏览器验证**（0.2.6）：Playwright + Chromium 驱动隔离 web 实例，
   15 项断言全过，含下拉联动、排序、启停、保存落盘。截图见 `_isolation/settings-card.png`。
   **剩余风险**：schemastery 的解析方式在 junction 安装下已验证，正式 `dsh plugin add`
   的布局未验证。

3. **生产环境安装未验证**：所有验证都在隔离 profile 完成，生产 profile 未安装。

> **图像能力筛选已端到端验证**（0.2.4）。此前的障碍是附件完整性校验；
> 解决办法是按内容寻址把真实 PNG 写入 `$DSH_HOME/attachments/v1/objects/<sha256>`，
> 引用即可通过校验。E2E 场景 11b 证明：图像请求时文本路由 0 次调用、视觉路由 1 次。
>
> **但这轮验证有盲区（0.2.10 修）**：它只证明了**路由级**筛选正确，没有检查
> **链级**的 `inputModalities` 声明。实际上那时链一直对宿主宣称 `['text']`，
> 导致宿主在到达本插件之前就把图片压平或直接拒绝——用户看到的是"用这个插件就没法
> 看图"。教训：验证一个筛选逻辑时，要连它**输入的前提**一起验证，否则筛选再正确也
> 是在错误的前提上运转。详见 3.5.1。

---

## 七、安装与回退

### 安装（需要用户明确授权）

```powershell
# 1. 备份
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item 'D:\Data\dsh\profiles\desktop\package.json' "D:\Data\dsh\profiles\desktop\package.json.bak-$ts"
Copy-Item 'D:\Data\dsh\profiles\desktop\pnpm-lock.yaml' "D:\Data\dsh\profiles\desktop\pnpm-lock.yaml.bak-$ts"

# 2. 建 junction（插件源码在 D 盘工作目录）
cmd /c mklink /J "D:\Data\dsh\profiles\desktop\node_modules\@local\dsh-model-rotation" "D:\Deeseek_HARENSS\创建插件\dsh-model-rotation"

# 3. 编辑 package.json：
#    dependencies 加 "@local/dsh-model-rotation": "link:D:/Deeseek_HARENSS/创建插件/dsh-model-rotation"
#    dsh.profile.bundles 加 "@local/dsh-model-rotation"

# 4. 编辑 pnpm-lock.yaml 的 importers 段（与 package.json 保持一致）

# 5. 完全退出 DSH 后重启
```

### 回退

```powershell
# 1. 从 package.json 移除依赖和 bundle 条目
# 2. 从 pnpm-lock.yaml 移除对应条目
# 3. 删除 junction
cmd /c rmdir "D:\Data\dsh\profiles\desktop\node_modules\@local\dsh-model-rotation"
# 4. 完全退出 DSH 后重启
```

### 配置

`$DSH_HOME/model-rotation/settings.json`：

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

## 八、开源参考

按 `AGENTS.md` 要求搜索了同类实现。**未引入任何依赖，未复制代码**。

| 项目 | 许可证 | 可借鉴之处 | 限制 |
|---|---|---|---|
| [dsh-llm-fallbacks](https://github.com/btspoony/dsh-llm-fallbacks) | MIT | 虚拟 provider 路线、提交语义、与 llm-retry 的边界划分 | TypeScript + 依赖 dsh-llm 类型包；功能远多于此需求 |
| [dsh-model-fallback](https://github.com/CarlCN2003/dsh-model-fallback) | MIT | 错误分类为 8 类、冷却与恢复作用域 | 走 `llm/stream` 路线；自带设置面板较重 |
| [dsh-fallback-router](https://github.com/hongxin-y/dsh-fallback-router) | MIT | 每模型一条链、时间窗口轮换 | TypeScript；路由语义与本需求不同 |
| [dsh-echelon](https://github.com/Abnerluo123/dsh-echelon) | MIT | 档位式路由、能力路由（图像/上下文） | 无设置页；配置需手改 |

许可证均允许参考思路，不复制代码即无合规风险。

