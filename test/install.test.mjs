import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { install } from '../bin/lunagraph-dna.mjs';
import { readDna } from '../dna/runtime.mjs';

async function fixture(t) {
  const repo = await mkdtemp(new URL('../.test-', import.meta.url).pathname);
  t.after(() => rm(repo, { recursive: true, force: true }));
  return repo;
}

async function server(t, { sse = false, missing = false } = {}) {
  const calls = [];
  const instance = createServer(async (request, response) => {
    let input = '';
    for await (const chunk of request) input += chunk;
    const message = JSON.parse(input);
    calls.push(message);
    if (message.method === 'notifications/initialized') { response.writeHead(202); response.end(); return; }
    if (message.method !== 'initialize') assert.equal(request.headers['mcp-session-id'], 'test-session');
    const result = message.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } : {
      ...(missing ? { isError: true } : {}), content: [{ type: 'text', text: missing ? 'File not found' : '# Project DNA\nRead skills/custom/SKILL.md.\nUse the Settings specimen.' }],
    };
    response.writeHead(200, { 'Content-Type': sse ? 'text/event-stream' : 'application/json', 'Mcp-Session-Id': 'test-session' });
    const payload = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
    response.end(sse ? `: keepalive\n\nevent: message\ndata: ${payload}\n\n` : payload);
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => instance.close(resolve)));
  return { url: `http://127.0.0.1:${instance.address().port}/file/fixture/mcp`, calls };
}

test('install fetches chosen DNA and wires all clients without copying its rules', async t => {
  const repo = await fixture(t);
  const { url, calls } = await server(t);
  await writeFile(join(repo, 'AGENTS.md'), '# Existing repo rules\n');
  await mkdir(join(repo, '.claude'));
  await writeFile(join(repo, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Read'] }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo existing' }] }] } }));
  await writeFile(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { other: { type: 'http', url: 'http://example.test' } } }));
  await install({ repo, url });
  assert.equal(calls.at(-1).params.arguments.file_path, 'docs/DNA.md');
  const instructions = await readFile(join(repo, 'AGENTS.md'), 'utf8');
  assert.ok(instructions.startsWith('# Existing repo rules'));
  assert.match(instructions, /feature work/);
  assert.doesNotMatch(instructions, /Use the Settings specimen/);
  const settings = JSON.parse(await readFile(join(repo, '.claude/settings.json')));
  assert.deepEqual(settings.permissions, { allow: ['Read'] });
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, 'echo existing');
  assert.match(settings.hooks.UserPromptSubmit[0].hooks[0].command, /runtime.mjs/);
  const mcp = JSON.parse(await readFile(join(repo, '.mcp.json')));
  assert.equal(mcp.mcpServers.other.url, 'http://example.test');
  assert.equal(mcp.mcpServers['lunagraph-dna'].url, url);
  assert.match(await readFile(join(repo, '.codex/config.toml'), 'utf8'), /mcp_servers.lunagraph-dna/);
  assert.match(await readFile(join(repo, '.cursor/rules/lunagraph-dna.mdc'), 'utf8'), /alwaysApply: true/);
});

test('reinstall is byte-for-byte idempotent and keeps co-located user hooks', async t => {
  const repo = await fixture(t);
  const { url } = await server(t);
  const paths = await install({ repo, url });
  const settingsPath = join(repo, '.claude/settings.json');
  const settings = JSON.parse(await readFile(settingsPath));
  settings.hooks.SessionStart[0].hooks.push({ type: 'command', command: 'echo user-hook' });
  await writeFile(settingsPath, JSON.stringify(settings));
  await install({ repo, url });
  assert.match(await readFile(settingsPath, 'utf8'), /echo user-hook/);
  const before = await Promise.all(paths.map(path => readFile(join(repo, path), 'utf8')));
  await install({ repo, url });
  assert.deepEqual(await Promise.all(paths.map(path => readFile(join(repo, path), 'utf8'))), before);
});

test('missing DNA prevents installation without modifying the repo', async t => {
  const repo = await fixture(t);
  const { url } = await server(t, { missing: true });
  await assert.rejects(install({ repo, url }), /could not be read/);
  assert.deepEqual(await readdir(repo), []);
});

test('SSE transport and alternate project root are supported', async t => {
  const { url, calls } = await server(t, { sse: true });
  assert.match(await readDna({ url, root: 'DNA.md' }), /Project DNA/);
  assert.equal(calls.at(-1).params.arguments.file_path, 'DNA.md');
});

test('invalid existing config is rejected before any writes', async t => {
  const repo = await fixture(t);
  const { url } = await server(t);
  await mkdir(join(repo, '.cursor'));
  await writeFile(join(repo, '.cursor/mcp.json'), 'invalid');
  await assert.rejects(install({ repo, url }));
  await assert.rejects(readFile(join(repo, 'AGENTS.md')), { code: 'ENOENT' });
});

test('symlinked instruction files are not overwritten', async t => {
  const repo = await fixture(t);
  const outside = await fixture(t);
  const { url } = await server(t);
  await writeFile(join(outside, 'rules.md'), 'untouched');
  await symlink(join(outside, 'rules.md'), join(repo, 'AGENTS.md'));
  await assert.rejects(install({ repo, url }), /symlink/);
  assert.equal(await readFile(join(outside, 'rules.md'), 'utf8'), 'untouched');
});

test('offline hook reports unavailable DNA instead of generic fallback', async t => {
  const repo = await fixture(t);
  const { url } = await server(t);
  await install({ repo, url });
  await writeFile(join(repo, '.lunagraph/dna/config.json'), JSON.stringify({ url: 'http://127.0.0.1:1/mcp', root: 'DNA.md' }));
  const result = spawnSync(process.execPath, [join(repo, '.lunagraph/dna/runtime.mjs'), 'hook', 'UserPromptSubmit'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /DNA UNAVAILABLE/);
});

test('CLI installs and installed hook loads live root, including project-defined skills', async t => {
  const repo = await fixture(t);
  const { url } = await server(t);
  const run = promisify(execFile);
  const cli = new URL('../bin/lunagraph-dna.mjs', import.meta.url).pathname;
  const installed = await run(process.execPath, [cli, 'install', '--repo', repo, '--url', url, '--agents', 'claude', '--root', 'DNA.md']);
  assert.match(installed.stdout, /Installed DNA routing/);
  const loaded = await run(process.execPath, [join(repo, '.lunagraph/dna/runtime.mjs'), 'hook', 'SessionStart']);
  const output = JSON.parse(loaded.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, 'SessionStart');
  assert.match(output.additionalContext, /skills\/custom\/SKILL.md/);
  assert.match(output.additionalContext, /DNA.md/);
  await assert.rejects(readFile(join(repo, '.codex/config.toml')), { code: 'ENOENT' });
});

test('an unmanaged Codex server is not overwritten', async t => {
  const repo = await fixture(t);
  const { url } = await server(t);
  await mkdir(join(repo, '.codex'));
  await writeFile(join(repo, '.codex/config.toml'), '[mcp_servers.lunagraph-dna]\nurl = "http://old.test"\n');
  await assert.rejects(install({ repo, url }), /unmanaged Codex/);
  await assert.rejects(readFile(join(repo, 'AGENTS.md')), { code: 'ENOENT' });
});
