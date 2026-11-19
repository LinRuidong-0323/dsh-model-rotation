# 变更说明 — dsh-model-rotation 0.2.10

> **修复：用了这个插件之后，图片识别失效。**
> 这是一个从 0.2.4 就存在的设计错误，不是新引入的。**158 / 158 单元测试通过。**

---

## 一、问题

用户反馈："为什么用了这个插件，我无法用图片识别了？"

根因是**插件主动告诉 DSH「这条链看不见图片」**，DSH 照做了。

---

## 二、两个 bug

### 2.1 `listModels()` 把 `inputModalities` 写死成 `['text']`

```js
// 修复前
.map(chain => ({
  provider: ROUTER_PROVIDER,
  id: chain.id,
  name: chain.name,
  inputModalities: ['text'],   // ← 不管底层路由能不能看图
}))
```

**无论链里放的是 Qwen3.8-Max 还是 GLM-5.3，选择器都显示「只支持文本」。**
宿主用它决定要不要提供图片入口。

### 2.2 `resolveModel()` 把「未知」当成「不支持」

```js
// 修复前
const base = { provider, id: model, name: ..., inputModalities: ['text'] }
```

这一行在两个地方返回：链不存在时、链为空时。更关键的是，即使走到了正常路径，
`inputModalities` 也只在**某条路由声明了模态**时才被覆盖；**所有路由都不声明时，
`base` 的 `['text']` 就留下来了**。

而 `trae2api-hub`、`wb-proxy` 这类自定义代理端点**通常不声明模态**——于是插件替它们
做出了「看不见」的断言。

---

## 三、DSH 是怎么用这个字段的

读了 `app.asar` 里的宿主源码，确认了三处消费点：

### 3.1 压平图片（`dsh-llm/lib/index.js:2447`）

```js
if (modelInfo.inputModalities !== void 0
    && !modelInfo.inputModalities.includes("image")
    && projectedMessages.some(m => contentHasImage(m.content)))
  projectedMessages = projectImagesForTextModel(projectedMessages)
```

**关键在 `!== void 0`**：字段**存在**且不含 `image` → 把图片压成文字。
字段**不存在**（`undefined`）→ 宿主不管，原样转发。

所以 `['text']` 是主动断言「瞎」，而 `undefined` 是「不知道，你自己判断」。

### 3.2 上传前拒绝（`dsh-api-session-controller/lib/index.js:921`）

```js
if (model.inputModalities !== void 0 && !model.inputModalities.includes("image"))
  throw new RemoteError("session/attachment-invalid",
    `Model "${current.model}" does not support image input.`,
    { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" })
```

前端把 `MODEL_DOES_NOT_SUPPORT_IMAGES` 翻成「当前模型不支持图片输入」。

### 3.3 其他直接拒绝的消费方

| 包 | 行为 |
|---|---|
| `dsh-tool-fs` | 读图工具直接拒绝：`model does not declare image input` |
| `dsh-tool-office` | 渲染图片直接拒绝 |
| `dsh-subagent` | 子代理带图直接拒绝 |
| `dsh-mcp-client` | MCP 返图直接拒绝 |

**这解释了一个现象**：不只是聊天发图，连「让模型读一张本地图片」也会一起失效。

---

## 四、修复

### 4.1 原则：未知 ≠ 看不见

| 情况 | 修复前 | 修复后 |
|---|---|---|
| 所有路由都不声明模态 | `['text']`（断言瞎） | `undefined`（未知，宿主自行判断） |
| 有路由声明 `['text','image']` | `['text']`（错） | `['text','image']` |
| 所有路由都声明 `['text']` | `['text']` | `['text']`（正确，仍然压平） |
| 链不存在 / 链为空 | `['text']` | `undefined` |

### 4.2 链是一个「合并的模型」

一条链在界面上是一个可选模型，所以它的能力应该是**路由的并集**：
只要有一条路由能看图，这条链就能看图，再由能力筛选把请求路由到那条路由。

### 4.3 `listModels()` 改为 async

因为要逐条路由解析模态，`listModels` 变成 `async`。
宿主本来就 `await ctx.llm.listModels(...)`，契约不变。

---

## 五、验证

### 5.1 单元测试（新增 7 项）

```
单元测试   158 / 158
```

| 测试 | 守住什么 |
|---|---|
| a chain over vision routes advertises image input | 视觉链声明 image |
| listModels reports image input for a vision chain | 选择器不再写死 text |
| a chain whose routes disclose nothing does not claim to be blind | 未知保持未知 |
| an unknown chain does not claim to be blind | 早退路径不撒谎 |
| a mixed chain sees images when any route can | 并集语义 |
| a chain of explicitly text-only routes still says text only | 反向不误伤 |
| an image request is routed only to the vision route | 端到端只打视觉路由 |

### 5.2 隔离端到端（10 项）

```
node _isolation/verify-vision-e2e.mjs     10 / 10
node _isolation/verify-vision-fix.mjs      3 / 3
```

覆盖了「provider 不声明模态」（你的实际场景）、混合链、全链只文本三种情况。

---

## 六、用真实配置验证过

从 `~/.dsh/profiles/desktop/cordis.patch.yml` 解析出 20 处 `input:` 声明，
**没有一处是只文本**。你链上的路由：

| 模型 | 声明 |
|---|---|
| `wb-proxy/deepseek-v4.1-flash` | `text + image` |
| `wb-proxy/glm-5.3-flash` | `text + image` |
| `trae2api-hub/DeepSeek-V4.1-Flash` | `text + image` |
| `trae2api-hub/GLM-5.3-Flash` | `text + image` |
| `trae2api-hub/GLM-5.3` | `text + image` |
| `trae2api-hub/Qwen3.8-Flash` | 未声明（未知） |
| `trae2api-hub/Qwen3.8-Max` | 未声明（未知） |
| `trae2api-hub/Kimi-K2.8-Preview` | 未声明（未知） |

**所以你的 provider 本来就支持图片**，之前不能用纯粹是插件用 `['text']` 覆盖了
真实声明。用这份真实数据跑完整链路（`_isolation/verify-real-chains-image.mjs`）：

- chain-1 现在声明 `["text","image"]`（修复前 `["text"]`）
- 图像请求不再被压平，能正常落到路由
- 全程不会打到「明确只文本」的路由

> `Qwen3.8-Flash` / `Qwen3.8-Max` 在配置里没有 `input:` 段，属于「未声明」。
> 宿主对未声明不干预，图片会照常发给它们——若实际看不见，由上游报错。
> 这是正确行为：插件不该替厂商猜。

---

## 七、需要重启

`src/adapter.js` 的后端改动由宿主在启动时加载，**需要重启 DSH**。

重启后自检：

1. 设置 → 模型 → 选 `模型轮换 / 日常主力`
2. 试着贴一张图
3. 应该不再出现「当前模型不支持图片输入」

> 如果你的 provider **确实**不支持图片，现在会由**上游**返回真实错误，
> 而不是被插件提前拦下。这是正确的：插件不该替厂商做这个决定。
