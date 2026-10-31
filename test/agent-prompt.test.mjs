import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '@inquirer/testing';
import checkbox from '@inquirer/checkbox';
import { AGENT_PROMPT } from '../dna/setup.mjs';

test('Enter accepts all three supported agents by default', async () => {
  const { answer, events, getScreen } = await render(checkbox, AGENT_PROMPT);
  assert.match(getScreen(), /Claude Code/);
  assert.match(getScreen(), /Codex/);
  assert.match(getScreen(), /Cursor/);
  events.keypress('enter');
  assert.deepEqual(await answer, ['claude', 'codex', 'cursor']);
});

test('arrows and Space select individual agents', async () => {
  const { answer, events } = await render(checkbox, AGENT_PROMPT);
  events.keypress('space');
  events.keypress('down');
  events.keypress('down');
  events.keypress('space');
  events.keypress('enter');
  assert.deepEqual(await answer, ['codex']);
});

test('a selects all agents from a partial selection', async () => {
  const { answer, events } = await render(checkbox, AGENT_PROMPT);
  events.keypress('space');
  events.keypress('a');
  events.keypress('enter');
  assert.deepEqual(await answer, ['claude', 'codex', 'cursor']);
});

test('empty selection cannot be submitted', async () => {
  const { answer, events, nextRender, getScreen } = await render(checkbox, AGENT_PROMPT);
  events.keypress('a');
  events.keypress('enter');
  await nextRender();
  assert.match(getScreen(), /at least one/i);
  events.keypress('a');
  events.keypress('enter');
  assert.deepEqual(await answer, ['claude', 'codex', 'cursor']);
});
