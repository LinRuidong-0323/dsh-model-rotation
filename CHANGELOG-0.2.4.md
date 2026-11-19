# 变更说明 — dsh-model-rotation 0.2.4

> 本轮攻克了前几轮标注为"无法验证"的图像能力筛选，把它变成了真实链路证据。

---

## 一、图像能力筛选的端到端验证

### 1.1 此前的障碍

DSH 在派发前解析 `attachment.attachmentId` 并对存储对象做完整性校验。
伪造的摘要会报 `Cannot read properties of undefined (reading 'attachmentId')`
（早期）或 `ATTACHMENT_CORRUPT`（写入对象后）。

前几轮因此把图像分支标注为"只能离线测试"。

### 1.2 解决办法

读 `dsh-attachment-local` 源码后发现：**附件是内容寻址的**。

```
对象路径: $DSH_HOME/attachments/v1/objects/<sha256前2位>/<sha256>
ID 格式:  /^sha256:([a-f0-9]{64})$/
```

所以只要生成一张真实图片、算出 sha256、写入该地址，引用就是合法的。

`_isolation/make-attachment.mjs` 做了这件事：
- 手工构造一张 74 字节、8×8 的合法 PNG（含 IHDR/IDAT/IEND 和正确的 CRC32）
- 算出 sha256 = `1bd58deb...06baaf`
- 写入 `objects/1b/1bd58deb...06baaf`

### 1.3 踩到的第二个坑

写入对象后仍报 `ATTACHMENT_CORRUPT`。读源码发现校验是：

```js
if (metadata.mediaType !== ref.mediaType || data.byteLength !== ref.bytes ||
    metadata.width !== ref.width || metadata.height !== ref.height)
  throw new AttachmentError("Stored attachment metadata does not match its reference.", "ATTACHMENT_CORRUPT")
```

**字段名是 `mediaType`，不是 `mimeType`**。我最初写的是 `mimeType`，
导致 `ref.mediaType` 是 `undefined`，与实际的 `image/png` 不符。

### 1.4 结果

E2E 场景 11b：

| 断言 | 证据 |
|---|---|
| 结果 PASS | `PASS chain produced an answer` |
| 文本 primary 被跳过 | `primary=0` |
| 文本 backup 被跳过 | `backup=0` |
| 视觉路由被使用 | `vision=1` |
| 视觉路由收到图像块 | `messageCount=3` |

链上是 `iso-primary`（纯文本）→ `iso-backup`（纯文本）→ `iso-vision`（声明支持图像）。
**图像请求正确跳过了前两个，只打到 vision。**

---

## 二、测试数量

| 层 | 0.2.3 | 0.2.4 |
|---|---|---|
| 单元测试 | 89 | 89 |
| 隔离 E2E | 53 | **58** |
| 真实 agent | 14 | 14 |
| 多轮续接 | 8 | 8 |
| 设置接口 | 17 | 17 |

E2E 新增 5 项断言（场景 11b）。

---

## 三、验证状态

```
单元测试          89 / 89
隔离 E2E          58 / 58
真实 agent 流程   14 / 14
多轮续接           8 / 8
设置接口          17 / 17
README 核对       全部通过
总结核对          全部通过
验收项覆盖        全部覆盖
```

---

## 四、剩余未完成项（从 3 项减至 2 项）

| 项 | 状态 |
|---|---|
| ~~图像能力筛选~~ | **已完成**（本轮） |
| 设置卡片浏览器渲染 | 未完成——需要重启生产 DSH 在 GUI 中操作 |
| 冷却机制 | 未实现——保持精简的设计选择 |

**设置卡片**是唯一还需要真实环境才能验证的项。它已有：
- 纯函数 7 项单测（深拷贝、排序、id 生成）
- HTTP 接口 17 项测试（读写、校验、来源拦截）
- `apply()` 正确注册到 `settings.plugins.tab`（lifecycle 测试）

缺的是"在浏览器里点一下"。这需要用户授权后装到生产环境才能做。

---

## 五、环境

- 生产 profile：本轮未改动
- `app.asar`：修改时间 `11-13 15:30`，未改动
- 插件：**未安装到生产 profile**
- 隔离环境新增：`attachments/v1/objects/1b/1bd58deb...`（74 字节 PNG）
