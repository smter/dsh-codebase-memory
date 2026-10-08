# dsh-codebase-memory

English | [中文](README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.1-4d6bfe)

**Brings the [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) code graph into DeepSeek Harness — and makes the model actually use it.**

The usual failure of a code-graph tool is not "it won't connect", it is "it connected and nobody uses it": the reminder sits at the top of the system prompt while the decision happens 50 steps later. This plugin puts the work at the decision point, including **building the index for the model**.

---

## Install

1. Install `codebase-memory-mcp` first (see its README), then check it:

   ```sh
   codebase-memory-mcp --version
   ```

2. Install this plugin from DSH's **Plugin Manager** (the official flow performs both
   package installation and bundle selection):

   ```
   github:smter/dsh-codebase-memory#<commit>
   ```

3. Restart `dsh web`. Its options then appear in **Settings**.

> If `codebase-memory-mcp` is not on `PATH`, point the `autoIndexCommand` setting and the
> MCP row's `command` at its absolute path.

## What you get

One bundle, three rows:

| Row | What it does |
|---|---|
| `codebase-memory-mcp` | connects the local stdio MCP server; tools appear as `mcp__codebase-memory-mcp__*` |
| `codebase-memory-reminder` | injects one system-prompt section, present on every model step |
| `codebase-memory-nudge` | acts at the decision point: corrects errors, nudges, **builds indexes** |

Three jobs, each backed by a measurement:

- **Correct failed MCP calls** — on an error, the next decision point gets one line saying how to
  fix that exact call. Measured: of 17 `search_graph` calls in one project, the 10 carrying a
  `semantic_query` key **all failed** (an empty `[]` counts), the 7 without it **all succeeded**.
  One subagent retried the same wrong shape 8 times and then abandoned the tool.
- **Nudge at the decision point** — attach a line to the result of a source grep, or a read of
  100+ lines. Measured: with only the system-prompt sentence, one session made 12 MCP calls (10 of
  them errors) and quickly gave up, and another made **zero** graph calls across 228 tool calls.
- **Build the index itself** — when the path being read belongs to an unindexed git repository, the
  plugin runs `codebase-memory-mcp cli index_repository` on its own, then hands the model the
  **exact project name** and a ready-to-paste call. Measured: a session asked to build an index
  indexed the wrong repository first, then the right one, resolved the project name, wrote
  "use the daily graph" — and queried it **zero** times. So the model no longer does this step.

## Requirements

- DSH `0.2.0-rc.1` (verified against this version)
- `codebase-memory-mcp` installed: the MCP row launches it through the official
  `StdioClientTransport`, and auto-indexing reuses the same executable in one-shot `cli` mode

## Settings

Both rows declare a `Config` schema, so DSH generates their forms on the **Settings** page. The
most useful ones:

| Setting | Default | Meaning |
|---|---|---|
| `autoIndex` | `true` | index an unindexed git repository automatically |
| `autoIndexMode` | `fast` | `fast` / `moderate` / `full` |
| `autoIndexMaxFiles` | `20000` | repositories above this file count are skipped |
| `autoIndexCommand` | `codebase-memory-mcp` | executable path (resolved from `PATH`) |
| `minLines` | `100` | a read at or above this line count counts as a long source read |
| `cooldown` | `6` | after the first nudge, remind every Nth qualifying call |
| `correctMCP` | `true` | correct failed MCP calls |

The full list is on the Settings page, or in `Config` inside `index.js` / `hook.js`.

## Development

```sh
pnpm install
pnpm test
```

55 cases, no network and no real index required:

- `test/triggers.test.mjs` — 30 cases: line threshold, source filter (positive and negative), nudge
  cadence, message shape
- `test/corrections.test.mjs` — 11 cases: correction rules driven by **real server error strings**
- `test/autoindex.test.mjs` — 14 cases: the whole indexing chain and every guard, via a **stub binary**

Set `CBM_DEBUG=1` to see why an automatic index was skipped.

## Known limitations

- **In PTC mode the Tool SDK renders most MCP parameters as `unknown`**, so the model can only guess
  parameter names from descriptions. This plugin works around it by spelling out the signatures in
  the system prompt; the root cause is the renderer and is worth fixing upstream.
- **A worktree is indexed as its own project** (`.git` is a file there). That is usually what you
  want, but the main checkout's index does not cover its worktrees or vice versa.
- `autoIndexMaxFiles` is a **bounded-walk estimate** (it does not read `.gitignore`), so it is a
  coarse guard rather than a precise limit.

## License

[MIT](LICENSE)
