# 变更说明 — dsh-model-rotation 0.2.11

> **修复：链上第一个模型失败后不会自动切换到下一个。**
> 根因是一个未分类的错误码被默认当成终止。**160 / 160 单元测试通过。**

---

## 一、症状

用户反馈"不会自动切换下一个模型"。查请求日志发现：**40 次失败里有 30 次是同一个错误码**，
而且每次都只试了第一条路由就停了。

```
2026-11-21T09:14:45Z  trae2api-hub/DeepSeek-V4.1-Flash  code=INVALID_PREPARED_CALL  elapsedMs=1   tried=1
2026-11-21T09:15:06Z  trae2api-hub/DeepSeek-V4.1-Flash  code=INVALID_PREPARED_CALL  elapsedMs=0   tried=1
2026-11-21T09:18:02Z  trae2api-hub/DeepSeek-V4.1-Flash  code=INVALID_PREPARED_CALL  elapsedMs=0   tried=1
```

`elapsedMs=0` 是关键：错误在**派发瞬间同步抛出**，没有任何网络 I/O。`tried=1` 说明
链停在了第一条。

---

## 二、根因

### 2.1 这个错误码没有被分类

`shouldFailover` 对**未知码默认终止**（这是刻意的设计：对不理解的错误猜"换个地方重试"，
会把一个清晰的错误变成三个）。

但 `INVALID_PREPARED_CALL` 既不在可降级列表，也不在终止列表：

```js
RETRYABLE_CODES = [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT,
                   STREAM_CLOSED, MALFORMED_RESPONSE, QUOTA, CONTEXT_WINDOW_EXCEEDED]
TERMINAL_CODES  = [ABORTED, AUTH, INVALID_REQUEST, MODEL_UNSUPPORTED,
                   NO_ADAPTER, UNKNOWN_MODEL, UNSUPPORTED_CONTENT]
```

于是它走了"未知 → 终止"的分支，一条链的第一个模型失败后整条链就结束了。

### 2.2 这个错误本身是什么

读宿主 `dsh-llm` 源码（`prepareCall`，第 2350-2370 行）确认它有两个来源：

```js
stream: (options) => {
  if (dispatched) throw new LlmError("a prepared LLM call can only be dispatched once",
                                     "INVALID_PREPARED_CALL");
  if (!callConfigEquals(options, resolvedConfig)) throw new LlmError(
    "prepared LLM call config changed before adapter dispatch", "INVALID_PREPARED_CALL");
  dispatched = true;
  ...
}
```

| 来源 | 含义 |
|---|---|
| `dispatched` 已置位 | 同一个 prepared 句柄被派发了两次 |
| `callConfigEquals` 失败 | 转发的控制字段与解析出的配置不一致 |

**两者都属于"这个句柄坏了"，不属于"这段对话没救了"。** 而链上的下一条路由是用
**全新句柄**准备的（插件对每条路由单独调用 `ctx.llm.prepareCall`），所以它完全可能成功。

把句柄级的失败当成会话级失败，就是这次 bug 的本质。

---

## 三、修复

把 `INVALID_PREPARED_CALL` 加入可降级列表：

```js
export const RETRYABLE_CODES = Object.freeze([
  ...
  'CONTEXT_WINDOW_EXCEEDED',
  // The host binds a prepared call to one dispatch and also rejects a dispatch
  // whose controls drifted from the resolved config. Either way the failure
  // belongs to the handle, not to the conversation: the NEXT route is prepared
  // with a fresh handle and can still answer.
  'INVALID_PREPARED_CALL',
])
```

### 为什么不是"加个通配兜底"

我没有改成"未知码一律降级"。那会破坏原有的安全边界：`AUTH`、`INVALID_REQUEST` 这类
错误在每条路由上都会同样失败，降级只会让用户多看几次同样的错误、多等几倍时间。

`INVALID_PREPARED_CALL` 值得单列，是因为它**有明确的归属**：它说的是句柄状态，不是
请求内容。这个判断有源码依据，不是猜的。

---

## 四、验证

### 4.1 复现（修复前）

```
shouldFailover(INVALID_PREPARED_CALL) = false
结果        : error
尝试过的路由: trae2api-hub/DeepSeek-V4.1-Flash
拿到答案    : []
=> 第一条抛错后整条链停下，第二条（本可成功）从未被尝试。
```

### 4.2 修复后

```
shouldFailover(INVALID_PREPARED_CALL) = true
结果        : stop
尝试过的路由: trae2api-hub/DeepSeek-V4.1-Flash → wb-proxy/deepseek-v4.1-flash
拿到答案    : ["from-backup"]
```

### 4.3 完整场景（9 项断言，用生产链的 4 条路由）

| 场景 | 结果 |
|---|---|
| 第一条抛该错误 | 第二条顶上并给出答案 |
| 连续三条都抛 | 第四条顶上并给出答案 |
| 全部四条都抛 | 只报一个错，点名全部 |
| **AUTH（回归保护）** | **仍然只试一条就停** |

最后一行的意义：修复没有放宽终止码的边界。

### 4.4 测试

```
单元测试   160 / 160
```

新增 2 项：
- `an invalid prepared call advances the chain instead of ending it`（分类）
- `a dispatch-time prepared-call failure falls over to the next route`（端到端）

---

## 五、需要重启

`src/chain.js` 是后端改动，**需要重启 DSH** 生效。

重启后自检：让第一条路由失败（或等它自然失败），观察是否切到第二条而不是直接报错。

---

## 六、遗留：为什么会有坏句柄

这次修的是**后果**（不降级），不是**原因**（为什么产生坏句柄）。

`elapsedMs=0` 且集中在 `trae2api-hub/DeepSeek-V4.1-Flash` 上，说明那个时刻该路由的
prepared 句柄确实被重复派发或配置漂移了。可能的相关机制：

- 宿主 `agent-loop` 的 `while (true)` 重试循环（第 854 行）在 `continue` 后重新
  `prepareRequest`，理论上每次都是新句柄
- `requestHeaderLogged` 之后控制字段从会话 header 回放（第 1002 行），可能与新路由的
  默认值不同

**但现在链能自己恢复了**：一条路由的坏句柄不再终结整条链。如果这个错误仍然频繁出现，
下一步该查的是宿主侧的重试路径，而不是插件。
