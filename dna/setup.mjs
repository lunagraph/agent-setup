import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { connect, context } from './runtime.mjs';

const MARKER = '# lunagraph-dna:begin';
const END = '# lunagraph-dna:end';
const shell = value => "'" + value.replaceAll("'", "'\\''") + "'";
export async function listProjects(url) {
  const client = await connect({ url });
  const result = await client.call('project_list', { scope: 'all' });
  if (result?.isError) throw new Error('Cannot list Lunagraph files. Open Lunagraph and sign in.');
  const text = result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
  const projects = JSON.parse(text).projects;
  if (!Array.isArray(projects) || projects.some(project => typeof project.id !== 'string' || typeof project.name !== 'string')) throw new Error('Invalid Lunagraph file list');
  return projects;
}

export async function installGlobal({ home = homedir(), url = 'http://127.0.0.1:21209/mcp', project, agents = ['claude', 'codex', 'cursor'] }) {
  if (!isAbsolute(home)) throw new Error('Home directory must be absolute');
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Invalid MCP URL');
  if (!project?.id || !project?.name) throw new Error('Choose a Lunagraph file');
  if (!agents.length || agents.some(value => !['claude', 'codex', 'cursor'].includes(value))) throw new Error('Choose Claude, Codex or Cursor');
  const config = { url: parsed.href, projectId: project.id, projectName: project.name };
  await context(config);
  const directory = join(home, '.lunagraph/dna');
  const runtime = join(directory, 'runtime.mjs');
  const bridge = join(directory, 'bridge.mjs');
  const command = event => `${shell(process.execPath)} ${shell(runtime)} hook ${event}`;
  const changes = new Map();
  async function existing(path) {
    for (let part = path; part !== home; part = dirname(part)) {
      if (part === dirname(part)) throw new Error('Destination escaped home');
      try { if ((await lstat(part)).isSymbolicLink()) throw new Error(`Refusing symlink: ${part}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try { return await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; return ''; }
  }
  async function json(path, change) {
    const previous = await existing(path);
    const value = previous ? JSON.parse(previous) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid config: ${path}`);
    change(value);
    changes.set(path, JSON.stringify(value, null, 2) + '\n');
  }
  function mcp(value) {
    value.mcpServers ??= {};
    if (!value.mcpServers || Array.isArray(value.mcpServers) || typeof value.mcpServers !== 'object') throw new Error('Invalid mcpServers');
    const old = value.mcpServers['lunagraph-dna'];
    if (old && !old.args?.includes(bridge)) throw new Error('Existing unmanaged lunagraph-dna server');
    value.mcpServers['lunagraph-dna'] = { command: process.execPath, args: [bridge] };
  }
  function hooks(value, cursor = false) {
    value.hooks ??= {};
    if (!value.hooks || Array.isArray(value.hooks) || typeof value.hooks !== 'object') throw new Error('Invalid hooks');
    for (const event of cursor ? ['sessionStart'] : ['SessionStart', 'UserPromptSubmit']) {
      const groups = value.hooks[event] ?? [];
      if (!Array.isArray(groups)) throw new Error(`Invalid ${event} hooks`);
      if (cursor) {
        value.hooks[event] = groups.filter(hook => !hook.command?.includes(shell(runtime)));
        value.hooks[event].push({ command: command(event) });
      } else {
        value.hooks[event] = groups.map(group => ({ ...group, hooks: group.hooks.filter(hook => !hook.command?.includes(shell(runtime))) })).filter(group => group.hooks.length);
        value.hooks[event].push({ hooks: [{ type: 'command', command: command(event), timeout: 30 }] });
      }
    }
  }
  if (agents.includes('claude')) {
    await json(join(home, '.claude.json'), mcp);
    await json(join(home, '.claude/settings.json'), value => hooks(value));
  }
  if (agents.includes('codex')) {
    const path = join(home, '.codex/config.toml');
    const old = await existing(path);
    const start = old.indexOf(MARKER);
    const finish = old.indexOf(END);
    if ((start < 0) !== (finish < 0) || (start >= 0 && finish < start) || old.indexOf(MARKER, start + 1) >= 0) throw new Error('Malformed managed Codex config');
    const unmanaged = start < 0 ? old : old.slice(0, start) + old.slice(finish + END.length);
    if (/^\s*\[mcp_servers\.(?:lunagraph-dna|"lunagraph-dna"|'lunagraph-dna')(?:\]|\.)/m.test(unmanaged)) throw new Error('Existing unmanaged Codex server');
    const block = `${MARKER}\n[mcp_servers.lunagraph-dna]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(bridge)}]\n${END}`;
    changes.set(path, start < 0 ? `${old}${old.endsWith('\n') ? '' : '\n'}${block}\n` : old.slice(0, start) + block + old.slice(finish + END.length));
    await json(join(home, '.codex/hooks.json'), value => hooks(value));
  }
  if (agents.includes('cursor')) {
    await json(join(home, '.cursor/mcp.json'), mcp);
    await json(join(home, '.cursor/hooks.json'), value => { value.version ??= 1; hooks(value, true); });
  }
  for (const name of ['runtime.mjs', 'bridge.mjs']) {
    const path = join(directory, name);
    await existing(path);
    changes.set(path, await readFile(new URL('./' + name, import.meta.url), 'utf8'));
  }
  const configPath = join(directory, 'config.json');
  await existing(configPath);
  changes.set(configPath, JSON.stringify(config, null, 2) + '\n');
  for (const [path, contents] of changes) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents); }
  return [...changes.keys()];
}

export async function setup(options = {}) {
  const url = options.url ?? 'http://127.0.0.1:21209/mcp';
  const projects = await listProjects(url);
  if (!projects.length) throw new Error('No Lunagraph files found. Create or open a file in Lunagraph first.');
  const terminal = options.ask ? null : createInterface({ input: stdin, output: stdout });
  const ask = options.ask ?? (question => terminal.question(question));
  try {
    let project = projects.find(value => value.id === options.projectId);
    if (options.projectId && !project) throw new Error('Selected file is not accessible');
    if (!project) {
      stdout.write('Choose the Lunagraph file whose DNA your agents should use:\n' + projects.map((value, index) => `  ${index + 1}. ${value.name}${value.active ? ' (active)' : ''}`).join('\n') + '\n');
      const choice = await ask('File number: ');
      if (!/^\d+$/.test(choice.trim())) throw new Error('Enter a file number');
      project = projects[Number(choice.trim()) - 1];
      if (!project) throw new Error('Invalid file number');
    }
    const agents = options.agents ?? (await ask('Agents [claude,codex,cursor]: ') || 'claude,codex,cursor').split(',').map(value => value.trim());
    stdout.write(`Install user-level MCP and hooks for ${project.name}. This becomes the selected DNA file for these agents; app repos are not modified.\n`);
    if (!options.yes && (await ask('Install? [y/N]: ')).trim().toLowerCase() !== 'y') return [];
    return await installGlobal({ ...options, url, project, agents });
  } finally { terminal?.close(); }
}
