// test/interactions.js
//
// End-to-end coverage for the action types the other e2e doesn't exercise:
// select, hover, scroll, file upload, context menu. Records each interaction
// (driven over CDP), compiles, replays into a fresh browser, and asserts the
// observable DOM effect of each.
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import CDP from 'chrome-remote-interface';
import { launchChrome, listPageTargets } from '../src/browser/chrome.js';
import { MultiTabRecorder, MultiTabReplayer } from '../src/browser/multi-tab.js';
import { compile } from '../src/core/compiler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(path.join(__dirname, 'fixtures', 'interactions.html'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(c, m) { if (c) console.log('  PASS  ' + m); else { console.log('  FAIL  ' + m); failures++; } }

const rectExpr = (sel) => `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`;

async function clickEl(client, selector) {
  const v = (await client.Runtime.evaluate({ expression: rectExpr(selector), returnByValue: true })).result.value;
  const x = v.x + v.w / 2, y = v.y + v.h / 2;
  await client.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
async function rightClick(client, selector) {
  const v = (await client.Runtime.evaluate({ expression: rectExpr(selector), returnByValue: true })).result.value;
  const x = v.x + v.w / 2, y = v.y + v.h / 2;
  await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
  await client.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'right', clickCount: 1 });
  await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'right', clickCount: 1 });
}
async function moveMouse(client, selector) {
  await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 5, y: 5 });
  const v = (await client.Runtime.evaluate({ expression: rectExpr(selector), returnByValue: true })).result.value;
  await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: v.x + v.w / 2, y: v.y + v.h / 2 });
}
async function typeText(client, text) { await client.Input.insertText({ text }); }
async function setSelect(client, selector, value) {
  await client.Runtime.evaluate({ expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); })()` });
}
async function setFile(client, selector, filePath) {
  const { root } = await client.DOM.getDocument();
  const { nodeId } = await client.DOM.querySelector({ nodeId: root.nodeId, selector });
  await client.DOM.setFileInputFiles({ files: [filePath], nodeId });
}

async function main() {
  const uploadPath = path.join(os.tmpdir(), 'recordforge-upload-test.txt');
  writeFileSync(uploadPath, 'hello recordforge');

  const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(FIXTURE); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/interactions`;

  // ---- record ----
  const { child, endpoint } = await launchChrome({ port: 9254, headless: true });
  const user = await CDP({ target: (await listPageTargets(endpoint))[0].webSocketDebuggerUrl });
  await user.Page.enable();
  await user.Runtime.enable();
  await user.Page.navigate({ url });
  await sleep(1200);

  const recorder = new MultiTabRecorder(endpoint);
  await recorder.start();

  await clickEl(user, '#name'); await typeText(user, 'alice');
  await clickEl(user, '#sel'); // blurs #name -> type step
  await setSelect(user, '#sel', 'b');
  await moveMouse(user, '#hover-target'); await sleep(500); // hover fires at 300ms
  await rightClick(user, '#ctx-target'); // in view (before any scroll)
  await setFile(user, '#upload', uploadPath); // DOM op, no coordinates needed
  await user.Runtime.evaluate({ expression: 'window.scrollTo(0, 500)' }); await sleep(950); // scroll fires at 800ms
  await sleep(300);

  const recording = await recorder.stop();
  const actions = recording.steps.map((s) => s.action);
  console.log('actions: ' + actions.join(', '));
  for (const want of ['type', 'select', 'hover', 'scroll', 'upload', 'contextmenu']) {
    check(actions.includes(want), 'recorded ' + want);
  }

  const { skill } = compile(recording, { name: 'interactions-test' });
  console.log('variables: ' + JSON.stringify(skill.variables));
  check(skill.variables.includes('name'), 'type value parameterized');
  check(skill.variables.includes('upload'), 'upload filename parameterized to a path');

  await user.close();
  child.kill();

  // ---- replay ----
  const r2 = await launchChrome({ port: 9255, headless: true });
  const replayer = new MultiTabReplayer(r2.endpoint);
  const result = await replayer.run(skill, { variables: { name: 'bob', upload: uploadPath } });
  console.log('replay: ' + JSON.stringify(result));
  check(result.ok === true, 'interactions replay completed');

  const v = await CDP({ target: (await listPageTargets(r2.endpoint))[0].webSocketDebuggerUrl });
  await v.Runtime.enable();
  const ev = async (expr) => (await v.Runtime.evaluate({ expression: expr, returnByValue: true })).result.value;
  check(await ev("document.getElementById('sel').value") === 'b', 'select replayed');
  check(await ev("document.getElementById('hover-menu').style.display") === 'block', 'hover replayed (menu visible)');
  check((await ev('window.scrollY')) > 0, 'scroll replayed');
  check(await ev("document.getElementById('upload').files[0].name") === 'recordforge-upload-test.txt', 'upload replayed');
  check(String(await ev("document.getElementById('log').textContent")).includes('ctx'), 'contextmenu replayed');
  await v.close();
  r2.child.kill();

  await new Promise((r) => server.close(r));

  console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
