import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const run = promisify(execFile);
const cli = new URL('../bin/lunagraph-dna.mjs', import.meta.url).pathname;

test('npm-style symlinked executable runs instead of silently exiting', async t => {
  const directory = await mkdtemp(new URL('../.test-', import.meta.url).pathname);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'lunagraph-dna');
  await symlink(cli, executable);
  const { stdout } = await run(process.execPath, [executable, '--help']);
  assert.match(stdout, /Usage: lunagraph-dna/);
  assert.doesNotMatch(stdout, /--repo|--root|Legacy/);
});

test('removed repo-local installation flags fail explicitly', async () => {
  for (const args of [['install'], ['--repo', '.'], ['--root', 'DNA.md']]) {
    await assert.rejects(run(process.execPath, [cli, ...args]), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Invalid argument/);
      return true;
    });
  }
});

test('connection failure is visible and exits nonzero', async () => {
  await assert.rejects(run(process.execPath, [cli, '--url', 'http://127.0.0.1:1/mcp']), error => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /Connecting to the desktop/);
    assert.match(error.stderr, /Setup failed/);
    return true;
  });
});
