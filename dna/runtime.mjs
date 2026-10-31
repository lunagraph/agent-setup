import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const POLICY = `Before planning or changing any user-visible UI, including UI introduced during feature work, read the selected Lunagraph file's DNA through mark_list. Reassess when UI scope emerges later. Read marked docs with project_read; read marked canvas/element structure with canvas_read AND view take_screenshot results. Follow their referenced skills, criteria and visual references, loading project skill files explicitly. The DNA defines the way of working; this installer supplies no project design defaults. Record references actually consulted. Never change DNA to justify an implementation or treat unmarked experiments as authoritative. If DNA is unavailable, report the gap, stop dependent UI work and continue independent work only.`;

export async function connect(config) {
  let session;
  let sequence = 0;
  async function rpc(method, params, notification = false) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (session) headers['Mcp-Session-Id'] = session;
    headers['MCP-Protocol-Version'] = '2024-11-05';
    const id = ++sequence;
    const response = await fetch(config.url, { method: 'POST', headers, signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }) });
    if (!response.ok) throw new Error(`Lunagraph returned HTTP ${response.status}`);
    session = response.headers.get('mcp-session-id') ?? session;
    if (notification) { await response.body?.cancel(); return; }
    let message;
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      try {
        while (!message) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let boundary;
          while ((boundary = pending.indexOf('\n\n')) !== -1) {
            const block = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (data) { const candidate = JSON.parse(data); if (candidate.id === id) message = candidate; }
          }
        }
      } finally { await reader.cancel(); }
    } else { message = await response.json(); }
    if (!message || message.id !== id) throw new Error('Lunagraph returned no matching MCP response');
    if (message.error) throw new Error(message.error.message || 'MCP request failed');
    return message.result;
  }
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'lunagraph-dna', version: '0.2.1' } });
  await rpc('notifications/initialized', {}, true);
  const call = (name, args = {}) => rpc('tools/call', { name, arguments: args });
  if (config.projectId) {
    let result = await call('project_pick', { project_id: config.projectId });
    if (result?.isError || /couldn't|not open|not found/i.test(JSON.stringify(result))) result = await call('project_open', { project_id: config.projectId });
    if (result?.isError) throw new Error('Cannot bind the selected Lunagraph file');
  }
  return { rpc, call };
}

export async function readDna(config) {
  const client = await connect(config);
  const result = await client.call('mark_list');
  if (result?.isError) throw new Error('DNA marks could not be read');
  const text = result?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
  if (!text?.trim() || /^(?:file not found|not found|error:|no file|couldn't|could not|failed to)/i.test(text.trim())) throw new Error('DNA marks are unavailable');
  if (/Nothing is marked as DNA|No DNA/i.test(text)) throw new Error('No items are marked as DNA in this Lunagraph file');
  return text;
}

export async function context(config) {
  const dna = await readDna(config);
  return `${POLICY}\n\nSelected file: ${config.projectName ?? config.projectId ?? 'configured file'}. The lunagraph-dna MCP connection is pinned to it.\nRead these native DNA marks with project_read or canvas_read AND take_screenshot. Follow their referenced skills.\n\n--- DNA ---\n${dna}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'));
  const hook = process.argv[2] === 'hook';
  const event = process.argv[3];
  try {
    const text = await context(config);
    process.stdout.write(hook ? JSON.stringify(event === 'sessionStart' ? { additional_context: text } : { hookSpecificOutput: { hookEventName: event, additionalContext: text } }) : text + '\n');
  } catch (error) {
    const text = `DNA UNAVAILABLE: ${error.message}. Do not proceed with UI work dependent on this DNA. ${POLICY}`;
    if (hook) process.stdout.write(JSON.stringify(event === 'sessionStart' ? { additional_context: text } : { hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
    else { process.stderr.write(text + '\n'); process.exitCode = 1; }
  }
}
