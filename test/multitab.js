// test/multitab.js
//
// End-to-end multi-tab: record a workflow that spans two tabs (page A -> click
// a target=_blank link -> page B), then replay it into a fresh browser and
// assert the new tab was opened and filled.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import CDP from 'chrome-remote-interface';
import { launchChrome, listPageTargets } from '../src/browser/chrome.js';
import { MultiTabRecorder, MultiTabReplayer } from '../src/browser/multi-tab.js';
import { compile } from '../src/core/compiler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const A = readFileSync(path.join(__dirname, 'fixtures', 'page-a.html'), 'utf8');
const B = readFileSync(path.join(__dirname, 'fixtures', 'page-b.html'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(c, m) { if (c) console.log('  PASS  ' + m); else { console.log('  FAIL  ' + m); failures++; } }

async function serve() {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(req.url && req.url.startsWith('/pageB') ? B : A);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function clickEl(client, selector) {
  const r = await client.Runtime.evaluate({
    expression: `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`,
    returnByValue: true,
  });
  const v = r.result.value;
  await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: v.x + v.w / 2, y: v.y + v.h / 2, button: 'left', clickCount: 1 });
  await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: v.x + v.w / 2, y: v.y + v.h / 2, button: 'left', clickCount: 1 });
}
async function typeText(client, text) { await client.Input.insertText({ text }); }

async function main() {
  const { server, base } = await serve();
  const urlA = base + '/pageA';

  // ---- record across two tabs ----
  const { child, endpoint } = await launchChrome({ port: 9244, headless: true });
  const tabA = (await listPageTargets(endpoint))[0];
  const user = await CDP({ target: tabA.webSocketDebuggerUrl });
  await user.Page.enable();
  await user.Runtime.enable();
  await user.Page.navigate({ url: urlA });
  await sleep(1200);

  const recorder = new MultiTabRecorder(endpoint);
  await recorder.start();

  await clickEl(user, '#name'); await typeText(user, 'alice');
  await clickEl(user, '#link'); // opens B in a new tab
  await sleep(1500);

  let tabB = null;
  for (let i = 0; i < 20 && !tabB; i++) {
    const ts = await listPageTargets(endpoint);
    tabB = ts.find((t) => t.id !== tabA.id && t.url.startsWith(base));
    if (!tabB) await sleep(250);
  }
  check(!!tabB, 'link opened a new tab (B)');
  const userB = await CDP({ target: tabB.webSocketDebuggerUrl });
  await userB.Runtime.enable();
  await sleep(500);
  await clickEl(userB, '#amount'); await typeText(userB, '500');
  await clickEl(userB, '#submit');
  await sleep(800);

  const recording = await recorder.stop();
  const tabUrls = [...new Set(recording.steps.map((s) => s.tabUrl))];
  console.log('tabs: ' + tabUrls.join(' | '));
  console.log('steps: ' + recording.steps.map((s) => s.action + (s.value !== undefined ? ':' + s.value : '')).join(', '));
  check(tabUrls.some((u) => u && u.startsWith(base + '/pageA')), 'captured page A');
  check(tabUrls.some((u) => u && u.startsWith(base + '/pageB')), 'captured page B');

  const { skill } = compile(recording, { name: 'multi-tab-test' });
  console.log('variables: ' + JSON.stringify(skill.variables));

  // ---- replay into a fresh browser ----
  const r2 = await launchChrome({ port: 9245, headless: true });
  const replayer = new MultiTabReplayer(r2.endpoint);
  const result = await replayer.run(skill, { variables: { name: 'bob', amount: '700' } });
  console.log('replay: ' + JSON.stringify(result));
  check(result.ok === true, 'multi-tab replay completed');

  const tsB = await listPageTargets(r2.endpoint);
  const bTarget = tsB.find((t) => t.url.startsWith(base + '/pageB'));
  check(!!bTarget, 'replay opened page B');
  if (bTarget) {
    const v = await CDP({ target: bTarget.webSocketDebuggerUrl });
    await v.Runtime.enable();
    const txt = await v.Runtime.evaluate({ expression: "document.getElementById('result').textContent", returnByValue: true });
    console.log('B result: ' + txt.result.value);
    check(txt.result.value === 'B-submitted|700', 'page B submitted with replayed value');
    await v.close();
  }

  await user.close();
  await userB.close();
  child.kill();
  r2.child.kill();
  await new Promise((r) => server.close(r));

  console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
