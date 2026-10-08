import { apply } from '../hook.js';

/** Fresh plugin instance per case; cooldown 1 makes "fired" mean "qualified". */
function once(config = {}) {
  let listener = null;
  apply({ on(_ev, fn) { listener = fn; } }, { cooldown: 1, ...config });
  return listener;
}
const A = { id: 'agent' };
const lines = (n) => Array.from({ length: n }, (_, i) => `l${i}`).join('\n');
const exec = (name, args, agent = A) => ({ name, arguments: args, agent });
const ok = (t) => ({ isError: false, content: [{ type: 'text', text: t }] });
const rows = [];
async function t(label, expect, e, r, config) {
  const l = once(config);
  if (l === null) { rows.push(`FAIL  ${label} (no listener)`); return; }
  const fired = (await l(e, r, async () => ({ kind: 'accept' })))?.additionalContexts?.length === 1;
  rows.push(`${fired === expect ? 'PASS' : 'FAIL'}  ${label} (fired=${fired}, want=${expect})`);
}

// --- qualification: source work ---
await t('read 150 lines of a .kt', true, exec('read', { file_path: '/p/android/core/a.kt' }), ok(lines(150)));
await t('read 100 lines exactly (boundary)', true, exec('read', { file_path: '/p/android/core/a.kt' }), ok(lines(100)));
await t('read 99 lines (below threshold)', false, exec('read', { file_path: '/p/android/core/a.kt' }), ok(lines(99)));
await t('read 120 lines, limit absent, measured', true, exec('read', { file_path: '/p/src/b.ts' }), ok(lines(120)));
await t('read 300 lines but limit=500 only (unmeasurable result)', true, exec('read', { file_path: '/p/src/c.ts', limit: 500 }), { isError: false });
await t('grep tool with no scope', true, exec('grep', { pattern: 'fun markAllRead' }), ok('h'));
await t('grep tool scoped to android/', true, exec('grep', { pattern: 'X', path: '/p/android' }), ok('h'));
await t('bash grep in android source', true, exec('bash', { command: 'grep -rn "fun x" android/core/data/src/main/java' }), ok('h'));

// --- precision filter: must NOT fire ---
await t('read a .log', false, exec('read', { file_path: '/tmp/out.log' }), ok(lines(200)));
await t('read docs/*.md', false, exec('read', { file_path: '/p/docs/x.md' }), ok(lines(200)));
await t('read /tmp/anything', false, exec('read', { file_path: '/tmp/raw.txt' }), ok(lines(200)));
await t('bash grep of /tmp test log', false, exec('bash', { command: 'grep -nE "FAILURES|OK \\(" /tmp/closure-c-raw.txt' }), ok('h'));
await t('bash grep of docs/', false, exec('bash', { command: 'grep -rl "闭环C" docs/' }), ok('h'));
await t('bash grep of build.gradle.kts', false, exec('bash', { command: 'grep -rn "keepSession" android/app/build.gradle.kts' }), ok('h'));
await t('bash grep of /tmp/check121.log', false, exec('bash', { command: 'grep -oE "/Users/[^:]+" /tmp/check121.log | sed "s/:.*//"' }), ok('h'));
await t('heredoc writing a script that mentions grep', false, exec('bash', { command: "cat > /tmp/x.mjs <<'EOF'\ngrep -nE \"FAILURES\" /tmp/raw.txt\nEOF" }), ok('h'));
await t('bash grep scoped to docs only', false, exec('bash', { command: 'grep -rn "x" docs/adr/' }), ok('h'));
await t('grep tool scoped to docs/', false, exec('grep', { pattern: 'X', path: '/p/docs' }), ok('h'));
await t('read of a .log with limit=500', false, exec('read', { file_path: '/tmp/a.log', limit: 500 }), { isError: false });

// --- non-candidates ---
await t('bash without grep', false, exec('bash', { command: 'ls -la android/' }), ok('h'));
await t('read with error result', false, exec('read', { file_path: '/p/src/z.kt', limit: 500 }), { isError: true, content: [] });
await t('no agent', false, { name: 'read', arguments: { file_path: '/p/src/q.kt' } }, ok(lines(300)), { cooldown: 1 });
await t('write/build tools ignored', false, exec('build', { target: 'app' }), ok('h'));

// --- cooldown ladder (own instance) ---
const ladder = once({ cooldown: 6 });
const hit = async () => (await ladder(exec('read', { file_path: '/p/src/a.kt' }), ok(lines(150)), async () => ({ kind: 'accept' })))?.additionalContexts?.length === 1;
const seq = [];
for (let i = 0; i < 13; i += 1) seq.push((await hit()) ? 1 : 0);
rows.push(`${seq.join('') === '1000001000001' ? 'PASS' : 'FAIL'}  cooldown=6 ladder over 13 calls: ${seq.join('')} (want 1000001000001)`);

// --- disabled ---
let disabledListener = null;
apply({ on(_e, fn) { disabledListener = fn; } }, { enabled: false });
rows.push(`${disabledListener === null ? 'PASS' : 'FAIL'}  enabled:false registers no listener`);

// --- notice text is the current default ---
const l = once();
const msg = (await l(exec('read', { file_path: '/p/src/a.kt' }), ok(lines(150)), async () => ({ kind: 'accept' }))).additionalContexts[0];
rows.push(`${msg.source.kind === 'codebase-memory-nudge' && msg.source.form === 'notice' ? 'PASS' : 'FAIL'}  source kind/form`);
rows.push(`${[...msg.source.summary].length <= 120 ? 'PASS' : 'FAIL'}  summary <=120 chars (${[...msg.source.summary].length})`);
rows.push(`${Object.isFrozen(msg) && Object.isFrozen(msg.content) ? 'PASS' : 'FAIL'}  message frozen`);
rows.push(`${/^[0-9a-f-]{36}$/.test(msg.id) ? 'PASS' : 'FAIL'}  uuid id (${msg.id})`);
rows.push(`${msg.content[0].text.includes('刚才读取了') ? 'PASS' : 'FAIL'}  {{trigger}} substituted`);

console.log(rows.join('\n'));
console.log('\nFAILURES:', rows.filter((r) => r.startsWith('FAIL')).length, '/', rows.length);
