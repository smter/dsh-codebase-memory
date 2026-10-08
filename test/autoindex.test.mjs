/**
 * Auto-index tests. Run: `node test/autoindex.test.mjs`
 *
 * The real listener is driven with fake agents and a stubbed
 * `codebase-memory-mcp` executable, so the whole chain is exercised without
 * touching the network, the real binary, or a real index:
 *
 *   observed path -> realpath -> git root -> list_projects -> size guard
 *   -> index_repository -> project name -> agent.inject()
 */
import { apply } from '../hook.js';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'autoindex-')));

/** A throwaway repository: `.git` is all the plugin looks for. */
function makeRepo(name) {
  const root = join(base, name);
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.kt'), 'class A\n');
  return root;
}

/** A stub binary: `list_projects` answers `listBody`, anything else `indexBody`. */
function makeStub(name, listBody, indexBody) {
  const path = join(base, `${name}.sh`);
  const marker = join(base, `${name}.invoked`);
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      `echo "$4" >> "${marker}"`,
      'if [ "$4" = "list_projects" ]; then',
      `  printf '%s' '${listBody}'`,
      'else',
      `  printf '%s' '${indexBody}'`,
      'fi',
      '',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return { path, marker };
}

const EMPTY_LIST = '{"content":[{"type":"text","text":"projects: 0\\n"}]}';
const INDEXED_ONE = '{"content":[{"type":"text","text":"{\\"project\\":\\"my-project\\",\\"nodes\\":7}"}]}';

function rawHarness(config = {}) {
  let listener = null;
  apply({ on(_ev, fn) { listener = fn; } }, config);
  return listener;
}

/**
 * This file covers the auto-index wiring; the source filter is covered by
 * `triggers.test.mjs`. `tmpdir()` lives under `/var/folders`, which the shipped
 * exclude regex deliberately drops (temp junk), so relax both regexes here —
 * otherwise nothing would ever qualify and the test would pass vacuously.
 */
function harness(config = {}) {
  return rawHarness({ includeSource: '.', excludeSource: '(?!)', ...config });
}

/**
 * Wait for an asynchronous condition. The auto-index chain is fire-and-forget
 * by design, so a fixed sleep is inherently flaky; poll with a deadline instead.
 */
async function settle(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** One qualifying read inside `root`, plus the wait needed for the async chain. */
async function drive(listener, root, injected) {
  const agent = { id: `agent-${Math.random()}`, inject: (message) => injected.push(message) };
  await listener(
    { name: 'read', arguments: { file_path: join(root, 'src', 'a.kt') }, agent },
    { isError: false, content: [{ type: 'text', text: 'line\n'.repeat(150) }] },
    async () => ({ kind: 'accept' }),
  );
  await settle(() => injected.length > 0);
  return agent;
}

const rows = [];
const ok = (label, condition, detail = '') =>
  rows.push(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` (${detail})` : ''}`);

// --- 1. success: unindexed git repo gets indexed and the project is handed over
{
  const repo = makeRepo('fresh-repo');
  const stub = makeStub('fresh', EMPTY_LIST, INDEXED_ONE);
  const injected = [];
  await drive(harness({ autoIndexCommand: stub.path }), repo, injected);
  const message = injected[0];
  ok('unindexed repo -> one injected notice', injected.length === 1, `got ${injected.length}`);
  ok('notice names the project', Boolean(message) && message.content[0].text.includes('my-project'));
  ok('notice carries the repo root', Boolean(message) && message.content[0].text.includes(repo));
  ok('notice is a labeled notice', message?.source?.kind === 'codebase-memory-nudge' && message?.source?.form === 'notice');
  ok('summary is the project name', message?.source?.summary === 'indexed my-project', message?.source?.summary);
  const called = readFileSync(stub.marker, 'utf8');
  ok('stub was called twice (list + index)', called.trim().split('\n').length === 2, JSON.stringify(called.trim()));
}

// --- 2. guard: an already-indexed repo is left alone
{
  const repo = makeRepo('known-repo');
  const stub = makeStub('known', `{"content":[{"type":"text","text":"projects: 1  (cols: name root_path)\\n  known-project ${repo}\\n"}]}`, INDEXED_ONE);
  const injected = [];
  await drive(harness({ autoIndexCommand: stub.path }), repo, injected);
  ok('already-indexed repo -> no notice', injected.length === 0, `got ${injected.length}`);
  const called = readFileSync(stub.marker, 'utf8').trim().split('\n');
  ok('already-indexed repo -> index_repository not called', called.length === 1 && called[0] === 'list_projects', JSON.stringify(called));
}

// --- 3. guard: a path outside any git repository is ignored
{
  const plain = join(base, 'not-a-repo');
  mkdirSync(join(plain, 'src'), { recursive: true });
  writeFileSync(join(plain, 'src', 'a.kt'), 'class A\n');
  const stub = makeStub('plain', EMPTY_LIST, INDEXED_ONE);
  const injected = [];
  await drive(harness({ autoIndexCommand: stub.path }), plain, injected);
  ok('non-git path -> nothing spawned', injected.length === 0 && !existsSync(stub.marker));
}

// --- 4. guard: the file-count cap blocks a big tree
{
  const repo = makeRepo('huge-repo');
  for (let i = 0; i < 12; i += 1) writeFileSync(join(repo, 'src', `f${i}.kt`), 'class X\n');
  const stub = makeStub('huge', EMPTY_LIST, INDEXED_ONE);
  const injected = [];
  await drive(harness({ autoIndexCommand: stub.path, autoIndexMaxFiles: 3 }), repo, injected);
  const called = readFileSync(stub.marker, 'utf8').trim().split('\n');
  ok('over the file cap -> no index_repository, no notice', injected.length === 0 && !called.includes('index_repository'), JSON.stringify(called));
}

// --- 5. one attempt per repository per agent
{
  const repo = makeRepo('repeat-repo');
  const stub = makeStub('repeat', EMPTY_LIST, INDEXED_ONE);
  const injected = [];
  const listener = harness({ autoIndexCommand: stub.path });
  const agent = { id: 'repeat-agent', inject: (m) => injected.push(m) };
  const exec = { name: 'read', arguments: { file_path: join(repo, 'src', 'a.kt') }, agent };
  const result = { isError: false, content: [{ type: 'text', text: 'line\n'.repeat(150) }] };
  await listener(exec, result, async () => ({ kind: 'accept' }));
  await listener(exec, result, async () => ({ kind: 'accept' }));
  await listener(exec, result, async () => ({ kind: 'accept' }));
  await settle(() => {
    try {
      return readFileSync(stub.marker, 'utf8').includes('index_repository');
    } catch {
      return false;
    }
  });
  ok('same repo three times -> one notice', injected.length === 1, `got ${injected.length}`);
  const called = readFileSync(stub.marker, 'utf8').trim().split('\n');
  ok('same repo three times -> one index_repository call', called.filter((c) => c === 'index_repository').length === 1, JSON.stringify(called));
}

// --- 6. autoIndex:false disables the whole path
{
  const repo = makeRepo('disabled-repo');
  const stub = makeStub('disabled', EMPTY_LIST, INDEXED_ONE);
  const injected = [];
  await drive(harness({ autoIndexCommand: stub.path, autoIndex: false }), repo, injected);
  ok('autoIndex:false -> nothing spawned', injected.length === 0 && !existsSync(stub.marker));
}

// --- 7. a failing binary degrades silently (the nudge still fires)
{
  const repo = makeRepo('broken-repo');
  const injected = [];
  await drive(harness({ autoIndexCommand: join(base, 'does-not-exist') }), repo, injected);
  ok('broken binary -> no crash, no injected notice', injected.length === 0);
}

console.log(rows.join('\n'));
console.log('\nFAILURES:', rows.filter((row) => row.startsWith('FAIL')).length, '/', rows.length);
