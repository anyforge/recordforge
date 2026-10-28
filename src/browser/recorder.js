// src/browser/recorder.js
//
// Recording engine. Attaches to one page target, injects the capture script
// into every frame (existing and future, including dynamic iframes), and
// collects steps in real time through a CDP binding so a click that navigates
// never loses its step.
import { captureScriptSource } from '../core/capture-script.js';
import { CdpSession } from './cdp-session.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Recorder extends CdpSession {
  constructor(targetWsUrl, targetId = null) {
    super(targetWsUrl);
    this.targetId = targetId;
    this.steps = [];
    this.startedAt = null;
    this.startUrl = '';
    this._mainUrl = '';
    this._bindingReady = false;
    this._pendingContexts = [];
    this._lastNavUrl = '';
  }

  _onNewContext(_frameId, contextId) {
    if (this._bindingReady) {
      this._injectCapture(contextId).catch(() => {});
    } else {
      this._pendingContexts.push(contextId);
    }
  }

  async _injectCapture(contextId) {
    await this.client.Runtime.evaluate({ expression: captureScriptSource(), contextId });
  }

  async start() {
    await this.connect();

    // Steps arrive immediately through this binding.
    this.client.on('Runtime.bindingCalled', (p) => {
      try {
        const arr = JSON.parse(p.payload);
        if (Array.isArray(arr)) {
          for (const s of arr) {
            s.tabUrl = this._mainUrl;
            if (this.targetId) s.targetId = this.targetId;
          }
          this.steps.push(...arr);
        }
      } catch (e) {}
    });

    // Main-frame navigation becomes a `navigate` step; iframe navigation just
    // re-triggers injection (handled by executionContextCreated).
    this.client.on('Page.frameNavigated', (p) => {
      const frame = p.frame;
      if (!frame) return;
      const isMain = frame.parentId === undefined || frame.parentId === null || frame.parentId === '';
      if (!isMain) return;
      const url = frame.url || '';
      if (url) this._mainUrl = url;
      if (url && url !== 'about:blank' && !url.startsWith('data:') && url !== this._lastNavUrl) {
        this._lastNavUrl = url;
        this.steps.push({ action: 'navigate', url, ts: Date.now(), transition: '', tabUrl: url, targetId: this.targetId || undefined });
      }
    });

    // Register the binding BEFORE injecting, so the script can push immediately.
    await this.client.Runtime.addBinding({ name: '__recordforgePush' });
    this._bindingReady = true;

    try {
      const { frameTree } = await this.client.Page.getFrameTree();
      this.startUrl = frameTree.frame ? frameTree.frame.url : '';
      this._mainUrl = this.startUrl;
    } catch (e) {}

    // Inject into every context discovered while the binding was not ready.
    for (const cid of this._pendingContexts.splice(0)) {
      await this._injectCapture(cid).catch(() => {});
    }

    this.startedAt = new Date().toISOString();
    return { started: true, startUrl: this.startUrl };
  }

  async stop() {
    await sleep(150); // let in-flight binding deliveries land
    const steps = this.steps.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const recording = {
      version: 1,
      started_at: this.startedAt || new Date().toISOString(),
      url: this.startUrl || (steps.length ? steps[0].url : ''),
      steps,
    };
    await this.close();
    return recording;
  }

  async cancel() {
    await this.close();
  }
}
