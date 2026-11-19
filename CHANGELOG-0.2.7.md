# 变更说明 — dsh-model-rotation 0.2.7

> 本轮把两处"已写代码但没接上"的改动落地：整链上下文超限时的可操作提示，
> 以及请求日志真正写入磁盘。**115 / 115 单元测试通过。**

---

## 一、整链上下文超限时给出可操作提示

### 1.1 问题

0.2.6 把 `CONTEXT_WINDOW_EXCEEDED` 改成可降级，链会走完所有路由。但当**每条路由
都因超限失败**时，用户看到的是：

```
every route in chain "chain-1" failed — wb-proxy/deepseek-v4.1-flash: CONTEXT_WINDOW_EXCEEDED; wb-proxy/glm-5.3-flash: CONTEXT_WINDOW_EXCEEDED
```

这句话是准确的，但没有下一步。用户最自然的反应是"换个厂商试试"——而**这正是链
刚刚自动做完的事**。一个把该动作自动化掉的插件，再用它作为建议，等于让用户原地转圈。

### 1.2 改动

`src/adapter.js` 新增两个纯函数：

| 函数 | 职责 |
|---|---|
| `allRejectedForLength(tried)` | 判断是否**全部**失败都因长度 |
| `contextWindowHint(inputTokens)` | 生成可操作提示 |

`summarizeFailure()` 在**纯长度失败**时追加提示：

```
every route in chain "chain-1" failed — wb-proxy/deepseek-v4.1-flash: CONTEXT_WINDOW_EXCEEDED; wb-proxy/glm-5.3-flash: CONTEXT_WINDOW_EXCEEDED

提示：所有候选模型都判定上下文超限，这不是某一个厂商的限制，换厂商不会更宽松。当前请求约 1050K tokens（估算）。请开一个新会话继续，或先压缩这段对话再重试。
```

### 1.3 为什么只在"全部超限"时追加

这是本轮唯一需要判断的地方。反例：一条路由 `TIMEOUT`、另一条 `CONTEXT_WINDOW_EXCEEDED`。

此时长度**不是**唯一原因——那条超时的路由可能窗口绰绰有余。若仍提示"请压缩对话"，
用户压缩完再试，超时的那条照样超时，提示把他带向了错误方向。

所以判定用 `every` 而不是 `some`，并有测试专门守住这个反例。

### 1.4 提示里为什么不说 `/compact`

本 profile 的 `command-compact` 与 `compaction-basic` 均为 disabled（`plugin_manager`
实测），所以提示只写"开新会话 / 先压缩对话"，不指定一个可能不存在的命令。
写一个用户跑不了的具体命令，比不写更糟。

---

## 二、请求日志真正接入

### 2.1 问题

`src/request-log.js` 在 0.2.6 已完整实现，但**没有 import 到任何地方**，等于死代码。
结果是"这次到底用了哪个模型"仍然无处可查：设置卡片只保留每条链最近一次命中，
宿主 logger 不持久化 info 行。

### 2.2 改动

| 文件 | 改动 |
|---|---|
| `index.js` | import `RequestLog`；构造时指向 `$DSH_HOME/model-rotation/request-log.json`；传给 adapter |
| `src/adapter.js` | `#reportFailure()` 增加 `requestLog.record({... outcome:'failed' ...})` |
| `index.js` | `diagnostics()` 增加 `recentRequests`（最近 20 条）与 `requestLogFile` |

0.2.6 里 answer 路径已有 `record()` 调用，本轮补上的是**失败路径**——此前只有成功
的请求会被记录，而失败恰恰是更需要事后查的。

### 2.3 耗时统计的口径

answer 路径的 `elapsed` 是**单条路由**的耗时。失败路径如果沿用同一个变量，会把
"整条链走了多久"错记成"最后一条路由走了多久"。

因此 `#stream` 里新增 `walkStarted`（整次遍历开始时刻），并传给每个
`#reportFailure(..., { startedAt: walkStarted })`。两个口径各自有意义，不能混用。

### 2.4 日志的约束

| 约束 | 实现 | 针对的风险 |
|---|---|---|
| 有界 | 最多 200 条 | 日志随会话无限增长 |
| 原子写 | 临时文件 + rename | 进程中途退出留下半个文件 |
| 写失败不影响路由 | `try/catch` + 一条警告 | 诊断设施变成新的故障点 |
| 损坏可恢复 | 按空日志处理 | 手改坏一个 JSON 就让模型调用失败 |
| 不含请求内容 | 只记链/路由/码/耗时 | 用户把这份文件贴进 issue 时泄露 prompt |

最后一条有专门测试：往 `record()` 里塞一个 `messages` 字段，断言落盘内容里
搜不到该文本。

---

## 三、修掉一个自己引入的编码事故

用 PowerShell `Set-Content -Encoding utf8` 做批量文本替换时，整个 `src/adapter.js`
被按 GBK 解码再以 UTF-8 写回：

- 所有中文和 `—`、`→` 变成乱码
- 文件被加了 UTF-8 BOM

由于 GBK 解码是**跨字节**的，部分字符的信息已不可逆丢失，无法用反向转码还原。
处理方式是按行号精确重写这 11 行（原文从文件自身历史可知），并剥掉 BOM。

**教训**：批量改文件用 `edit`/`write` 工具，不要用 shell 的文本重写。脚本只用于
**读取**和**校验**。

修复后有校验脚本确认：仓库内所有 `.js` 文件 BOM 数量为 0，非 ASCII 行内容正确。

---

## 四、验证

```
单元测试          115 / 115
```

本轮新增 10 项：

| 测试 | 守住什么 |
|---|---|
| a walk where every route rejects the length explains what to do | 提示存在且包含关键信息 |
| a mixed failure does not claim the length was the cause | `every` 而非 `some` 的判定 |
| a length hint is not added when nothing was attempted | 空遍历不追加提示 |
| an all-length walk names the size only when it is known | 规模未知时不硬编数字 |
| an answered walk is recorded with the route that served it | 成功路径落盘 |
| a failed walk is recorded once, naming the last route tried | 失败路径落盘，且不按路由重复记 |
| the request log excludes prompt content | 不泄露请求内容 |
| the request log survives a restart | 换进程后仍可读 |
| a corrupt request log is discarded rather than fatal | 损坏文件不致命 |
| the request log is bounded | 200 条上限 |

---

## 五、未做的事

### 5.1 链间级联（仍未支持）

用户问过"如果 wb 也都失败，跳下一个链？"。当前**一个请求只在一条链内部降级**，
链与链之间没有跳转。

推荐做法是**合并成长链**（零改动，用户自己配），而不是新增 `nextChain` 字段
（要处理循环引用）。这一点仍需用户确认方向，本轮未动。

### 5.2 需要重启才生效

本轮改动在 `src/adapter.js` 与 `index.js`，两者都由 Host 在启动时加载。
**必须重启 DSH 才生效。**
