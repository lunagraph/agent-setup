#!/usr/bin/env node
import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { context, POLICY } from '../dna/runtime.mjs';
import { setup } from '../dna/setup.mjs';

const BEGIN = '<!-- lunagraph-dna:begin -->';
const END = '<!-- lunagraph-dna:end -->';

function managed(text, body, begin = BEGIN, end = END) {
  const start = text.indexOf(begin);
  const finish = text.indexOf(end);
  if ((start < 0) !== (finish < 0) || (start >= 0 && finish < start) || text.indexOf(begin, start + 1) >= 0) throw new Error('Malformed DNA managed block');
  const block = `${begin}\n${body}\n${end}`;
  return start < 0 ? `${text}${text && !text.endsWith('\n') ? '\n' : ''}\n${block}\n` : text.slice(0, start) + block + text.slice(finish + end.length);
}

export async function install({ repo, url, root = 'docs/DNA.md', agents = ['claude', 'codex', 'cursor'], verify = true }) {
  const target = await realpath(repo);
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Use an HTTP MCP URL without embedded credentials');
  if (!root || root.startsWith('/') || root.split('/').includes('..')) throw new Error('DNA root must be a project-relative path');
  if (!agents.length || agents.some(agent => !['claude', 'codex', 'cursor'].includes(agent))) throw new Error('Supported agents: claude,codex,cursor');
  const config = { url: parsed.href, root };
  if (verify) await context(config);
  const changes = new Map();
  async function existing(path) {
    for (let current = join(target, path); current !== target; current = dirname(current)) {
      try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`Refusing symlink: ${current}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try { return await readFile(join(target, path), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; return ''; }
  }
  async function json(path, edit) {
    const old = await existing(path);
    const value = old ? JSON.parse(old) : {};
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`Expected object: ${path}`);
    edit(value);
    changes.set(path, JSON.stringify(value, null, 2) + '\n');
  }
  function addServer(value, path) {
    value.mcpServers ??= {};
    if (!value.mcpServers || Array.isArray(value.mcpServers) || typeof value.mcpServers !== 'object') throw new Error(`Invalid mcpServers in ${path}`);
    const old = value.mcpServers['lunagraph-dna'];
    if (old && (old.type !== 'http' || typeof old.url !== 'string')) throw new Error(`Existing lunagraph-dna server conflicts in ${path}`);
    value.mcpServers['lunagraph-dna'] = { ...old, type: 'http', url: config.url };
  }
  const instructions = `${POLICY}\n\nThe project DNA connection is configured in .lunagraph/dna/config.json. At the start of each task run:\n\nnode .lunagraph/dna/runtime.mjs context\n\nRead the returned root, then explicitly load its referenced skills and visual evidence through the lunagraph-dna MCP tools. The root is ${root}. This applies even if the feature prompt never mentions design. Do not select a different Lunagraph file.`;
  changes.set('AGENTS.md', managed(await existing('AGENTS.md'), instructions));
  if (agents.includes('claude')) {
    changes.set('CLAUDE.md', managed(await existing('CLAUDE.md'), instructions));
    await json('.mcp.json', value => addServer(value, '.mcp.json'));
    await json('.claude/settings.json', value => {
      value.hooks ??= {};
      if (Array.isArray(value.hooks) || typeof value.hooks !== 'object') throw new Error('Invalid Claude hooks configuration');
      for (const event of ['SessionStart', 'UserPromptSubmit']) {
        const command = `node "$CLAUDE_PROJECT_DIR/.lunagraph/dna/runtime.mjs" hook ${event}`;
        const hooks = value.hooks[event] ?? [];
        if (!Array.isArray(hooks)) throw new Error(`Invalid ${event} hooks`);
        value.hooks[event] = hooks.map(group => ({ ...group, hooks: group.hooks.filter(hook => !hook.command?.includes('/.lunagraph/dna/runtime.mjs')) })).filter(group => group.hooks.length);
        value.hooks[event].push({ hooks: [{ type: 'command', command, timeout: 12 }] });
      }
    });
  }
  if (agents.includes('codex')) {
    const path = '.codex/config.toml';
    const old = await existing(path);
    const begin = '# lunagraph-dna:begin';
    const end = '# lunagraph-dna:end';
    const unmanaged = old.replace(/# lunagraph-dna:begin[\s\S]*?# lunagraph-dna:end/g, '');
    if (/^\s*\[mcp_servers\.(?:"lunagraph-dna"|'lunagraph-dna'|lunagraph-dna)(?:\]|\.)/m.test(unmanaged)) throw new Error('Existing unmanaged Codex lunagraph-dna configuration');
    changes.set(path, managed(old, `[mcp_servers.lunagraph-dna]\nurl = ${JSON.stringify(config.url)}`, begin, end));
  }
  if (agents.includes('cursor')) {
    await json('.cursor/mcp.json', value => addServer(value, '.cursor/mcp.json'));
    const path = '.cursor/rules/lunagraph-dna.mdc';
    const old = await existing(path);
    if (old && !old.includes(BEGIN)) throw new Error('Existing unmanaged Cursor DNA rule');
    changes.set(path, `---\ndescription: Load this project's Lunagraph DNA before UI work\nalwaysApply: true\n---\n${BEGIN}\n${instructions}\n${END}\n`);
  }
  for (const [path, content] of [
    ['.lunagraph/dna/config.json', JSON.stringify(config, null, 2) + '\n'],
    ['.lunagraph/dna/runtime.mjs', await readFile(new URL('../dna/runtime.mjs', import.meta.url), 'utf8')],
  ]) { await existing(path); changes.set(path, content); }
  // Validate every destination and parse every config before the first write.
  for (const [path, content] of changes) {
    await mkdir(dirname(join(target, path)), { recursive: true });
    await writeFile(join(target, path), content);
  }
  return [...changes.keys()];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (!args.length || args[0] === 'setup') {
      const options = {};
      for (let i = args.length ? 1 : 0; i < args.length; i += 2) {
        const key = { '--url': 'url', '--home': 'home', '--project-id': 'projectId', '--agents': 'agents' }[args[i]];
        if (!key || !args[i + 1]) throw new Error(`Invalid argument: ${args[i]}`);
        options[key] = key === 'agents' ? args[i + 1].split(',') : args[i + 1];
      }
      const paths = await setup(options);
      console.log(paths.length ? 'Installed. Restart agents and approve the new MCP connection and hooks when prompted.' : 'Cancelled. No files changed.');
    } else if (args[0] !== 'install' || args.includes('--help')) {
      console.log('Usage: lunagraph-dna [setup] [--url <desktop MCP URL>]\nOpens the file picker and installs user-level MCP and hooks.\nLegacy repo mode: install --url <file-bound URL> --repo <path> [--root docs/DNA.md]');
    } else {
      const options = { repo: process.cwd() };
      for (let i = 1; i < args.length; i += 2) {
        const key = { '--url': 'url', '--repo': 'repo', '--root': 'root', '--agents': 'agents' }[args[i]];
        if (!key || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid argument: ${args[i]}`);
        options[key] = key === 'agents' ? args[i + 1].split(',') : args[i + 1];
      }
      if (!options.url) throw new Error('--url is required: use the file-bound HTTP MCP connection supplied by Lunagraph');
      const paths = await install(options);
      console.log(`Installed DNA routing in ${paths.length} files. Restart agents and approve/trust the project MCP connection and hooks. DNA content remains in Lunagraph.`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
