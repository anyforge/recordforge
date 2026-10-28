// src/browser/replayer.js
//
// Deterministic replay engine. Executes a compiled script in one pass: each
// step resolves its element through the injected finder runtime, dispatches a
// real CDP input event (or the React-compatible native value setter for form
// fields), and stops with a precise reason on the first failure. It never
// re-reads the page to re-decide a step.
import { replayRuntimeSource } from '../core/finder-script.js';
import { CdpSession } from './cdp-session.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Substitute {{name}} from `variables` and {{SECRET:name}} from `secrets`.
function resolveValue(value, variables, secrets) {
  if (typeof value !== 'string') return value;
  const m = value.match(/^\{\{(.+)\}\}$/);
  if (!m) return value;
  const key = m[1];
  if (key.startsWith('SECRET:')) {
    const name = key.slice(7);
    const v = secrets.get(name);
    if (v == null) throw new Error('No secret stored for "' + name + '"');
    return v;
  }
  if (Object.prototype.hasOwnProperty.call(variables, key)) return variables[key];
  throw new Error('Missing variable "' + key + '"');
}

// A CSS selector for DOM.querySelector, derived from a finder. text:/xpath:/
// label:/col: finders are not CSS-selectable and return null.
function finderToCss(f) {
  if (f.type === 'id') return '[id="' + String(f.value).replace(/"/g, '\\"') + '"]';
  if (f.type === 'css') return f.value;
  return null;
}

export class Replayer extends CdpSession {
  constructor(targetWsUrl) {
    super(targetWsUrl);
  }

  _onNewContext(_frameId, contextId) {
    this._injectRuntime(contextId).catch(() => {});
  }

  async _injectRuntime(contextId) {
    await this.client.Runtime.evaluate({ expression: replayRuntimeSource(), contextId });
  }

  async _call(method, args, frameUrl) {
    const expr = `window.__rfReplay.${method}(${args.map((a) => JSON.stringify(a)).join(',')})`;
    return this.evaluate(expr, { frameUrl });
  }

  async _resolve(frameUrl, finders) {
    return this._call('resolve', [finders], frameUrl);
  }

  async run(skill, { variables = {}, secrets = new Map() } = {}) {
    // Fail fast on missing inputs instead of discovering them mid-replay.
    const missing = [];
    for (const v of skill.variables || []) {
      if (!Object.prototype.hasOwnProperty.call(variables, v)) missing.push(v);
    }
    for (const s of skill.secrets || []) {
      if (secrets.get(s) == null) missing.push('SECRET:' + s);
    }
    if (missing.length) {
      return { ok: false, reason: 'Missing variables/secrets: ' + missing.join(', ') };
    }

    try {
      await this.connect();
      for (const cid of [...this.contexts.values()]) await this._injectRuntime(cid).catch(() => {});
      const script = skill.script || [];
      // If the recording started on an already-loaded page (no leading navigate
      // step), land on the start URL first.
      if (skill.url && (!script.length || script[0].op !== 'navigate')) {
        await this.client.Page.navigate({ url: skill.url });
        await sleep(2500);
      }
      for (let i = 0; i < script.length; i++) {
        const step = script[i];
        const r = await this._runStep(step, skill, i, { variables, secrets });
        if (!r.ok) return { ok: false, failedAt: i, step, reason: r.reason };
      }
      return { ok: true, stepsRun: script.length };
    } finally {
      await this.close();
    }
  }

  async _runStep(step, skill, index, ctx) {
    try {
      switch (step.op) {
        case 'navigate': return await this._doNavigate(step, skill, index);
        case 'click': return await this._doClick(step);
        case 'type': return await this._doType(step, ctx);
        case 'select': return await this._doSelect(step, ctx);
        case 'hover': return await this._doHover(step);
        case 'scroll': return await this._doScroll(step);
        case 'press': return await this._doPress(step);
        case 'contextmenu': return await this._doContextMenu(step);
        case 'upload': return await this._doUpload(step, ctx);
        default: return { ok: false, reason: 'Unknown op: ' + step.op };
      }
    } catch (e) {
      return { ok: false, reason: String(e && e.message ? e.message : e) };
    }
  }

  // The iframe element's position in the top frame, for same-origin iframes.
  async _frameOffset(frameUrl) {
    try {
      return await this.evaluate(
        '(() => { try { const fe = window.frameElement; if (!fe) return null; const r = fe.getBoundingClientRect(); return { x: r.x, y: r.y }; } catch (e) { return null; } })()',
        { frameUrl },
      );
    } catch (e) {
      return null;
    }
  }

  async _waitForFinder(finders, frameUrl, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const r = await this._resolve(frameUrl, finders);
        if (r && r.found) return true;
      } catch (e) {}
      await sleep(250);
    }
    return false;
  }

  async _doNavigate(step, skill, index) {
    // Skip if this tab already sits on the URL (e.g. a new tab that the previous
    // click just opened and loaded).
    let already = false;
    try {
      const { frameTree } = await this.client.Page.getFrameTree();
      already = !!(frameTree.frame && frameTree.frame.url === step.value);
    } catch (e) {}
    if (!already) {
      await this.client.Page.navigate({ url: step.value });
      await sleep(step.wait || 3000);
    }
    // Post-navigation verification: wait for the next step's element to appear
    // instead of blindly clicking on after a fixed delay.
    const next = skill.script[index + 1];
    if (next && next.finders && next.finders.length) {
      const found = await this._waitForFinder(next.finders, next.frameUrl || '', 15000);
      if (!found) {
        return { ok: false, reason: 'After navigating to ' + step.value + ', the element expected by the next step did not appear' };
      }
    }
    return { ok: true };
  }

  async _doClick(step) {
    const frameUrl = step.frameUrl || '';
    const r = await this._resolve(frameUrl, step.finders);
    if (!r || !r.found) return { ok: false, reason: 'Element not found: ' + step.label };
    if (r.disabled) return { ok: false, reason: 'Element is disabled: ' + step.label };
    let cx = r.cx, cy = r.cy;
    const isMain = !frameUrl || frameUrl === (await this.mainFrameUrl());
    if (!isMain) {
      const off = await this._frameOffset(frameUrl);
      if (off) {
        cx = off.x + r.cx; cy = off.y + r.cy;
      } else {
        // Cross-origin iframe: fall back to a JS click.
        await this._call('click', [step.finders], frameUrl);
        await sleep(step.wait || 1200);
        return { ok: true };
      }
    }
    const { Input } = this.client;
    await Input.dispatchMouseEvent({ type: 'mouseMoved', x: cx, y: cy });
    await Input.dispatchMouseEvent({ type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
    await sleep(step.wait || 1200);
    return { ok: true };
  }

  async _doType(step, ctx) {
    const value = resolveValue(step.value, ctx.variables, ctx.secrets);
    const r = await this._call('setValue', [step.finders, value], step.frameUrl || '');
    if (!r || !r.found) return { ok: false, reason: 'Input not found: ' + step.label };
    await sleep(step.wait || 400);
    return { ok: true };
  }

  async _doSelect(step, ctx) {
    const value = resolveValue(step.value, ctx.variables, ctx.secrets);
    const r = await this._call('setSelect', [step.finders, value], step.frameUrl || '');
    if (!r || !r.found) return { ok: false, reason: 'Select not found: ' + step.label };
    await sleep(step.wait || 800);
    return { ok: true };
  }

  async _doHover(step) {
    const frameUrl = step.frameUrl || '';
    const r = await this._resolve(frameUrl, step.finders);
    if (!r || !r.found) return { ok: false, reason: 'Element not found: ' + step.label };
    let cx = r.cx, cy = r.cy;
    const isMain = !frameUrl || frameUrl === (await this.mainFrameUrl());
    if (!isMain) {
      const off = await this._frameOffset(frameUrl);
      if (off) {
        cx = off.x + r.cx; cy = off.y + r.cy;
      } else {
        await this._call('hover', [step.finders], frameUrl);
        await sleep(step.wait || 800);
        return { ok: true };
      }
    }
    await this.client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: cx, y: cy });
    await sleep(step.wait || 800);
    return { ok: true };
  }

  async _doScroll(step) {
    await this._call('scrollBy', [Number(step.value) || 500], step.frameUrl || '');
    await sleep(step.wait || 300);
    return { ok: true };
  }

  async _doPress(step) {
    const key = step.value || 'Enter';
    const code = key === 'Enter' ? 'Enter' : key;
    const vk = key === 'Enter' ? 13 : 0;
    const { Input } = this.client;
    await Input.dispatchKeyEvent({ type: 'keyDown', key, code, windowsVirtualKeyCode: vk });
    await Input.dispatchKeyEvent({ type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
    await sleep(600);
    return { ok: true };
  }

  async _doContextMenu(step) {
    const frameUrl = step.frameUrl || '';
    const r = await this._resolve(frameUrl, step.finders);
    if (!r || !r.found) return { ok: false, reason: 'Element not found: ' + step.label };
    let cx = r.cx, cy = r.cy;
    const isMain = !frameUrl || frameUrl === (await this.mainFrameUrl());
    if (!isMain) {
      const off = await this._frameOffset(frameUrl);
      if (off) { cx = off.x + r.cx; cy = off.y + r.cy; }
    }
    const { Input } = this.client;
    await Input.dispatchMouseEvent({ type: 'mouseMoved', x: cx, y: cy });
    await Input.dispatchMouseEvent({ type: 'mousePressed', x: cx, y: cy, button: 'right', clickCount: 1 });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x: cx, y: cy, button: 'right', clickCount: 1 });
    await sleep(step.wait || 600);
    return { ok: true };
  }

  async _doUpload(step, ctx) {
    const value = resolveValue(step.value, ctx.variables, ctx.secrets);
    const files = String(value).split(',').map((s) => s.trim()).filter(Boolean);
    if (!files.length) return { ok: false, reason: 'Upload needs a file path; recorded value: ' + (step.value || '(none)') };
    const { DOM } = this.client;
    // DOM.requestNode (objectId -> nodeId) is unreliable in some Chrome builds;
    // resolve a CSS selector from the finders and use getDocument+querySelector.
    let nodeId = null;
    for (const f of (step.finders || [])) {
      const sel = finderToCss(f);
      if (!sel) continue;
      try {
        const { root } = await DOM.getDocument();
        const r = await DOM.querySelector({ nodeId: root.nodeId, selector: sel });
        if (r.nodeId) { nodeId = r.nodeId; break; }
      } catch (e) {}
    }
    if (nodeId == null) return { ok: false, reason: 'File input not found: ' + step.label };
    await DOM.setFileInputFiles({ files, nodeId });
    await sleep(step.wait || 800);
    return { ok: true };
  }
}
