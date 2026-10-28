// Regenerates the demo assets: records a demo workflow, replays it with new
// values while capturing frames, then writes assets/screenshot.png + demo.gif.
// Run from the repo root:  node scripts/make-demo.mjs
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execSync } from 'node:child_process';
import CDP from 'chrome-remote-interface';
import { launchChrome, listPageTargets } from '../src/browser/chrome.js';
import { MultiTabRecorder, MultiTabReplayer } from '../src/browser/multi-tab.js';
import { compile } from '../src/core/compiler.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ASSETS = path.join(import.meta.dirname, '..', 'assets');
const FRAMES = '/tmp/rf-frames';

const DEMO = `<!doctype html>
<html><head><meta charset="utf-8"><title>Order form — recordforge demo</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f172a;font-family:-apple-system,"Segoe UI",Roboto,sans-serif;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh}
.card{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:36px;width:420px}
.badge{display:inline-block;background:rgba(245,158,11,.15);color:#f59e0b;font-size:11px;padding:2px 10px;border-radius:999px;margin-bottom:14px}
h1{font-size:21px;margin-bottom:4px}
.sub{color:#94a3b8;font-size:13px;margin-bottom:24px}
label{display:block;font-size:13px;color:#94a3b8;margin:14px 0 6px}
input,select{width:100%;padding:10px 12px;border-radius:8px;border:1px solid #334155;background:#0b1220;color:#e2e8f0;font-size:15px}
input:focus,select:focus{outline:2px solid #f59e0b;outline-offset:1px}
button{width:100%;margin-top:26px;padding:12px;border:none;border-radius:8px;background:#f59e0b;color:#1a1206;font-size:15px;font-weight:600;cursor:pointer}
#result{margin-top:16px;font-size:14px;color:#34d399;text-align:center;min-height:20px}
</style></head>
<body><div class="card">
<span class="badge">recordforge · deterministic replay</span>
<h1>Place an order</h1>
<div class="sub">Recorded once, replayed with new values</div>
<label for="name">Customer name</label>
<input id="name" name="name" placeholder="e.g. Alice">
<label for="qty">Quantity</label>
<input id="qty" name="qty" placeholder="e.g. 2">
<label for="category">Category</label>
<select id="category"><option value="Books">Books</option><option value="Music">Music</option><option value="Games">Games</option></select>
<button id="submit" type="submit">Submit order</button>
<div id="result"></div>
</div>
<script>
document.getElementById('submit').addEventListener('click',function(e){e.preventDefault();
var n=document.getElementById('name').value,q=document.getElementById('qty').value,c=document.getElementById('category').value;
document.getElementById('result').textContent='\u2713 Order placed: '+n+' \u00d7 '+q+' ('+c+')';});
</script></body></html>`;

const rectExpr = (sel) => `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`;

async function clickEl(client, selector) {
  const v = (await client.Runtime.evaluate({ expression: rectExpr(selector), returnByValue: true })).result.value;
  const x = v.x + v.w / 2, y = v.y + v.h / 2;
  await client.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
async function typeText(client, text) { await client.Input.insertText({ text }); }
async function setSelect(client, selector, value) {
  await client.Runtime.evaluate({ expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change',{bubbles:true})); })()` });
}

async function main() {
  mkdirSync(ASSETS, { recursive: true });
  rmSync(FRAMES, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });

  const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(DEMO); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/demo`;

  const { child, endpoint } = await launchChrome({ port: 9277, headless: true });
  const target = (await listPageTargets(endpoint))[0];
  const user = await CDP({ target: target.webSocketDebuggerUrl });
  await user.Page.enable();
  await user.Runtime.enable();
  await user.Page.navigate({ url });
  await sleep(1500);

  // record (demonstrate with Alice / 2 / Books)
  const recorder = new MultiTabRecorder(endpoint);
  await recorder.start();
  await clickEl(user, '#name'); await typeText(user, 'Alice');
  await clickEl(user, '#qty'); await typeText(user, '2');
  await setSelect(user, '#category', 'Books');
  await clickEl(user, '#submit');
  await sleep(600);
  const recording = await recorder.stop();
  const { skill } = compile(recording, { name: 'demo' });
  console.log('recorded ' + recording.steps.length + ' steps; variables=' + JSON.stringify(skill.variables));

  // reset for a clean replay
  await user.Page.navigate({ url: 'about:blank' });
  await sleep(400);

  // replay (Bob / 5) while capturing frames
  let capturing = true, i = 0;
  const captureLoop = (async () => {
    while (capturing) {
      try {
        const shot = await user.Page.captureScreenshot({ format: 'png' });
        writeFileSync(path.join(FRAMES, `frame_${String(i++).padStart(3, '0')}.png`), Buffer.from(shot.data, 'base64'));
      } catch (e) {}
      await sleep(250);
    }
  })();

  const replayer = new MultiTabReplayer(endpoint);
  const result = await replayer.run(skill, { variables: { name: 'Bob', qty: '5' } });
  console.log('replay: ' + JSON.stringify(result));
  capturing = false;
  await captureLoop;

  const finalShot = await user.Page.captureScreenshot({ format: 'png' });
  writeFileSync(path.join(ASSETS, 'screenshot.png'), Buffer.from(finalShot.data, 'base64'));

  execSync(`ffmpeg -y -framerate 6 -i ${FRAMES}/frame_%03d.png -vf "fps=6,scale=840:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer" -loop 0 ${ASSETS}/demo.gif`, { stdio: 'inherit' });

  await user.close();
  child.kill();
  await new Promise((r) => server.close(r));
  rmSync(FRAMES, { recursive: true, force: true });
  console.log('done ->', ASSETS);
}

main().catch((e) => { console.error(e); process.exit(1); });
