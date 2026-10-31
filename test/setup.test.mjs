import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir, symlink } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { installGlobal, setup } from '../dna/setup.mjs';

async function fixture(t, noMarks = false) {
  const home = await mkdtemp(new URL('../.test-', import.meta.url).pathname);
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const message = JSON.parse(body);
    calls.push(message);
    if (message.id === undefined) { res.writeHead(202); res.end(); return; }
    let result = {};
    const name = message.params?.name;
    if (name === 'project_list') result = { content: [{ type: 'text', text: JSON.stringify({ projects: [{ id: 'file-a', name: 'First app' }, { id: 'file-b', name: 'Second app' }] }) }] };
    if (name === 'project_pick') result = { content: [{ type: 'text', text: 'Bound project' }] };
    if (name === 'mark_list') result = { content: [{ type: 'text', text: noMarks ? 'Nothing is marked as DNA yet.' : 'DNA: doc "Ways of working" (path docs/Working.md), element "Controls" on canvas "System"' }] };
    if (message.method === 'tools/list') result = { tools: [{ name: 'mark_list', inputSchema: { type: 'object' } }] };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  return { home, calls, url: `http://127.0.0.1:${server.address().port}/mcp`, project: { id: 'file-b', name: 'Second app' } };
}

test('wizard selects native file and installs user-level MCP and hooks without repo files', async t => {
  const f = await fixture(t);
  const answers = ['2', 'claude,codex,cursor', 'y'];
  const paths = await setup({ home: f.home, url: f.url, ask: async () => answers.shift() });
  assert.equal(paths.length, 9);
  assert.ok(f.calls.some(call => call.params?.name === 'project_pick' && call.params.arguments.project_id === 'file-b'));
  assert.ok(f.calls.some(call => call.params?.name === 'mark_list'));
  assert.ok(!f.calls.some(call => call.params?.name === 'project_read'));
  const config = JSON.parse(await readFile(join(f.home, '.lunagraph/dna/config.json')));
  assert.equal(config.projectId, 'file-b');
  assert.equal(config.root, undefined);
  const claude = JSON.parse(await readFile(join(f.home, '.claude.json')));
  assert.ok(claude.mcpServers['lunagraph-dna'].args[0].endsWith('bridge.mjs'));
  const codex = JSON.parse(await readFile(join(f.home, '.codex/hooks.json')));
  assert.match(codex.hooks.UserPromptSubmit[0].hooks[0].command, /runtime.mjs/);
  const cursor = JSON.parse(await readFile(join(f.home, '.cursor/hooks.json')));
  assert.match(cursor.hooks.sessionStart[0].command, /sessionStart/);
  assert.deepEqual((await readdir(f.home)).sort(), ['.claude', '.claude.json', '.codex', '.cursor', '.lunagraph']);
});

test('global reinstall preserves existing configuration and is idempotent', async t => {
  const f = await fixture(t);
  await mkdir(join(f.home, '.claude'));
  await writeFile(join(f.home, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Read'] }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo user' }] }] } }));
  const paths = await installGlobal(f);
  const before = await Promise.all(paths.map(path => readFile(path, 'utf8')));
  await installGlobal(f);
  assert.deepEqual(await Promise.all(paths.map(path => readFile(path, 'utf8'))), before);
  assert.match(await readFile(join(f.home, '.claude/settings.json'), 'utf8'), /echo user/);
});

test('missing marks and cancelled setup do not write configuration', async t => {
  const f = await fixture(t, true);
  await assert.rejects(installGlobal(f), /No items are marked/);
  assert.deepEqual(await readdir(f.home), []);
  const answers = ['1', 'claude', 'n'];
  assert.deepEqual(await setup({ home: f.home, url: f.url, ask: async () => answers.shift() }), []);
  assert.deepEqual(await readdir(f.home), []);
});

test('installed native hooks return current marks in each host format', async t => {
  const f = await fixture(t);
  await installGlobal(f);
  const run = promisify(execFile);
  const runtime = join(f.home, '.lunagraph/dna/runtime.mjs');
  for (const event of ['SessionStart', 'UserPromptSubmit', 'sessionStart']) {
    const { stdout } = await run(process.execPath, [runtime, 'hook', event]);
    const value = JSON.parse(stdout);
    assert.match(value.additional_context ?? value.hookSpecificOutput.additionalContext, /docs\/Working.md/);
  }
});

test('installed MCP bridge binds the chosen file before serving tools and blocks repicking', async t => {
  const f = await fixture(t);
  await installGlobal(f);
  const child = spawn(process.execPath, [join(f.home, '.lunagraph/dna/bridge.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = [
    { id: 1, method: 'initialize', params: {} },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'project_pick', arguments: { project_id: 'file-a' } } },
  ];
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stdin.end(messages.map(message => JSON.stringify({ jsonrpc: '2.0', ...message })).join('\n') + '\n');
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code ? reject(new Error('bridge failed')) : resolve()); });
  const replies = output.trim().split('\n').map(line => JSON.parse(line));
  assert.match(replies[0].result.instructions, /Second app/);
  assert.equal(replies[1].result.tools[0].name, 'mark_list');
  assert.match(replies[2].error.message, /Rerun/);
});

test('invalid existing config fails before modifying other files', async t => {
  const f = await fixture(t);
  await mkdir(join(f.home, '.cursor'));
  await writeFile(join(f.home, '.cursor/mcp.json'), 'invalid');
  await assert.rejects(installGlobal(f));
  assert.deepEqual(await readdir(f.home), ['.cursor']);
});

test('symlinked user configuration is not overwritten', async t => {
  const f = await fixture(t);
  const target = join(f.home, 'original.json');
  await writeFile(target, '{}');
  await symlink(target, join(f.home, '.claude.json'));
  await assert.rejects(installGlobal(f), /symlink/);
  assert.equal(await readFile(target, 'utf8'), '{}');
});
