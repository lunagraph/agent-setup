#!/usr/bin/env node
import { setup } from '../dna/setup.mjs';

const HELP = `Usage: lunagraph-dna [setup] [--url <desktop MCP URL>] [--agents claude,codex,cursor]
Choose a Lunagraph file and install its user-level MCP connection and hooks.
`;

try {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
  } else {
    if (args[0] === 'setup') args.shift();
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      const key = { '--url': 'url', '--home': 'home', '--project-id': 'projectId', '--agents': 'agents' }[args[i]];
      if (!key || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid argument: ${args[i]}. Run --help for usage.`);
      options[key] = key === 'agents' ? args[i + 1].split(',') : args[i + 1];
    }
    process.stdout.write('Lunagraph agent setup. Connecting to the desktop app…\n');
    const paths = await setup(options);
    process.stdout.write(paths.length ? 'Installed. Restart agents and approve the MCP connection and hooks when prompted.\n' : 'Cancelled. No files changed.\n');
  }
} catch (error) {
  process.stderr.write(`Setup failed: ${error.message}\n`);
  process.exitCode = 1;
}
