# 变更说明 — dsh-model-rotation 0.2.6

> 本轮攻克了此前标注为"未通过"的设置卡片问题。**9 层验证全部通过，包括真实浏览器 UI。**

---

## 一、设置卡片终于显示出来了

### 1.1 三个叠加的根因

之前几轮一直以为只有一个问题，实际是**三个独立缺陷叠加**，修掉一个才会暴露下一个。

#### 缺陷 1：slot 名用错

最初注册到 `settings.plugins.tab`，但只传了 `key`，报错：

```
Error: list slot "settings.plugins.tab" requires options.id
```

改成 `id` 后，我误判这个 slot 是错的，改成了 `plugins.item`——**这是错的**。

读 `dsh-client-ui-settings-plugins` 源码才看清完整机制：

```js
ctx.slots.register({
  name: 'settings.section',
  id: 'plugins',
  children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } }
}, PluginsSettingsSection)
```

`settings.plugins.tab` 是 `PluginsSettingsSection` **声明的子 slot**，它通过
`ctx.slots.entries('settings.plugins.tab')` 构建 tab 列表。
`plugins.item` 是设置 shell 自己的卡片 slot，与插件页无关。

**最终正确写法**：

```js
ctx.slots.register({
  name: 'settings.plugins.tab',
  id: 'model-rotation',
  order: 50,
  label: () => t('meta.title'),
  locale: NS,
}, RotationCard)
```

#### 缺陷 2：缺少 Config schema

读 `dsh-settings.describe()` 源码：

```js
const schema = this.schema(entry)
if (schema === void 0 || entry.fiber === void 0 || ...) return []
```

**没有 Config schema 的条目直接跳过**，不产生 settings namespace。

修复：在 `index.js` 导出 `Config`。

#### 缺陷 3：schema 字段缺少 `volatile` 标记（最隐蔽）

加了 `Config` 后 namespace 仍然不出现。读 `volatileForm()` 才找到原因：

```js
function volatileForm(schema) {
  if (schema.meta.volatile) return plainSchema(schema)
  if (schema.type === 'object') {
    const dict = Object.fromEntries(...)   // 递归子字段，每个也必须 volatile
    return Object.keys(dict).length === 0 ? void 0 : z.object(dict)
  }
}
```

**每个字段都必须带 `volatile`**，否则 `volatileForm` 返回 `undefined`，
`describe()` 再次跳过。

修复：

```js
cooldownSeconds: Schema.number().default(15).extra('volatile', true)
```

### 1.2 还有一个前置问题：schemastery 解析不到

`Config` 最初用动态 `import('@deepseek-ai/schemastery')`，一直失败（`Schema=unresolved`）。

原因有两个：

1. **导出方式错了**：DSH 自己的包用 `import z from "@deepseek-ai/schemastery"`（**default** 导入），
   我用了具名 `{ Schema }`
2. **解析路径不对**：插件通过 junction 安装，自身目录没有 `node_modules`；
   而宿主包在 `app.asar` 里，普通 Node 读不了

修复：

- 改用 `createRequire(import.meta.url)` 从插件目录同步 require
- 在插件目录建 `node_modules/@deepseek-ai/schemastery` junction（指向已安装的副本）
- **必须是同步的**：loader 在调用 `apply()` **之前**读取 `Config`，异步赋值来不及

```js
const SCHEMA = resolveSchemaSync()
export const Config = SCHEMA === undefined ? undefined : buildConfig(SCHEMA)
```

---

## 二、浏览器验证结果

**15 / 15 全部通过**，截图见 `_isolation/settings-card.png`。

界面实际显示：

- 设置 → 内置插件 → **模型轮换** 标签
- 链名称输入框
- **模型顺序（按优先级）**：两个下拉联动（渠道 + 模型）
- 上移 / 下移 / 删除按钮
- **添加模型** / **新增链** / **重新加载** / **保存**
- 保存后显示「已保存」

| 断言 | 结果 |
|---|---|
| 页面提及模型轮换 | ✅ |
| 插件列表出现模型轮换 | ✅ |
| 卡片渲染出路由 provider | ✅ `Isolated Primary` |
| 卡片渲染出路由 model | ✅ `Isolated Model A` |
| 卡片渲染出保存按钮 | ✅ |
| 卡片渲染出新增链按钮 | ✅ |
| 卡片渲染出添加模型按钮 | ✅ |
| 找到链名称输入框 | ✅ |
| **保存写入磁盘** | ✅ 链名改为「浏览器改名」 |
| 无未捕获的页面错误 | ✅ |

---

## 三、验证链扩展到 9 层

```
单元测试          103 / 103
README 核对       全部通过
总结核对          全部通过
设置接口          17 / 17
隔离 E2E          63 / 63
真实 agent 流程   14 / 14
多轮续接           8 / 8
设置卡片 UI       15 / 15   ← 本轮新增
验收项覆盖        全部覆盖
```

`run-ui-test.mjs` 已纳入 `verify-all.mjs`，它自己管理 web 实例的启停：
先清端口（僵尸进程会让 `ready=true` 骗人），再启动，等到 token URL 出现，
跑测试，最后无论成败都停止实例。

---

## 四、踩到的环境坑（都写进了代码注释）

| 坑 | 现象 | 解法 |
|---|---|---|
| `dsh web` 需要 token | 不带 token 一律 401 | 从启动日志抓 `dsh web: <url>` |
| 设置入口位置 | 顶部"更多"只有插件项 | 用**左下角**那个"更多" |
| 端口僵尸进程 | `ready=true` 却连不上 | 先 netstat 找 pid，确认是 `iso-web` 再杀 |
| Playwright 版本不匹配 | 找不到 chromium-1255 | 显式指定已装的 `executablePath` |
| UI 测试污染设置文件 | 后续 E2E 全报 `UNKNOWN_MODEL` | `finally` 里恢复标准文档 |
| 中文路径 | PowerShell 写入乱码 | 一律用 Node 以 UTF-8 无 BOM 写 |

---

## 五、环境

- 生产 profile：本轮未改动
- `app.asar`：未改动
- 插件：**未安装到生产 profile**
- 隔离 web 实例：测试结束后自动停止
- 新增依赖：插件目录下 `node_modules/@deepseek-ai/schemastery`（junction，仅用于隔离验证）
