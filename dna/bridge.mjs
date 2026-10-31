import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { connect, POLICY } from './runtime.mjs';

const config = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'));
let pending;
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (!line.trim()) continue;
  let request;
  try {
    request = JSON.parse(line);
    if (request.id === undefined) continue;
    pending ??= connect(config).catch(error => { pending = undefined; throw error; });
    const client = await pending;
    let result;
    if (request.method === 'initialize') {
      result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'lunagraph-dna', version: '0.2.0' }, instructions: `${POLICY}\nThis connection is already pinned to ${config.projectName ?? config.projectId}. Start with mark_list. Do not switch projects.` };
    } else if (request.method === 'tools/call' && ['project_pick', 'project_open', 'project_create'].includes(request.params?.name)) {
      throw new Error('Rerun Lunagraph setup to change the selected file.');
    } else result = await client.rpc(request.method, request.params);
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32000, message: error.message } }) + '\n');
  }
}
