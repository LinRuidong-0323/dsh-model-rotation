# Codex 审核提示词

> 复制下面整段（分隔线之间）发给 Codex。

---

我要你审核一个 DeepSeek Harness（DSH）插件，**只做代码审查，不要修改任何文件，不要安装或运行任何东西**。

## 背景

DSH 是一个基于 Cordis 插件框架的 AI 编码工具（版本 0.2.2-rc.1，Windows 桌面版）。我写了一个「模型轮换」插件：把一组 `provider/model` 路由打包成一条有序链，在模型选择器里显示为一个条目；选中后按顺序尝试链上每个路由，遇到可重试失败（限流、超时、5xx、空响应）自动降级到下一个。

需求来源：用户有多个自定义 API 渠道（Trae、WorkBuddy，各自通过本地网关暴露成 OpenAI 兼容端点），希望选定渠道后按自设优先级自动切换模型，且只在当前请求内降级，下一轮回到首选。

**插件当前状态：未完成。** 离线单测 28/28 通过；在真实 DSH 进程内 dispatch 时失败，根因已定位但我判断当前方案存在架构冲突，需要你复核这个判断是否正确。

## 待审代码

根目录：`D:\Deeseek_HARENSS\创建插件\dsh-model-rotation\`

```
README.md              完整说明（先读这个）
package.json           包清单
cordis.patch.yml       loader 插入行
index.js          77 行 Cordis 挂载
src/chain.js     125 行 错误分类、链路构建（纯函数）
src/config.js    189 行 配置存储（原子写、mtime 失效）
src/adapter.js   431 行 核心：逐路由尝试、失败降级
test/rotation.test.js  424 行 28 项断言
```

请先读 `README.md`，特别是第三节「设计」和第五节「已知阻塞问题」。

## 我已确认的 DSH 行为（不必再验证，直接采信）

这些是我在调试中通过读 `app.asar` 里的源码确认的：

1. `ctx.llm.prepareCall(config, signal)` 接收 **config 对象**（不是 `(provider, model)`），返回 `{ config, retryPolicy, adapterDefaults, context, inputModalities, stream }`。
2. `prepared.stream(options)` 会调用 `callConfigEquals(options, resolvedConfig)` 校验，比较 `provider / model / reasoningEffort / temperature / maxTokens / stop`。传调用方原始 options 会失败，因为 registry 在准备阶段填充了默认值。
3. `resolveModel()` 返回的 `contextWindow` 必须嵌在 `context: { contextWindow: N }` 下，扁平字段会被静默忽略。
4. `agent-default-model` 在 profile 组装阶段校验，**早于插件 bundle 挂载**。所以默认模型不能指向插件提供的 provider。
5. 错误码体系：可重试的是 `EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`（`dsh-llm-retry` 的默认集合），另有 `STREAM_CLOSED / MALFORMED_RESPONSE / QUOTA` 标记为 `retryChoice: true`。

## 当前阻塞问题（重点）

在真实 DSH 进程内调用 `prepared.stream()` 时抛：

```
Cannot read properties of undefined (reading 'some')
```

我已排除：
- 插件加载失败（provider 注册成功，显示「模型轮换」）
- `listModels()` 错误（链正确公告：`advertised chains: iso (1)`）
- `prepareCall()` 错误（正常返回完整 handle）
- 插件源码里有 `.some`（grep 确认没有）
- 假上游格式问题（直连 provider 的基线请求能正常返回）

我的判断：错误发生在 DSH 的 `streamWithRegistration` → `forAdapter()` 投影层，在插件的 `#stream` 被调用之前。`forAdapter` 遍历 `options.messages`，对 `role === 'assistant'` 的消息访问 `source.replayState`。轮换链作为虚拟 provider 时，请求的 `provider` 是 `model-rotation`，而消息 `source.provider` 是真实 provider，DSH 判定不一致，进入 source 重写分支。

**我认为虚拟 provider 方案与 DSH 的消息来源追踪机制存在根本冲突**，建议改为 `llm/stream` waterfall 监听器方案（不注册新 provider，失败时改写 provider/model 重试）。

## 请回答这些问题

1. **我的根因判断对吗？** 虚拟 provider 与 `forAdapter` 的 source 重写是否真的冲突？有没有我遗漏的、让当前方案可行的办法（比如正确设置 messages 的 source）？

2. **方案 A（`llm/stream` waterfall）是否可行？** 这条路线的约束是什么：
   - 能否在 waterfall 里拿到失败原因并重试？
   - 重试时改写 `provider/model` 会不会触发别的校验？
   - 部分输出已经流出的情况下能否安全切换？
   - 与内置的 `dsh-llm-retry` 如何共存（README 提到它挂在 agent 的 failed-step 扩展点）？

3. **降级语义是否有漏洞？** 重点看：
   - `runRoute()` 的缓冲策略：`commitsAnswer` / `carriesProgress` 判定是否覆盖「思考后失败」「工具调用后失败」
   - `#stream()` 里终止 chunk 的唯一性（是否所有路径都恰好一个）
   - 错误聚合逻辑（全部失败时列出所有路由）

4. **错误分类是否合理？** `src/chain.js` 的 `RETRYABLE_CODES` / `TERMINAL_CODES`：
   - 有没有该降级却没降级的码？
   - 有没有不该降级却降级的码？
   - 「未知码一律不降级」这个保守选择是否恰当？

5. **配置存储是否健壮？** `src/config.js`：
   - `normalizeSettings()` 的输入校验够不够，畸形配置能否拖垮插件？
   - 原子写 + mtime 失效的并发安全性如何？
   - 有没有路径穿越、原型污染之类的风险？

6. **有没有我没意识到的问题？** 包括但不限于：内存泄漏、effect 清理、并发请求共享状态、流未正确关闭。

## 输出要求

- 按严重程度分级：**阻塞 / 重要 / 建议**
- 每条给出：问题描述、所在文件和行号、为什么是问题、具体改法
- 对我上面 6 个问题逐条明确回答（同意 / 不同意 / 不确定，并说明理由）
- 如果认为方案 A 不可行，给出你认为可行的替代方案
- 不要输出完整重写代码，给关键片段和修改方向即可

## 约束

- **只读审查**，不要修改 `D:\Deeseek_HARENSS\创建插件\dsh-model-rotation\` 下任何文件
- 不要安装插件、不要启动 DSH、不要跑 `pnpm install`
- 不要动 `D:\Data\dsh\profiles\desktop\`（那是用户正在使用的真实 profile）
- 可以运行 `node --test test/rotation.test.js` 验证单测
- 如果某个 DSH 行为你需要自己确认，`app.asar` 在 `C:\Users\隔壁小林\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`，是标准 asar 格式（header 长度在偏移 12，JSON header 从偏移 16 开始）
