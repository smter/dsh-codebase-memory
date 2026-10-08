/**
 * Codebase Memory MCP — trigger-point nudge.
 *
 * The package's default entry (`index.js`) puts one sentence into the system
 * prompt. Session evidence says that alone is not enough: in the 2026-10-05
 * weibo ticket-111 session the model reasoned "let me use the codebase memory
 * MCP if it's indexed ... let me check list_projects first", then dispatched
 * `git worktree add` and `grep -rn` instead, for zero MCP calls across 228
 * `run_code` dispatches. The sentence sat far from the moment of decision.
 *
 * So this bundle nudges AT the decision point. A `tools/post-execute` listener
 * sees the real inner dispatch — in PTC mode the run_code bridge gives every
 * sub-call its true tool name, arguments and result — and when the model has
 * just run a grep-style search or read a large slice of source, it attaches
 * one short `additionalContexts` notice to that very result. The loop appends
 * it right after the tool result, so it reaches the model immediately before
 * it decides what to do next.
 *
 * It also does the one job the model demonstrably will not do: when a grepped
 * path belongs to a git repository that has no index yet, it builds the index
 * itself out of band (one-shot `codebase-memory-mcp cli` child process), waits
 * for it, and hands the model the exact project name and a ready-to-paste call
 * through `agent.inject()`. Measured reason: a session indexed a repo and then
 * queried the graph zero times, even after resolving the project name and
 * writing "let me ... using the daily graph" — intent does not survive a step.
 *
 * Imports: `@deepseek-ai/schemastery` is declared as this package's own
 * dependency and installed into its own `node_modules`, because a workspace
 * bundle is symlinked into the profile and Node resolves the symlink's realpath,
 * so a bare import of a package that lives in the profile would not resolve.
 * Cordis only reads `Config['~standard'].validate` (Standard Schema) and
 * `dsh-settings` duck-types on `toJSON`, so a local copy of the same version
 * the runtime uses is safe. Node builtins resolve regardless.
 *
 * @module dsh-codebase-memory/hook
 */

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import z from '@deepseek-ai/schemastery';

/** Producer identity stamped on every notice; load-bearing, so it never reads as a user prompt. */
const SOURCE_KIND = 'codebase-memory-nudge';

/** `read` results at or above this many lines are the case the nudge is about. */
const DEFAULT_MIN_LINES = 100;

/** Fire on the 1st qualifying call, then on every Nth; keeps the notice rare. */
const DEFAULT_COOLDOWN = 6;

/** Prefix of the MCP tools whose failures get a corrective notice. */
const DEFAULT_MCP_PREFIX = 'mcp__codebase-memory-mcp__';

/** After the first corrective notice for an error signature, repeat only every Nth. */
const DEFAULT_ERROR_REPEAT = 3;


/** Must match `CONTEXT_SUMMARY_MAX_CHARS`; the summary is committed to the durable log. */
const SUMMARY_MAX_CHARS = 120;

/**
 * grep-family invocations inside a `bash` command. Anchored on a shell word
 * boundary so flags and paths do not match by accident.
 */
const GREP_COMMAND = /(?:^|[\s|&;(])(?:rg|grep|egrep|fgrep|ripgrep|ast-grep|ag|sg)(?=[\s|&;)<]|$)/;

/**
 * Precision filter, measured against a real session (2026-10-05/06 weibo
 * ticket-121, 72 qualifying calls). Without it 12 notices were delivered and
 * roughly two thirds landed while the model was parsing test output
 * (`grep -nE "FAILURES" /tmp/…`), reading `docs/`, or editing
 * `build.gradle.kts` — none of which the code graph answers. The model
 * correctly dismissed the first one in so many words, which is exactly how a
 * notice loses its credibility.
 *
 * A call qualifies only when its subject looks like repository source and not
 * like build output, logs, docs or vendored data. Replaying ticket-121 through
 * this filter drops delivered notices from 12 to 8, all of them source work.
 */
const DEFAULT_INCLUDE_SOURCE = String.raw`\.(kt|kts|java|ts|tsx|js|jsx|py|dart|go|rs|swift|rb|cs|php|c|cc|cpp|h)\b|(?:^|[\s'"=(/])(?:android|src|core|feature|app|lib)(?:/|(?=[\s'")]|$))`;
const DEFAULT_EXCLUDE_SOURCE = String.raw`/tmp/|/var/folders/|/sdcard/|\.log\b|test-results|/build/|\.gradle|docs/|\.md\b|\.txt\b|\.json\b|\.xml\b|/\.git/`;

/**
 * The injected notice. The model reads it a handful of times per session, at
 * the exact moment it is doing the thing being nudged away from, so parameter
 * names are spelled out: in PTC mode the Tool SDK renders most of these tools
 * as `unknown`, which is why an earlier session guessed `query` for
 * `search_code.pattern` and `qn` for `get_code_snippet.qualified_name`.
 *
 * Kept short on purpose. A longer version — with a paragraph about worktrees —
 * only gave the model more reasons to talk itself out of the detour; one
 * session reasoned "The codebase-memory nudge keeps appearing … Let me actually
 * use it … First list_projects. Actually simpler: grep -rn … Let me just do
 * that." Cost at the decision point is what decides, so the notice states the
 * call, gives one line of orientation, and gets out of the way.
 */
const DEFAULT_TEXT = [
  '【codebase-memory-mcp】{{trigger}}。定位符号 / 追调用链 / 看文件结构时，图查询比 grep 或整文件 read 更快也更省 context。',
  'project 取你刚才操作的那个路径所属的仓库，不是会话工作目录 —— 两者常常不是同一个（多项目、多 worktree 时尤其如此）；list_projects 里没有就先 index_repository({ repo_path: <该仓库根目录> })，已索引的不要重复建。',
  '  search_graph({ project, query }) 找符号 · get_file_outline({ project, file_path }) 文件大纲 · get_code_snippet({ project, qualified_name }) 读单个符号 · trace_path({ project, function_name }) 追调用链',
].join('\n');

/**
 * Read the row's config defensively. No `Config` schema is declared (that would
 * need `@deepseek-ai/schemastery`), so every field falls back to its default
 * instead of throwing during activation.
 *
 * @param config - raw row config from `cordis.patch.yml`.
 * @returns resolved `{ enabled, minLines, cooldown, text, includeSource, excludeSource }`.
 */
function resolveConfig(config) {
  const raw = config && typeof config === 'object' ? config : {};
  // The Loader already validated `config` against `Config` before activation;
  // running it through the same schema here keeps defaults single-sourced and
  // makes `apply()` usable directly (tests, or a caller that passes a partial
  // object). A schema that cannot validate falls back to the raw value rather
  // than throwing during activation.
  let validated = raw;
  try {
    const result = Config['~standard'].validate(raw);
    if (result && !result.issues && result.value !== undefined) validated = result.value;
  } catch {
    validated = raw;
  }
  const pattern = (value, fallback) => {
    if (typeof value !== 'string' || value.length === 0) return new RegExp(fallback);
    try {
      return new RegExp(value);
    } catch {
      return new RegExp(fallback);
    }
  };
  return {
    ...validated,
    includeSource: pattern(validated.includeSource, DEFAULT_INCLUDE_SOURCE),
    excludeSource: pattern(validated.excludeSource, DEFAULT_EXCLUDE_SOURCE),
  };
}

/**
 * Whether a trigger subject is repository source rather than logs, docs or
 * build output. An empty subject cannot be judged, so it is rejected: a nudge
 * that fires on nothing is worse than one that stays quiet.
 *
 * @param subject - the command, pattern or file path the call was about.
 * @param cfg - resolved row config.
 * @returns whether this subject is worth nudging about.
 */
function isSourceWork(subject, cfg) {
  if (typeof subject !== 'string' || subject.length === 0) return false;
  if (cfg.excludeSource.test(subject)) return false;
  return cfg.includeSource.test(subject);
}

/** Concatenate the text blocks of one tool result. */
function textOf(result) {
  if (!result || !Array.isArray(result.content)) return '';
  let out = '';
  for (const block of result.content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      out += block.text;
    }
  }
  return out;
}

/** Count lines without splitting (large results stay cheap). */
function countLines(text) {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

/** Final path segment, for a readable trigger description. */
function baseName(value) {
  const path = String(value ?? '');
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/** Collapse whitespace and ellipsize, for quoting a command or pattern. */
function head(value, max) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** Bound a `notice` summary the way the harness does. */
function boundSummary(value) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= SUMMARY_MAX_CHARS ? flat : `${flat.slice(0, SUMMARY_MAX_CHARS - 1)}…`;
}

/** A fresh message identity. */
function newId() {
  const webcrypto = globalThis.crypto;
  if (webcrypto && typeof webcrypto.randomUUID === 'function') return webcrypto.randomUUID();
  return `nudge-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

/**
 * Build one frozen producer-sourced user message, mirroring what
 * `createUserMessage` would return.
 *
 * @param text - model-facing notice text.
 * @param summary - one-line durable account shown without expanding the row.
 * @returns a frozen `UserMessage`.
 */
function notice(text, summary) {
  return Object.freeze({
    id: newId(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: SOURCE_KIND, form: 'notice', summary: boundSummary(summary) }),
  });
}

/**
 * Decide whether one settled execution is the case this bundle nudges about.
 *
 * @param exec - the execution that traversed the pipeline.
 * @param result - its settled result.
 * @param cfg - resolved row config.
 * @returns `{ trigger, summary }`, or `undefined` when this call is not a hit.
 */
function detect(exec, result, cfg) {
  const args = exec && typeof exec.arguments === 'object' && exec.arguments !== null ? exec.arguments : {};

  if (exec.name === 'read') {
    if (result && result.isError === true) return undefined;
    if (!isSourceWork(String(args.file_path ?? ''), cfg)) return undefined;
    const requested = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : 0;
    // Measure the delivered text, but honour an explicit window when the result
    // shape cannot be measured — that keeps the trigger working either way.
    const lines = Math.max(countLines(textOf(result)), requested);
    if (lines < cfg.minLines) return undefined;
    const file = baseName(args.file_path);
    return {
      trigger: `刚才读取了 ${file} 的 ${lines} 行源码（阈值 ${cfg.minLines} 行）`,
      summary: `read ${file} (${lines} lines)`,
    };
  }

  if (exec.name === 'grep') {
    const pattern = String(args.pattern ?? '');
    // No explicit scope means the workspace itself, which is source work; an
    // explicit scope must survive the filter.
    const scope = `${String(args.path ?? '')} ${String(args.include ?? '')}`.trim();
    if (scope.length > 0 && !isSourceWork(scope, cfg)) return undefined;
    return {
      trigger: `刚才用 grep 检索了 ${JSON.stringify(pattern)}`,
      summary: `grep ${head(pattern, 60)}`,
    };
  }

  if (exec.name === 'bash') {
    const command = String(args.command ?? '');
    if (!GREP_COMMAND.test(command)) return undefined;
    if (!isSourceWork(command, cfg)) return undefined;
    return {
      trigger: `刚才在 bash 里做了一次 grep 类检索（${head(command, 70)}）`,
      summary: `bash grep: ${head(command, 60)}`,
    };
  }

  return undefined;
}

/** Plugin name used by Loader diagnostics. */
export const name = 'codebase-memory-nudge';

/**
 * Corrective rules for a FAILED codebase-memory MCP call.
 *
 * Measured motivation (2026-10-05..07, weibo project, 17 `search_graph`
 * calls): success correlated perfectly with the ABSENCE of the
 * `semantic_query` key — 7/7 succeeded without it, 0/10 with it, including
 * `semantic_query: []`. The server tests key presence, not emptiness, while
 * models routinely emit every schema field with a zero value. Because the
 * server's message ("... or semantic_query for vector ranking, then issue a
 * separate request for the other mode") never says "drop the key", one
 * subagent retried the same shape 8 times in 76 seconds and then abandoned
 * `search_graph` entirely, while the main session gave up on MCP after 2.
 *
 * A nudge that fires *at the failure* is what breaks that loop. Each rule is
 * `{ match: <substring of the error text>, text: <what to do instead> }`.
 */
const DEFAULT_CORRECTIONS = [
  {
    match: 'mutually exclusive',
    text: 'search_graph 报这个错是因为你把 semantic_query 和 query 一起传了 —— 空数组 [] 也算传了。重试时把 semantic_query 这个键整个删掉（不是改成空的或别的值，是不要这个键），只留 { project, query }，其余可选参数一律省略。',
  },
  {
    match: 'invalid_cursor',
    text: 'cursor 是一次性的快照续传令牌，不能复用也不能改。去掉 cursor，用原来的查询参数重新跑一次，再拿新的 next_cursor 往下翻。',
  },
];

/**
 * Dynamic rule: `Error: <name> is required`. The server names the parameter it
 * wants, so the correction can quote it — this is how the earlier
 * `pattern`/`qualified_name` failures were eventually learned.
 */
const REQUIRED_PARAMETER = /Error:\s*([A-Za-z_][A-Za-z0-9_]*)\s+is\s+required/;

/** The `codebase-memory-mcp` executable, spawned in one-shot `cli` mode for auto-indexing.
 * Resolved from `PATH`; override the setting when it lives elsewhere. */
const DEFAULT_AUTO_INDEX_COMMAND = 'codebase-memory-mcp';

/**
 * Indexing mode for an automatic first pass. `fast` is filtered-only and takes
 * seconds; `moderate`/`full` additionally build semantic data. A later manual
 * `index_repository` with a richer mode adds what this one omitted.
 */
const DEFAULT_AUTO_INDEX_MODE = 'fast';

/**
 * Skip a repository whose file count exceeds this, so a stray grep in a home
 * directory or a vendored tree cannot trigger a multi-gigabyte index. The walk
 * is bounded and stops counting as soon as the cap is passed.
 */
const DEFAULT_AUTO_INDEX_MAX_FILES = 20000;

/** Kill an auto-index child that runs longer than this. */
const DEFAULT_AUTO_INDEX_TIMEOUT_MS = 180000;

/** Directories never descended into while counting files for the size guard. */
const SIZE_GUARD_IGNORE = new Set([
  '.git', 'node_modules', 'build', 'dist', 'out', 'target', 'vendor',
  '.gradle', '.kotlin', '.cxx', '.idea', '.venv', 'venv', '__pycache__',
  'DerivedData', 'Pods', '.next', '.cache',
]);

/**
 * This plugin's settings. DSH projects this schema into the Settings page
 * (`dsh-settings` reads `toJSON()` and rebuilds the form) and `cordis.patch.yml`
 * `config` is validated against it, so every field is optional and carries its
 * default — an empty config is exactly the shipped behaviour.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).description('总开关：关闭后本插件的全部行为停止。'),

  // --- trigger-point nudge ---
  minLines: z.natural().default(DEFAULT_MIN_LINES).description('read 结果达到这个行数才算「读长源码」，才会被提醒。'),
  cooldown: z.natural().default(DEFAULT_COOLDOWN).description('第 1 次触发后，每隔多少次符合条件的调用再提醒一次。'),
  text: z.string().default(DEFAULT_TEXT).description('提醒正文；其中的 {{trigger}} 会替换成实际观察到的动作。'),
  includeSource: z.string().default(DEFAULT_INCLUDE_SOURCE).description('「这算源码」的判定正则，命中才算数。'),
  excludeSource: z.string().default(DEFAULT_EXCLUDE_SOURCE).description('排除正则：日志、docs、构建产物等一律不提醒。'),

  // --- corrective notices for failed MCP calls ---
  correctMCP: z.boolean().default(true).description('MCP 调用失败时，注入一句「这次该怎么改」。'),
  mcpPrefix: z.string().default(DEFAULT_MCP_PREFIX).description('只对此外加前缀的工具做纠错。'),
  errorRepeat: z.natural().default(DEFAULT_ERROR_REPEAT).description('同一错误签名第 1 次必发，之后每 N 次再发。'),
  fallbackText: z.string().default('').description('未识别错误的兜底纠正文案；留空则不纠正。'),
  corrections: z
    .array(z.object({ match: z.string(), text: z.string() }))
    .default(DEFAULT_CORRECTIONS)
    .description('纠正规则表：match 是错误文本的子串，text 是注入的纠正。'),

  // --- proactive indexing ---
  autoIndex: z.boolean().default(true).description('发现未被索引的 git 仓库时，自动为它建索引（后台一次性进程）。'),
  autoIndexCommand: z.string().default(DEFAULT_AUTO_INDEX_COMMAND).description('codebase-memory-mcp 可执行文件路径；以 `cli` 一次性模式调用。'),
  autoIndexMode: z
    .union([z.const('fast'), z.const('moderate'), z.const('full')])
    .default(DEFAULT_AUTO_INDEX_MODE)
    .description('自动索引模式：fast 最快（仅过滤），moderate/full 另建语义数据。'),
  autoIndexMaxFiles: z.natural().default(DEFAULT_AUTO_INDEX_MAX_FILES).description('文件数超过此值的仓库不自动索引。'),
  autoIndexTimeoutMs: z.natural().default(DEFAULT_AUTO_INDEX_TIMEOUT_MS).description('自动索引子进程的超时（毫秒）。'),
});

/** Cap on tracked error signatures per agent, so a long session cannot grow unbounded. */
const MAX_ERROR_SIGNATURES = 64;

/**
 * Pick the correction for one failed MCP call.
 *
 * @param text - the failure text the model was shown.
 * @param cfg - resolved row config.
 * @returns the correction body, or `undefined` when no rule applies.
 */
function correctionFor(text, cfg) {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  const required = REQUIRED_PARAMETER.exec(text);
  if (required !== null) {
    return `这次报错说明缺少必填参数 ${required[1]}：带上 ${required[1]} 再试一次（名字要完全一致），其余可选参数一律不要传。`;
  }
  for (const rule of cfg.corrections) {
    if (text.includes(rule.match)) return rule.text;
  }
  return cfg.fallbackText.length > 0 ? cfg.fallbackText : undefined;
}

/**
 * Fire on the first occurrence of an error signature, then only every
 * `errorRepeat`th, so a model stuck in a retry loop still gets corrected
 * without one notice per attempt.
 *
 * @param store - per-agent signature counters.
 * @param agent - the agent the call ran for.
 * @param signature - tool name plus a short digest of the failure text.
 * @param cfg - resolved row config.
 * @returns whether to emit a corrective notice now.
 */
function shouldCorrect(store, agent, signature, cfg) {
  let counters = store.get(agent);
  if (counters === undefined) {
    counters = new Map();
    store.set(agent, counters);
  }
  const count = (counters.get(signature) ?? 0) + 1;
  if (counters.size >= MAX_ERROR_SIGNATURES && !counters.has(signature)) counters.clear();
  counters.set(signature, count);
  return count === 1 || count % cfg.errorRepeat === 0;
}

/** Prepend one notice to whatever downstream decided. */
function withNotice(downstream, injected) {
  return {
    ...downstream,
    additionalContexts: [injected, ...(downstream.additionalContexts ?? [])],
  };
}

// ---------------------------------------------------------------------------
// Proactive indexing
//
// Measured reason this exists: in the 2026-10-08 weibo session the model was
// told (by the human) to build an index, indexed the wrong repository first,
// then indexed the right one, resolved its project name, wrote "let me ...
// using the daily graph" — and made zero graph queries in that project
// afterwards. Leaving indexing or project selection to a later step does not
// work, so the plugin does both here and hands over a ready-to-paste call.
// ---------------------------------------------------------------------------

/** Bash commands carry paths inside a string; take the first absolute-looking token. */
const ABSOLUTE_PATH = /(?:^|[\s'"=(])(\/[^\s'"()]+)/;

/** Normalize one execution's arguments. */
function argsOf(exec) {
  return exec && typeof exec.arguments === 'object' && exec.arguments !== null ? exec.arguments : {};
}

/**
 * The filesystem path a call was actually about — the grepped directory or file,
 * never the session's working directory. A session whose cwd is one repository
 * routinely greps another, and keying the project off the cwd is precisely the
 * mistake this avoids.
 *
 * @param exec - the execution that traversed the pipeline.
 * @param args - its normalized arguments.
 * @returns the observed path, or `undefined` when the call carries none.
 */
function observedPath(exec, args) {
  if (exec.name === 'read') return typeof args.file_path === 'string' ? args.file_path : undefined;
  if (exec.name === 'grep') {
    return typeof args.path === 'string' && args.path.length > 0 ? args.path : undefined;
  }
  if (exec.name === 'bash') {
    const match = ABSOLUTE_PATH.exec(String(args.command ?? ''));
    return match === null ? undefined : match[1];
  }
  return undefined;
}

/** Resolve a path to an existing directory, or `undefined` when it is gone. */
function resolveDirectory(target) {
  try {
    const real = realpathSync(target);
    return statSync(real).isDirectory() ? real : dirname(real);
  } catch {
    return undefined;
  }
}

/**
 * The nearest ancestor that looks like a git working tree. `.git` is a
 * directory in a checkout and a plain file in a worktree, so existence is the
 * test — a worktree is indexed as its own project, which is what the model is
 * actually reading.
 *
 * @param start - an existing directory.
 * @returns the repository root, or `undefined` above the filesystem root.
 */
function gitRootOf(start) {
  let current = start;
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Count files up to `limit`, skipping heavy directories, so a huge tree is never indexed. */
function countFilesWithin(root, limit) {
  let count = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SIZE_GUARD_IGNORE.has(entry.name)) continue;
      if (entry.isDirectory()) stack.push(join(dir, entry.name));
      else if (entry.isFile()) {
        count += 1;
        if (count > limit) return count;
      }
    }
  }
  return count;
}

/**
 * Run the MCP binary once (`cli` mode exits after one tool) and return stdout.
 *
 * @param command - the executable path.
 * @param args - argument vector; never shell-interpreted.
 * @param timeoutMs - hard kill deadline.
 * @returns stdout, or `undefined` on spawn failure, non-zero exit or timeout.
 */
function runCli(command, args, timeoutMs) {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
        resolve(error ? undefined : String(stdout ?? ''));
      });
    } catch {
      resolve(undefined);
    }
  });
}

/** Concatenate the text blocks of one `cli --json` result envelope. */
function cliText(stdout) {
  try {
    const envelope = JSON.parse(stdout);
    if (Array.isArray(envelope?.content)) {
      return envelope.content
        .filter((block) => block?.type === 'text')
        .map((block) => block.text ?? '')
        .join('');
    }
  } catch {
    /* not an envelope: fall through to the raw text */
  }
  return String(stdout ?? '');
}

/**
 * Parse a `list_projects` table into `<root path> -> <project name>`. The
 * server reports resolved paths (`/private/tmp/...` on macOS), which is why
 * callers realpath their own paths before comparing.
 *
 * @param text - the rendered table.
 * @returns the parsed mapping.
 */
function parseProjects(text) {
  const found = new Map();
  for (const line of String(text).split('\n')) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length >= 2 && tokens[1].startsWith('/')) found.set(tokens[1], tokens[0]);
  }
  return found;
}

/**
 * Read `{ project, nodes }` out of one `index_repository` result. The CLI has
 * printed bare JSON here, but a future text rendering must not turn a silent
 * parse error into a silently skipped index — hence the tolerant fallback.
 *
 * @param text - the concatenated result text.
 * @returns the fields found, or `undefined` when no project name is present.
 */
function parseIndexResult(text) {
  const raw = String(text ?? '');
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.project === 'string') {
      return { project: parsed.project, nodes: parsed.nodes };
    }
  } catch {
    /* not JSON: fall through to the tolerant scan */
  }
  const project = /"project"\s*:\s*"([^"]+)"/.exec(raw);
  if (project === null) return undefined;
  const nodes = /"nodes"\s*:\s*(\d+)/.exec(raw);
  return { project: project[1], nodes: nodes === null ? undefined : Number(nodes[1]) };
}

/** Per-agent auto-index state, so one session never repeats work. */
function autoIndexState(store, agent) {
  let state = store.get(agent);
  if (state === undefined) {
    state = { projects: new Map(), listed: false, inflight: new Set(), attempted: new Set() };
    store.set(agent, state);
  }
  return state;
}

/** The message handed back once an index exists. */
function indexReadyNotice(root, project, nodes) {
  const size = Number.isFinite(nodes) ? `，${nodes} 节点` : '';
  return notice(
    [
      `【codebase-memory-mcp】已为 ${root} 建好索引（project = "${project}"${size}）。现在可以直接查图，例如：`,
      `  search_graph({ project: "${project}", query: "<要找的符号>" }) · get_file_outline({ project: "${project}", file_path: "<仓库内相对路径>" })`,
    ].join('\n'),
    `indexed ${project}`,
  );
}

/**
 * Ensure the repository behind one observed path has an index, then tell the
 * model its project name. Runs entirely beside the tool pipeline: the child
 * process is spawned and awaited asynchronously, so no tool result is ever
 * delayed by indexing, and the outcome arrives through `agent.inject()`.
 *
 * @param agent - the agent the call ran for.
 * @param exec - the execution that traversed the pipeline.
 * @param cfg - resolved row config.
 * @param store - per-agent state store.
 */
function scheduleAutoIndex(agent, exec, cfg, store) {
  const observed = observedPath(exec, argsOf(exec));
  if (observed === undefined) return;
  const directory = resolveDirectory(observed);
  if (directory === undefined) return;
  const root = gitRootOf(directory);
  if (root === undefined) return;

  const state = autoIndexState(store, agent);
  if (state.projects.has(root) || state.inflight.has(root) || state.attempted.has(root)) return;
  state.inflight.add(root);

  void (async () => {
    try {
      // Ask once per agent which repositories exist, rather than per path.
      if (!state.listed) {
        const listed = await runCli(cfg.autoIndexCommand, ['cli', '--quiet', '--json', 'list_projects'], cfg.autoIndexTimeoutMs);
        if (listed !== undefined) {
          for (const [path, project] of parseProjects(cliText(listed))) state.projects.set(path, project);
          state.listed = true;
        }
      }
      if (state.projects.has(root)) return;

      state.attempted.add(root);
      if (countFilesWithin(root, cfg.autoIndexMaxFiles) > cfg.autoIndexMaxFiles) return;

      const stdout = await runCli(
        cfg.autoIndexCommand,
        ['cli', '--quiet', '--json', 'index_repository', JSON.stringify({ repo_path: root, mode: cfg.autoIndexMode })],
        cfg.autoIndexTimeoutMs,
      );
      if (stdout === undefined) return;
      const parsed = parseIndexResult(cliText(stdout));
      if (parsed === undefined) return;

      state.projects.set(root, parsed.project);
      agent.inject(indexReadyNotice(root, parsed.project, parsed.nodes));
    } catch (error) {
      /* Best-effort: the nudge and corrective paths keep working without it.
         Set CBM_DEBUG=1 to see why an automatic index was not built. */
      if (process.env.CBM_DEBUG) console.error('[codebase-memory-nudge] auto-index failed:', error);
    } finally {
      state.inflight.delete(root);
    }
  })();
}

/**
 * Attach corrective notices to failed MCP calls, and the nudge to qualifying
 * results.
 *
 * @param ctx - the plugin's Cordis context.
 * @param config - raw row config from `cordis.patch.yml`.
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  if (!cfg.enabled) return;

  /** Qualifying calls seen per agent; a WeakMap so disposed agents are collected. */
  const seen = new WeakMap();
  /** Failure signatures seen per agent. */
  const errorSeen = new WeakMap();
  /** Auto-index state per agent. */
  const autoSeen = new WeakMap();

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next();
    const { agent } = exec;
    if (agent === undefined) return downstream;

    // 1. A failed MCP call: tell the model how to fix that exact call.
    if (cfg.correctMCP && result !== undefined && result.isError === true && String(exec.name).startsWith(cfg.mcpPrefix)) {
      const text = textOf(result);
      const correction = correctionFor(text, cfg);
      if (correction !== undefined) {
        const signature = `${exec.name}|${head(text, 80)}`;
        if (shouldCorrect(errorSeen, agent, signature, cfg)) {
          return withNotice(downstream, notice(correction, `fix ${String(exec.name).slice(cfg.mcpPrefix.length)}`));
        }
        return downstream;
      }
    }

    // 2. A qualifying grep / large read on repository source: make sure the
    //    repository behind that very path has an index, and point at the graph.
    const hit = detect(exec, result, cfg);
    if (hit === undefined) return downstream;

    // Fire-and-forget on purpose: indexing must never delay a tool result.
    if (cfg.autoIndex) scheduleAutoIndex(agent, exec, cfg, autoSeen);

    const count = (seen.get(agent) ?? 0) + 1;
    seen.set(agent, count);
    // Fire on the 1st qualifying call and then every `cooldown`th one, so a long
    // session gets a handful of notices rather than one per grep.
    if ((count - 1) % cfg.cooldown !== 0) return downstream;

    return withNotice(downstream, notice(cfg.text.replaceAll('{{trigger}}', hit.trigger), hit.summary));
  });
}
