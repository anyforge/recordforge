// test/e2e.js
//
// End-to-end: serve a fixture form, record a real interaction (typed via CDP
// input events, so the capture script's DOM listeners fire exactly as for a
// human), compile the recording, then replay it into a fresh browser and assert
// the form was actually submitted with the replayed values.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import CDP from 'chrome-remote-interface';
import { launchChrome, listPageTargets } from '../src/browser/chrome.js';
import { Recorder } from '../src/browser/recorder.js';
import { Replayer } from '../src/browser/replayer.js';
import { compile } from '../src/core/compiler.js';
import { emit } from '../src/core/emitter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_HTML = readFileSync(path.join(__dirname, 'fixtures', 'form.html'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('  PASS  ' + msg);
  else { console.log('  FAIL  ' + msg); failures++; }
}

async function serve() {
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(FIXTURE_HTML);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function launch(port) {
  const { child, endpoint } = await launchChrome({ port, headless: true });
  const targets = await listPageTargets(endpoint);
  return { child, endpoint, wsUrl: targets[0].webSocketDebuggerUrl };
}

async function clickEl(client, selector) {
  const r = await client.Runtime.evaluate({
    expression: `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`,
    returnByValue: true,
  });
  const v = r.result.value;
  const x = v.x + v.w / 2, y = v.y + v.h / 2;
  await client.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function typeText(client, text) {
  await client.Input.insertText({ text });
}

async function main() {
  const { server, base } = await serve();
  const url = base + '/form';
  console.log('fixture: ' + url);

  // ---- record ----
  console.log('\n[record]');
  const recChrome = await launch(9222);
  const user = await CDP({ target: recChrome.wsUrl });
  await user.Page.enable();
  await user.Runtime.enable();
  await user.Page.navigate({ url });
  await sleep(1500);

  const recorder = new Recorder(recChrome.wsUrl);
  await recorder.start();

  await clickEl(user, '#name'); await typeText(user, 'alice');
  await clickEl(user, '#password'); await typeText(user, 'hunter2');
  await clickEl(user, '#amount'); await typeText(user, '800');
  await clickEl(user, '#submit');
  await sleep(800);

  const recording = await recorder.stop();
  console.log('steps: ' + recording.steps.map((s) => s.action + (s.value !== undefined ? ':' + s.value : '')).join(', '));
  check(recording.steps.some((s) => s.action === 'type' && s.value === 'alice'), 'name captured');
  check(recording.steps.some((s) => s.action === 'type' && s.value === '{SECRET:password}'), 'password masked as {SECRET:password}');
  check(recording.steps.some((s) => s.action === 'type' && s.value === '800'), 'amount captured');
  check(recording.steps.some((s) => s.action === 'click'), 'submit click captured');

  await user.close();
  recChrome.child.kill();

  // ---- compile ----
  console.log('\n[compile]');
  const { skill } = compile(recording, { name: 'test-form' });
  console.log('variables: ' + JSON.stringify(skill.variables) + '  secrets: ' + JSON.stringify(skill.secrets));
  check(skill.variables.includes('name'), 'variable "name" parameterized');
  check(skill.variables.includes('amount'), 'variable "amount" parameterized');
  check(skill.secrets.includes('password'), 'secret "password" extracted');
  check(!skill.script.some((s) => s.op === 'press'), 'no redundant submit step in compiled script');

  // ---- emit ----
  console.log('\n[emit]');
  const bundle = emit(skill, { name: 'test-form', outDir: path.join(os.tmpdir(), 'rf-emit-' + Date.now()) });
  const skmd = readFileSync(bundle.files[0], 'utf8');
  const readme = readFileSync(bundle.files[2], 'utf8');
  check(skmd.includes('name: test-form'), 'SKILL.md carries name frontmatter');
  check(skmd.includes('## Variables') && skmd.includes('## Secrets'), 'SKILL.md documents variables and secrets');
  check(skmd.includes('recordforge replay'), 'SKILL.md gives replay instructions');
  for (const agent of ['Hermes', 'Claude Code', 'Codex', 'Pi', 'OpenClaw', 'DeepSeek Harness']) {
    check(readme.includes(agent), 'install guide covers ' + agent);
  }

  // ---- replay ----
  console.log('\n[replay]');
  const repChrome = await launch(9223);
  const replayer = new Replayer(repChrome.wsUrl);
  const result = await replayer.run(skill, {
    variables: { name: 'bob', amount: '500' },
    secrets: new Map([['password', 'hunter2']]),
  });
  console.log('result: ' + JSON.stringify(result));
  check(result.ok === true, 'replay completed');

  const verify = await CDP({ target: repChrome.wsUrl });
  await verify.Runtime.enable();
  const txt = await verify.Runtime.evaluate({ expression: `document.getElementById('result').textContent`, returnByValue: true });
  console.log('result div: ' + txt.result.value);
  check(txt.result.value === 'submitted|bob|500|pwlen=7', 'form submitted with replayed values (bob / 500 / pwlen=7)');
  await verify.close();
  repChrome.child.kill();

  await new Promise((r) => server.close(r));

  console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
