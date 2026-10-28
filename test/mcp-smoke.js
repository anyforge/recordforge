// test/mcp-smoke.js
//
// Spawn the MCP server over stdio and confirm it completes the initialize
// handshake and lists its tools.
import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['src/index.js'], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const pending = new Map();
let nextId = 1;
let failures = 0;

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
  });
}

child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { continue; }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

const init = await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
console.log('serverInfo: ' + JSON.stringify(init.result && init.result.serverInfo));
if (!(init.result && init.result.serverInfo)) failures++;
await send('notifications/initialized', {});

const tools = await send('tools/list', {});
const names = (tools.result && tools.result.tools || []).map((t) => t.name);
console.log('tools (' + names.length + '): ' + names.join(', '));
const expected = ['record_start', 'record_stop', 'record_cancel', 'compile', 'emit', 'replay', 'list', 'secret_set', 'secret_list', 'secret_delete'];
for (const e of expected) {
  if (!names.includes(e)) { console.log('  FAIL missing tool: ' + e); failures++; }
}

const listRes = await send('tools/call', { name: 'list', arguments: {} });
console.log('list result: ' + JSON.stringify(listRes.result && listRes.result.content));
if (!(listRes.result && listRes.result.content)) failures++;

child.kill();
console.log('\n' + (failures === 0 ? 'MCP SMOKE PASS' : failures + ' FAILURE(S)'));
process.exit(failures === 0 ? 0 : 1);
