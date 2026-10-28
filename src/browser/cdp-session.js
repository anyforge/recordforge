// src/browser/cdp-session.js
//
// A thin CDP session wrapper shared by the recorder and replayer. It tracks
// frame -> execution-context mapping and provides frame-aware evaluation, so a
// step recorded inside an iframe can be replayed in that same frame.
import CDP from 'chrome-remote-interface';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CdpSession {
  constructor(targetWsUrl) {
    this.targetWsUrl = targetWsUrl;
    this.client = null;
    this.contexts = new Map(); // frameId -> default executionContextId
  }

  // Hook for subclasses: called when a new frame default context appears.
  _onNewContext(_frameId, _contextId) {}

  _onCtxCreated(p) {
    const ctx = p.context;
    if (ctx && ctx.auxData && ctx.auxData.isDefault && ctx.auxData.frameId) {
      this.contexts.set(ctx.auxData.frameId, ctx.id);
      this._onNewContext(ctx.auxData.frameId, ctx.id);
    }
  }

  _onCtxDestroyed(p) {
    for (const [fid, cid] of this.contexts) {
      if (cid === p.executionContextId) { this.contexts.delete(fid); break; }
    }
  }

  async connect() {
    this.client = await CDP({ target: this.targetWsUrl });
    this.client.on('Runtime.executionContextCreated', (p) => this._onCtxCreated(p));
    this.client.on('Runtime.executionContextDestroyed', (p) => this._onCtxDestroyed(p));
    await this.client.Page.enable();
    await this.client.Runtime.enable();
    await sleep(60); // let the initial executionContextCreated events settle
  }

  // Resolve the execution context for a frame. `frameUrl` empty -> main frame.
  async contextIdForFrame(frameUrl) {
    const { frameTree } = await this.client.Page.getFrameTree();
    const frames = [];
    const walk = (n) => { frames.push(n.frame); (n.childFrames || []).forEach(walk); };
    walk(frameTree);
    const mainId = frameTree.frame ? frameTree.frame.id : null;
    if (!frameUrl) return this.contexts.get(mainId) || null;
    let f = frames.find((x) => x.url === frameUrl);
    if (!f) f = frames.find((x) => x.url && (x.url.startsWith(frameUrl) || frameUrl.startsWith(x.url)));
    if (!f) return this.contexts.get(mainId) || null; // fall back to main frame
    return this.contexts.get(f.id) || null;
  }

  // The current main (top) frame URL of this tab.
  async mainFrameUrl() {
    const { frameTree } = await this.client.Page.getFrameTree();
    return frameTree.frame ? frameTree.frame.url : '';
  }

  // Evaluate an expression in a frame and return its value.
  async evaluate(expression, { frameUrl = '', returnByValue = true } = {}) {
    const contextId = await this.contextIdForFrame(frameUrl);
    if (!contextId) throw new Error('No execution context for frame: ' + (frameUrl || '(main)'));
    const res = await this.client.Runtime.evaluate({ expression, contextId, returnByValue, awaitPromise: true });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      const msg = d.exception ? (d.exception.description || d.exception.value) : (d.text || 'evaluation failed');
      throw new Error('Evaluation failed: ' + msg);
    }
    return res.result.value;
  }

  async close() {
    try { await this.client.close(); } catch (e) {}
  }
}
