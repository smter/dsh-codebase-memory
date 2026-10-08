/**
 * Corrective-notice tests, built from the real failure strings observed in the
 * weibo project (2026-10-05..07). Run: `node test/corrections.test.mjs`
 *
 * The fixtures are verbatim server output, so a change to the matching rules is
 * checked against what the tool actually returned rather than a paraphrase.
 */
import { apply } from '../hook.js';

/** Real failing outputs, exactly as the model was shown them. */
const REAL_FAILURES = [
  {
    name: 'mcp__codebase-memory-mcp__search_graph',
    text: 'Error: query and semantic_query are mutually exclusive — use query for BM25 full-text ranking or semantic_query for vector ranking, then issue a separate request for the other mode.',
    want: /semantic_query 这个键整个删掉/,
    repeats: 10,
  },
  {
    name: 'mcp__codebase-memory-mcp__search_code',
    text: 'Error: pattern is required',
    want: /缺少必填参数 pattern/,
    repeats: 1,
  },
  {
    name: 'mcp__codebase-memory-mcp__get_code_snippet',
    text: 'Error: qualified_name is required',
    want: /缺少必填参数 qualified_name/,
    repeats: 1,
  },
  {
    name: 'mcp__codebase-memory-mcp__query_graph',
    text: "Error: invalid_cursor: unrecognized or modified token — re-run the original query without 'cursor'",
    want: /cursor 是一次性的/,
    repeats: 1,
  },
];

/** Real successful outputs; none of these may produce a corrective notice. */
const REAL_SUCCESSES = [
  'projects: 1  (cols: name root_path)\n  Users-smterc-Project-weibo /Users/smterc/Project/weibo\n',
  'results: 30  (cols: qn label file lines rank)\n  Users-smterc-Project-weibo.android…\n',
  'name: ConversationRow | qualified_name: … | label: Function | file_path: …',
];

function harness(config = {}) {
  let listener = null;
  apply({ on(_ev, fn) { listener = fn; } }, config);
  return (exec, result) => listener(exec, result, async () => ({ kind: 'accept' }));
}
const ok = (text) => ({ isError: false, content: [{ type: 'text', text }] });
const boom = (text) => ({ isError: true, content: [{ type: 'text', text }] });

const rows = [];
let fireCount;

for (const fixture of REAL_FAILURES) {
  // fresh agent -> the first occurrence for that signature always fires
  const single = await harness()({ name: fixture.name, arguments: {}, agent: { id: 'one' } }, boom(fixture.text));
  const notices = single.additionalContexts ?? [];
  rows.push(
    `${notices.length === 1 && fixture.want.test(notices[0].content[0].text) ? 'PASS' : 'FAIL'}  ` +
      `${fixture.name.replace('mcp__codebase-memory-mcp__', '')} → targeted correction`,
  );

  // repeat loop on one shared agent: 1st, then every 3rd
  const shared = harness({ errorRepeat: 3 });
  const agent = { id: `loop-${fixture.name}` };
  fireCount = '';
  for (let i = 0; i < fixture.repeats; i += 1) {
    const out = await shared({ name: fixture.name, arguments: {}, agent }, boom(fixture.text));
    fireCount += (out.additionalContexts ?? []).length ? '1' : '0';
  }
  if (fixture.repeats > 1) {
    rows.push(`${fireCount === '1010010010' ? 'PASS' : 'FAIL'}  retry loop x10 -> ${fireCount} (want 1010010010)`);
  }
}

for (const text of REAL_SUCCESSES) {
  const out = await harness()({ name: 'mcp__codebase-memory-mcp__search_graph', arguments: {}, agent: { id: 's' } }, ok(text));
  rows.push(`${(out.additionalContexts ?? []).length === 0 ? 'PASS' : 'FAIL'}  successful call is not corrected`);
}

const nonMcp = await harness()({ name: 'bash', arguments: { command: 'ls' }, agent: { id: 'n' } }, boom('Error: boom'));
rows.push(`${(nonMcp.additionalContexts ?? []).length === 0 ? 'PASS' : 'FAIL'}  non-MCP failure is ignored`);

const off = await harness({ correctMCP: false })(
  { name: 'mcp__codebase-memory-mcp__search_graph', arguments: {}, agent: { id: 'x' } },
  boom(REAL_FAILURES[0].text),
);
rows.push(`${(off.additionalContexts ?? []).length === 0 ? 'PASS' : 'FAIL'}  correctMCP:false disables it`);

const noAgent = await harness()({ name: 'mcp__codebase-memory-mcp__search_graph', arguments: {} }, boom(REAL_FAILURES[0].text));
rows.push(`${(noAgent.additionalContexts ?? []).length === 0 ? 'PASS' : 'FAIL'}  no agent -> no notice`);

console.log(rows.join('\n'));
console.log('\nFAILURES:', rows.filter((r) => r.startsWith('FAIL')).length, '/', rows.length);
