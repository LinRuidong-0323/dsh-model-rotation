# 交接文档 — 0.2.10，待重启生效

> 写于 2026-11-17 19:30
> **状态：0.2.6–0.2.9 已生效；0.2.10 修了图片识别失效，需重启。**

---

## 零、必须先知道：图片识别为什么坏了

**这是本插件的一个真 bug，存在了 6 个版本（0.2.4–0.2.9）。**

插件对宿主宣称「这条链只支持文本」（`inputModalities: ['text']`），宿主照做：

- `dsh-llm:2447` 把图片**压成文字**再发
- `dsh-api-session-controller:921` 在上传阶段直接抛 `MODEL_DOES_NOT_SUPPORT_IMAGES`
- `dsh-tool-fs` / `dsh-tool-office` / `dsh-subagent` / `dsh-mcp-client` 直接拒绝

不只是聊天发图失效，连「让模型读一张本地图片」也一起没了。

**关键区别**：字段**存在**且不含 `image` → 宿主压平；字段**不存在** → 宿主不管。
所以 `['text']` 是主动断言「瞎」，`undefined` 才是「不知道」。

修复见 `CHANGELOG-0.2.10.md`。**不要把 `inputModalities` 改回固定值**，
有 7 项测试守着。详见 README 3.5.1。

---

## 一、链间是**故意**隔离的

用户最终确认的语义：

```
选中 A（日常主力）   → 只在 A 内部逐条降级 → A 全失败才报错
选中 B（强推理模型） → 只在 B 内部逐条降级 → B 全失败才报错
```

**不要再把它"优化"成链间级联。** A 链全失败本身是用户需要知道的信号；自动跳到 B 会
让 B 的成功掩盖 A 的故障。

生产配置（用户自己改的）：

```
chain-1 "日常主力"    6 条
chain-2 "强推理模型"  2 条
```

---

## 二、0.2.10 改了什么

| 文件 | 改动 |
|---|---|
| `src/adapter.js` | `resolveModel` 与 `listModels` 不再对有硬编码 `['text']`；未知保持 `undefined`；模态取路由并集 |
| `src/adapter.js` | `listModels` 改为 `async`（要逐条解析模态），宿主本来就 `await`，契约不变 |
| `test/rotation.test.js` | +7 项视觉测试 |

---

## 三、需要重启

`src/adapter.js` 是后端改动，**需要重启 DSH**。

重启后自检：

1. 设置 → 模型 → 选 `模型轮换 / 日常主力`
2. 贴一张图
3. 不应再出现「当前模型不支持图片输入」

> 如果 provider 确实不支持图片，现在由**上游**返回真实错误，而不是插件提前拦截。
> 这是正确的：插件不该替厂商做这个决定。

---

## 四、验证状态

| 项 | 结果 |
|---|---|
| 单元测试 | **158 / 158** |
| 视觉端到端 | 10 / 10 |
| 视觉三种情形 | 3 / 3 |
| 链间隔离 | 25 / 25 |
| 冷却与链完整性 | 14 / 14 |
| 全部文件编码完整性 | 38 个文件 0 问题 |

```powershell
cd 'D:\Deeseek_HARENSS\创建插件\_isolation'
node verify-vision-e2e.mjs
node verify-vision-fix.mjs
node verify-chain-isolation.mjs
node verify-cooldown-chain.mjs
```

---

## 五、这一轮我犯的一个错（重要）

**我又用 PowerShell 的 `Get-Content -Raw | Set-Content -Encoding utf8` 改文件，
把 `PROJECT-SUMMARY.md` 整个转成了乱码。**

- `Get-Content` 默认按 GBK 读 UTF-8 文件 → 乱码
- `Set-Content -Encoding utf8` 把乱码写回 → 文件 503 处信息永久丢失

**恢复过程**：DSH 的 rewind 快照里存着编辑前的文件副本
（`~/.dsh/rewind-snapshots/.../*.before`），找到 19:19:30 那份 26150 字节的
完整副本，验证无私有区字符后覆盖回去，再用 `edit` 工具重新应用改动。

**教训（第二次了）**：批量改文本**只能用 `edit` / `write` 工具**。
PowerShell 只用来**读取**和**校验**，绝不用来写文件。

已加检查：`_isolation/check-integrity.py` 扫全部 `.md`/`.js`/`.json`，
检测 BOM、非 UTF-8、替换字符、私有区字符。当前 38 文件 0 问题。

---

## 六、踩过的其他坑

### 6.1 迷你 React 必须实现 deps 语义

`test/harness.js` 已正确实现 `useCallback`/`useEffect` 的依赖比较。否则每次渲染都
重跑 `refresh()`，覆盖用户操作，让正常功能看起来是坏的。

### 6.2 主题令牌要在卡片元素上读

`document.documentElement` 上读 `--dsw-alias-*` 全是空，令牌定义在内层作用域。

### 6.3 "背景字符串不同"不等于"看得见"

浅色主题下 `bg-base`、`bg-layer-1`、`bg-layer-2` 全是 `#fff`。选中态改用
`color-mix` 从品牌色混出底纹。

### 6.4 PowerShell 会毁掉 UTF-8 源文件

见第五节。

---

## 七、待办

### 7.1 设置卡片显示请求日志（后端已有，前端未渲染）

`diagnostics.recentRequests` 已在 API 返回（最近 20 条），但 `client.js` 没渲染它。

### 7.2 图片能力的真实确认（已用真实配置验证）

从 `~/.dsh/profiles/desktop/cordis.patch.yml` 解析出的**真实声明**：

| 模型 | 声明 |
|---|---|
| `wb-proxy/deepseek-v4.1-flash` | `text + image` |
| `wb-proxy/glm-5.3-flash` | `text + image` |
| `trae2api-hub/DeepSeek-V4.1-Flash` | `text + image` |
| `trae2api-hub/GLM-5.3-Flash` | `text + image` |
| `trae2api-hub/GLM-5.3` | `text + image` |
| `trae2api-hub/Qwen3.8-Flash` | **未声明**（未知） |
| `trae2api-hub/Qwen3.8-Max` | **未声明**（未知） |
| `trae2api-hub/Kimi-K2.8-Preview` | **未声明**（未知） |

全文件共 20 处 `input:` 声明，**没有一处是只文本**。

**结论：你的 provider 确实支持图片。** 之前不能用，纯粹是插件用 `['text']`
覆盖了真实声明。

验证脚本 `_isolation/verify-real-chains-image.mjs` 用这份真实声明跑完整链路：

- chain-1 现在声明 `["text","image"]`（修复前是 `["text"]`）
- 图像请求不再被压平，能正常落到路由
- 全程不会打到「明确只文本」的路由

> 注意：`Qwen3.8-Flash` 和 `Qwen3.8-Max` 在配置里**没有** `input:` 段，属于
> 「未声明」。宿主对未声明不做干预，所以图片会照常发给它们——如果它们实际看不见，
> 会由上游报错。这是正确行为：插件不该替厂商猜。


