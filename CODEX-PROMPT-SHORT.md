审核 `D:\Deeseek_HARENSS\创建插件\dsh-model-rotation`，只读审查，不要改文件、不要装插件、不要启动 DSH。

先读 `PROJECT-SUMMARY.md` 和 `CHANGELOG-0.2.6.md`。**忽略 `CODEX-REVIEW-PROMPT.md`**（旧文件，含已被推翻的结论）。

这是一个 DSH 插件：注册虚拟 provider `model-rotation`，每条"链"是一串 `provider/model`，按序尝试、失败降级。已通过 9 层隔离验证（103 单测 + 63 E2E + 14 真实 agent + 8 多轮 + 17 设置接口 + 15 浏览器 UI）。

**已确认的 DSH 契约**（不必验证，直接采信）：
- `prepareCall(config, signal)` 收 config 对象；`prepared.stream(options)` 用 `callConfigEquals` 校验控制字段，请求体须完整转发
- `resolveModel` 的窗口须嵌在 `context.contextWindow`
- 缺 `messages` 会崩在 `content.some`
- 设置卡片：slot 是 `settings.plugins.tab`（`id` 寻址），插件必须导出 `Config`，**且每个字段必须 `.extra('volatile', true)`**，否则 `dsh-settings.describe()` 跳过该条目
- `@deepseek-ai/schemastery` 是 default 导出，且必须在模块加载时同步取得（loader 在 `apply()` 前读 `Config`）

**重点看这 6 处**：

1. `src/attempt.js` 的 `runAttempt()`：看门狗主动 `settle` + `Promise.race(iterator.next(), outcome.then())`。问：`settle` 与生成器 `finally` 的 `settle(abortOutcome())` 会不会让超时被覆盖成 aborted？`outcome.then()` 每轮新建 Promise 是否有问题？500ms 关闭上限够不够？

2. `src/adapter.js` 的 `#stream()`：降级循环、提交后固定路由、错误聚合、能力筛选。问：能力筛选跳过的路由与降级计数交互是否正确？提交后失败的路径真的不会拼接下一个模型的输出？

3. `src/cooldown.js` 的 `partition()`：失败路由排到链尾，但**全冷却时保持原序**。问：这个"永不清空链"的策略在极端情况下会不会让用户每次都撞同一个坏路由？指数增长上限 10 分钟是否合理？

4. `src/capability.js` 的 `estimateTextTokens()`：CJK 按 1 token/字，其余按 4:1。问：emoji 按 4:1 是否低估？估算偏高会不会把链缩到空？

5. `src/http.js` 的 `rejectionFor()`：回环 host + `sec-fetch-site` + Origin 匹配。问：能防 DNS rebinding 吗？还缺什么？

6. `client.js` 的 `RotationCard`：已在真实浏览器验证渲染与保存（15 项断言），但未测并发编辑。问：保存失败后 draft 与服务端不一致的路径？异步操作泄漏？`useCallback` 依赖正确吗？

**另外**：`index.js` 里 `resolveSchemaSync()` 用 `createRequire` 从插件目录 require schemastery——这种解析方式在正式安装（非 junction）时是否成立？如果用户用 `dsh plugin add` 安装，`node_modules` 布局不同，会不会失效？

按 阻塞/重要/建议 分级，每条给文件:行号、为什么是问题、怎么改。不要输出完整重写代码。

可以跑单测：
```
cd D:\Deeseek_HARENSS\创建插件\dsh-model-rotation
node --test test/*.test.js
```
