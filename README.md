# dsh-codebase-memory

[English](README_EN.md) | 中文

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.1-4d6bfe)

**把 [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) 的代码图接进 DeepSeek Harness —— 不只是接上，而是让模型真的用它。**

代码图工具最常见的失败不是「接不上」，而是「接上了没人用」：提示写在 system prompt 开头，而决策发生在第 50 步。本插件把该做的事放到决策点上，包括**替模型建索引**。

---

## 安装

1. 先装 `codebase-memory-mcp`（见其上游 README），确认可用：

   ```sh
   codebase-memory-mcp --version
   ```

2. 在 DSH 的**插件管理器**里安装本插件（官方流程会同时完成包安装与 bundle 选择）：

   ```
   github:smter/dsh-codebase-memory#<commit>
   ```

3. 重启 `dsh web`。之后 **Settings** 里会出现本插件两个行的选项。

> `codebase-memory-mcp` 不在 PATH 上时，改设置里的 `autoIndexCommand`，以及 MCP 行的 `command`。

## 它做什么

一个 bundle，三行：

| 行 | 作用 |
|---|---|
| `codebase-memory-mcp` | 连接本地 stdio MCP 服务，工具以 `mcp__codebase-memory-mcp__*` 暴露 |
| `codebase-memory-reminder` | 往 system prompt 注入一段提示，每个 model step 都在 |
| `codebase-memory-nudge` | 在工具管线里按需出手：纠正报错、决策点提醒、**自动建索引** |

`codebase-memory-nudge` 的三件事，每件都有实测依据：

- **纠正失败的 MCP 调用** —— 报错时在下一次决策点注入「这次该怎么改」。
  实测：某项目 17 次 `search_graph` 中，带 `semantic_query` 键的 10 次**全部失败**（空数组 `[]` 也算），不带的 7 次**全部成功**；一个子代理因此连续重试 8 次后彻底放弃该工具。
- **决策点提醒** —— 刚 grep 源码、或刚读满 100 行以上源码时，在那次结果后面附一句。
  实测：只放 system prompt 时，某会话 12 次 MCP 调用中 10 次失败并很快放弃，另一会话 228 次工具调用里 **0 次**使用代码图。
- **自动建索引** —— 发现正在读的路径属于未索引的 git 仓库时，插件自己跑 `codebase-memory-mcp cli index_repository`，然后把**准确的 project 名**和可直接粘贴的调用交给模型。
  实测：某会话被要求建索引后，先建错了仓库、再建对，正确解析出 project 名、写下「use the daily graph」，然后**一次都没查**。所以这一步不让模型做。

## 前置条件

- DSH `0.2.0-rc.1`（本插件在该版本上验证）
- `codebase-memory-mcp` 已安装：MCP 行通过官方 `StdioClientTransport` 启动它，自动索引复用同一个可执行文件的 `cli` 一次性模式

## 设置

两个行都声明了 `Config` schema，选项会在 **Settings** 页自动成表单。常用几项：

| 设置 | 默认 | 说明 |
|---|---|---|
| `autoIndex` | `true` | 自动为未索引的 git 仓库建索引 |
| `autoIndexMode` | `fast` | `fast` / `moderate` / `full` |
| `autoIndexMaxFiles` | `20000` | 超过此文件数的仓库不自动索引 |
| `autoIndexCommand` | `codebase-memory-mcp` | 可执行文件路径（走 PATH） |
| `minLines` | `100` | 读多少行以上算「读长源码」 |
| `cooldown` | `6` | 第 1 次提醒后每隔几次符合条件的调用再提醒 |
| `correctMCP` | `true` | 是否纠正失败的 MCP 调用 |

完整字段见 Settings 页，或 `index.js` / `hook.js` 里的 `Config`。

## 开发与测试

```sh
pnpm install
pnpm test
```

55 个用例，不需要网络或真实索引：

- `test/triggers.test.mjs` — 30 例：行数阈值、源码过滤器正反例、提醒节奏、消息形状
- `test/corrections.test.mjs` — 11 例：用**真实报错文本**驱动纠正规则
- `test/autoindex.test.mjs` — 14 例：用**桩可执行文件**驱动完整索引链路与全部 guard

设置 `CBM_DEBUG=1` 可看到自动索引被跳过的原因。

## 已知限制

- **PTC 模式下 Tool SDK 把多数 MCP 工具的参数渲染成 `unknown`**，模型只能靠描述猜参数名。本插件用 system prompt 写明调用签名来绕过；根因在渲染侧，值得上游修。
- **worktree 会被索引成独立 project**（worktree 里 `.git` 是文件）。这通常正是想要的，但主 checkout 的索引不会自动覆盖 worktree，反之亦然。
- `autoIndexMaxFiles` 是**有界遍历估算**（不读 `.gitignore`），只是粗粒度护栏。

## License

[MIT](LICENSE)
