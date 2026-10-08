/**
 * Codebase Memory MCP — per-step prompt nudge.
 *
 * Registers one system-prompt section. `SystemPrompt.assemble()` runs before
 * every model step, so the nudge is present in front of every reply, exactly
 * once, and costs no session-log entries.
 *
 * This module intentionally imports nothing: a workspace bundle is installed
 * into the profile as a symlink to its source directory, so bare
 * `@deepseek-ai/*` imports would not resolve (empirically confirmed). Node
 * builtins and the injected `ctx` are all this plugin needs.
 *
 * Imports: `@deepseek-ai/schemastery` is this package's own dependency, installed
 * into its own `node_modules`. A workspace bundle is symlinked into the profile
 * and Node resolves the symlink's realpath, so a bare import of a package that
 * lives in the profile would not resolve. Cordis only reads
 * `Config['~standard'].validate` (Standard Schema) and `dsh-settings`
 * duck-types on `toJSON`, so a local copy of the runtime's own version is safe.
 *
 * This is the package's default entry point (`.`), the system-prompt half.
 *
 * @module dsh-codebase-memory
 */

import z from '@deepseek-ai/schemastery';

/**
 * One nudge, not a chapter: the model reads this on every single step.
 * Override it from the row's `config.reminder` in `cordis.patch.yml`.
 *
 * The call signatures are spelled out on purpose. In PTC mode the Tool SDK
 * declaration renders most MCP tools as `unknown`, so their parameter names
 * never reach the model; without them the model guesses (observed: `query`
 * for `search_code.pattern`, `qn` for `get_code_snippet.qualified_name`) and
 * then abandons the tools. Session evidence: 2026-10-05 weibo ticket-122.
 */
const DEFAULT_REMINDER = [
  '用 grep 搜索源码之前，或用 read 读取超过 100 行的源码之前，先想想要不要改用 codebase-memory-mcp 的代码图。',
  '在某个仓库做多点 grep/read 调查之前，先确认它已索引：list_projects 里没有就 index_repository({ repo_path: <该仓库根目录> })；已索引的不要重复建（一个仓库索引一次就够）。',
  '  search_graph({ project, query }) 找符号 · get_file_outline({ project, file_path }) 文件大纲 · get_code_snippet({ project, qualified_name }) 读单个符号 · search_code({ project, pattern }) 文本检索 · trace_path({ project, function_name }) 追调用链 · get_architecture({ project }) 看架构',
  'project 取你正在 grep/read 的那个路径所属的仓库，不是会话工作目录 —— 两者常常不是同一个（多项目、多 worktree 时尤其如此）。',
  '参数名照上面写，不要猜（是 pattern 不是 query，是 qualified_name 不是 qn）；报错时按报错点名的参数改一次重试。已经知道具体文件与行号时，继续用 grep/read 更快。',
  '只传上面列出的参数，其余可选参数一律省略，别用空值补齐：search_graph 多带一个 semantic_query（即使是空数组 []）就会与 query 互斥而直接报错。',
].join('\n');

/** Section name; a scoped registration shadows a same-named global one. */
const DEFAULT_SECTION_NAME = 'plugin:codebase-memory-mcp';

/**
 * Sort order. DSH allocates 1100 `tool:read`, 1300 `tool:edit`, 1400
 * `tool:glob`, 1500 `tool:grep`; sitting just before `tool:grep` keeps the
 * nudge adjacent to the tools it is about.
 */
const DEFAULT_ORDER = 1450;

/**
 * This plugin's settings. DSH projects this schema into the Settings page
 * (`dsh-settings` reads `toJSON()` and rebuilds the form) and validates
 * `cordis.patch.yml` `config` against it, so every field is optional and
 * carries its default — an empty config is exactly the shipped behaviour.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).description('总开关：关闭后不再注入这段提示。'),
  reminder: z.string().default(DEFAULT_REMINDER).description('注入到 system prompt 的正文（每个 model step 都会带上）。'),
  order: z.number().default(DEFAULT_ORDER).description('在 system prompt 里的排序位置；tool:read 1100 … tool:grep 1500。'),
  sectionName: z.string().default(DEFAULT_SECTION_NAME).description('这段内容在 prompt registry 里的名字，用于被其他预设覆盖。'),
});

/**
 * Resolve the row's config. The Loader already validated it against {@link Config}
 * before activation; running it through the same schema here keeps defaults
 * single-sourced and lets `apply()` be called directly with a partial object.
 *
 * @param config - raw row config from `cordis.patch.yml`.
 * @returns resolved `{ enabled, reminder, order, sectionName }`.
 */
function resolveConfig(config) {
  const raw = config && typeof config === 'object' ? config : {};
  let validated = raw;
  try {
    const result = Config['~standard'].validate(raw);
    if (result && !result.issues && result.value !== undefined) validated = result.value;
  } catch {
    validated = raw;
  }
  return {
    enabled: validated.enabled !== false,
    reminder: typeof validated.reminder === 'string' && validated.reminder.trim().length > 0
      ? validated.reminder
      : DEFAULT_REMINDER,
    order: typeof validated.order === 'number' && Number.isFinite(validated.order)
      ? validated.order
      : DEFAULT_ORDER,
    sectionName: typeof validated.sectionName === 'string' && validated.sectionName.trim().length > 0
      ? validated.sectionName
      : DEFAULT_SECTION_NAME,
  };
}

/** Plugin name used by Loader diagnostics. */
export const name = 'codebase-memory-reminder';

/** Stay inactive until the prompt registry exists. */
export const inject = ['systemPrompt'];

/**
 * Register the nudge as a prompt section owned by this plugin's context, so
 * disabling or unloading the row removes it again.
 *
 * @param ctx - the plugin's Cordis context, with `systemPrompt` injected.
 * @param config - raw row config from `cordis.patch.yml`.
 */
export function apply(ctx, config) {
  const { enabled, reminder, order, sectionName } = resolveConfig(config);
  if (!enabled) return;
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: sectionName,
        order,
        text: reminder,
        // Keep `{{...}}` sequences literal: this is prose, not a template.
        interpolate: false,
      }),
    'codebase-memory-reminder.section()',
  );
}
