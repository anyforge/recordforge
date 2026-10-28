// src/browser/multi-tab.js
//
// Multi-tab recording and replay.
//
// Recording runs one Recorder per page target and keeps discovering new tabs by
// polling the browser endpoint, so a link that opens a new tab (or a manually
// opened tab) keeps being recorded. Each step is tagged with its top-frame URL
// (`tabUrl`) by the per-tab Recorder.
//
// Replay switches tabs by `tabUrl`: before each step it finds the target whose
// URL matches, activates it via /json/activate, and runs the step there.
import { Recorder } from './recorder.js';
import { Replayer } from './replayer.js';
import { listPageTargets, activateTarget } from './chrome.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Normalize a URL for tab matching: origin + pathname, no hash/query/trailing
// slash. Query strings often carry per-session tokens that differ between
// record and replay; origin + path is the stable identity of a tab.
function urlKey(u) {
  try {
    const x = new URL(u);
    return x.origin + x.pathname.replace(/\/+$/, '');
  } catch (e) {
    return String(u || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  }
}

export class MultiTabRecorder {
  constructor(endpoint) {
    this.endpoint = endpoint;
    this.recorders = new Map(); // targetId -> { rec, url }
    this._timer = null;
    this.startedAt = null;
  }

  async start() {
    this.startedAt = new Date().toISOString();
    await this._discover();
    this._timer = setInterval(() => { this._discover().catch(() => {}); }, 500);
    return { started: true, tabs: [...this.recorders.values()].map((x) => x.url) };
  }

  async _discover() {
    let targets;
    try { targets = await listPageTargets(this.endpoint); } catch (e) { return; }
    for (const t of targets) {
      if (this.recorders.has(t.id)) continue;
      const rec = new Recorder(t.webSocketDebuggerUrl, t.id);
      try {
        await rec.start();
        this.recorders.set(t.id, { rec, url: t.url });
      } catch (e) { /* tab closed between listing and attach */ }
    }
  }

  async stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    const all = [];
    for (const [, { rec }] of this.recorders) {
      try { all.push(...(await rec.stop()).steps); } catch (e) {}
    }
    this.recorders.clear();
    all.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const first = all[0];
    return {
      version: 1,
      started_at: this.startedAt || new Date().toISOString(),
      url: first ? (first.tabUrl || first.url || '') : '',
      steps: all,
    };
  }

  async cancel() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    for (const [, { rec }] of this.recorders) { try { await rec.cancel(); } catch (e) {} }
    this.recorders.clear();
  }
}

export class MultiTabReplayer {
  constructor(endpoint) {
    this.endpoint = endpoint;
  }

  async run(skill, { variables = {}, secrets = new Map() } = {}) {
    // Fail fast on missing inputs (same pre-check as the single-tab replayer).
    const missing = [];
    for (const v of skill.variables || []) {
      if (!Object.prototype.hasOwnProperty.call(variables, v)) missing.push(v);
    }
    for (const s of skill.secrets || []) {
      if (secrets.get(s) == null) missing.push('SECRET:' + s);
    }
    if (missing.length) return { ok: false, reason: 'Missing variables/secrets: ' + missing.join(', ') };

    let targets = await listPageTargets(this.endpoint);
    if (!targets.length) return { ok: false, reason: 'no page target' };
    let current = targets[0];
    let session = await this._newSession(current);

    const script = skill.script || [];
    if (skill.url && (!script.length || script[0].op !== 'navigate')) {
      await session.client.Page.navigate({ url: skill.url });
      await sleep(2500);
      current = await this._refresh(current);
    }

    for (let i = 0; i < script.length; i++) {
      const step = script[i];
      const wanted = step.tabUrl || '';
      if (wanted && current.url !== wanted) {
        const t = await this._findTarget(wanted, current.id);
        if (t && t.id !== current.id) {
          try { await activateTarget(this.endpoint, t.id); } catch (e) {}
          await session.close();
          session = await this._newSession(t);
          current = t;
        }
      }
      const r = await session._runStep(step, skill, i, { variables, secrets });
      if (!r.ok) return { ok: false, failedAt: i, step, reason: r.reason };
      current = await this._refresh(current);
    }
    await session.close();
    return { ok: true, stepsRun: script.length };
  }

  async _newSession(target) {
    const replayer = new Replayer(target.webSocketDebuggerUrl);
    await replayer.connect();
    for (const cid of [...replayer.contexts.values()]) await replayer._injectRuntime(cid).catch(() => {});
    return replayer;
  }

  async _refresh(target) {
    const ts = await listPageTargets(this.endpoint).catch(() => []);
    const cur = ts.find((x) => x.id === target.id);
    return cur ? { ...target, url: cur.url } : target;
  }

  async _findTarget(wanted, excludeId = null, timeoutMs = 15000) {
    const wk = urlKey(wanted);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const targets = await listPageTargets(this.endpoint).catch(() => []);
      const keep = (x) => !excludeId || x.id !== excludeId;
      let t = targets.find((x) => keep(x) && x.url === wanted);
      if (!t) t = targets.find((x) => keep(x) && urlKey(x.url) === wk);
      if (!t) t = targets.find((x) => keep(x) && (urlKey(x.url).startsWith(wk) || wk.startsWith(urlKey(x.url))));
      if (t) return t;
      await sleep(250);
    }
    return null;
  }
}
