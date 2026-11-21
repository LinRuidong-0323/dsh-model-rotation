# 交接文档 — 0.2.11，待重启生效

> 写于 2026-11-21 17:35
> **状态：0.2.6–0.2.10 已生效；0.2.11 修了"不自动切换下一个模型"，需重启。**

---

## 零、本轮修的 bug：链不会降级

**症状**：第一个模型失败后，链直接报错，不试后面的路由。

**根因**：`INVALID_PREPARED_CALL` 这个错误码没有分类，走了"未知码默认终止"的分支。

请求日志证据：40 次失败里 **30 次**是它，每次 `tried=1`、`elapsedMs=0`（派发瞬间同步
抛出，没有网络 I/O）。

**这个码的含义**（读 `dsh-llm` 源码确认）：宿主把 prepared call 绑定到一次性派发，
重复派发或控制字段漂移都会报它。**它说的是"句柄坏了"，不是"对话没救了"**——而链上
下一条路由用的是**全新句柄**，完全可能成功。

**修复**：加入 `RETRYABLE_CODES`。

**没有改成"未知码一律降级"**：那会破坏安全边界，`AUTH`/`INVALID_REQUEST` 在每条路由
上都会同样失败。有测试守着 `AUTH` 仍然只试一条就停。

详见 `CHANGELOG-0.2.11.md`。

---

## 一、链间是**故意**隔离的

```
选中 A（日常主力）   → 只在 A 内部逐条降级 → A 全失败才报错
选中 B（强推理模型） → 只在 B 内部逐条降级 → B 全失败才报错
```

**不要再把它"优化"成链间级联。** A 链全失败本身是用户需要知道的信号。

生产配置（用户自己维护）：

```
chain-1 "日常主力"    4 条：trae × DeepSeek-V4.1 → wb × deepseek-v4.1
                            → trae × GLM-5.3-Flash → wb × glm-5.3-flash
chain-2 "强推理模型"  2 条：trae × GLM-5.3 → wb × kimi-k2.8-preview
```

---

## 二、0.2.11 改了什么

| 文件 | 改动 |
|---|---|
| `src/chain.js` | `RETRYABLE_CODES` 增加 `INVALID_PREPARED_CALL`（附源码依据注释） |
| `test/rotation.test.js` | +2 项（分类断言、端到端降级） |
| `README.md` | 错误分类表、说明为什么不是通配兜底 |
| `CHANGELOG-0.2.11.md` | 新增 |

---

## 三、需要重启

`src/chain.js` 是后端改动，**需要重启 DSH**。

重启后自检：让第一条路由失败，应看到切到第二条而不是直接报错。

---

## 四、验证状态

| 项 | 结果 |
|---|---|
| 单元测试 | **160 / 160** |
| 降级修复场景 | 9 / 9 |
| 视觉端到端 | 10 / 10 |
| 链间隔离 | 25 / 25 |
| 冷却与链完整性 | 14 / 14 |

```powershell
cd 'D:\Deeseek_HARENSS\创建插件\_isolation'
node verify-failover-fix.mjs      # 本轮新增
node verify-chain-isolation.mjs
node verify-cooldown-chain.mjs
node verify-vision-e2e.mjs
```

---

## 五、遗留：坏句柄从哪来

本轮修的是**后果**（不降级），不是**原因**（为什么产生坏句柄）。

`elapsedMs=0` 且集中在 `trae2api-hub/DeepSeek-V4.1-Flash`，说明那个时刻该路由的
prepared 句柄确实被重复派发或配置漂移。可疑机制：

- `dsh-agent-loop` 的 `while (true)` 重试循环（第 854 行）`continue` 后重新
  `prepareRequest`（第 855 行），理论上每次新句柄
- `requestHeaderLogged` 之后控制字段从会话 header 回放（第 1002 行），可能与新路由的
  默认值不同

**但现在链能自己恢复了**。如果这个码仍频繁出现，下一步该查宿主侧重试路径，不是插件。

---

## 六、踩过的坑

### 6.1 PowerShell 会毁掉 UTF-8 文件

`Get-Content -Raw | Set-Content -Encoding utf8` 会按 GBK 读、按 UTF-8 写，中文全变乱码。
**批量改文本只能用 `edit`/`write` 工具**。本轮再次踩到（PROJECT-SUMMARY.md），
靠 rewind 快照恢复。

### 6.2 查数据必须看时间

上一轮我曾用 11-16/17 的旧会话断定"trae 不上报 token 用量"，实际 11-18 就修好了、
11-19 已 100% 上报。**看历史数据先看时间戳，别把修复前的样本当现状。**

### 6.3 复现要用真实契约

复现 `INVALID_PREPARED_CALL` 时，前三版假 registry 都太宽容（把请求原样回声），
所以复现不出来。必须模拟宿主的两个真实行为：**默认值materialization** 和
**一次性派发守卫**。

### 6.4 主题令牌要在卡片元素上读

`document.documentElement` 上读 `--dsw-alias-*` 全是空，令牌定义在内层作用域。



