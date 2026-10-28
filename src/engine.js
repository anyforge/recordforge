// src/engine.js
//
// The RecordForge facade: one object that owns active recording sessions and
// exposes record / compile / replay / secret operations. Both the MCP server
// and the CLI drive this; neither touches CDP or the store directly.
import { randomUUID } from 'node:crypto';
import { resolveTarget } from './browser/chrome.js';
import { MultiTabRecorder, MultiTabReplayer } from './browser/multi-tab.js';
import { compile } from './core/compiler.js';
import { emit as emitSkill } from './core/emitter.js';
import { saveRecording, saveSkill, loadJson, listRecordings, listSkills } from './store/recordings.js';
import { getSecret, setSecret, deleteSecret, listSecrets, secretsAsMap } from './store/secrets.js';

export class RecordForge {
  constructor() {
    this.active = new Map(); // id -> { recorder, target }
  }

  async recordStart({ cdpUrl, name } = {}) {
    const target = await resolveTarget({ cdpUrl });
    const recorder = new MultiTabRecorder(target.endpoint);
    const info = await recorder.start();
    const id = randomUUID();
    this.active.set(id, { recorder, target });
    return { id, started: true, startUrl: (info.tabs && info.tabs[0]) || '', name: name || '' };
  }

  async recordStop(id) {
    const session = this.active.get(id);
    if (!session) return { ok: false, error: 'no active recording: ' + id };
    this.active.delete(id);
    const recording = await session.recorder.stop();
    this._kill(session);
    return { ok: true, recording };
  }

  async recordCancel(id) {
    const session = this.active.get(id);
    if (!session) return { ok: false, error: 'no active recording: ' + id };
    this.active.delete(id);
    await session.recorder.cancel();
    this._kill(session);
    return { ok: true };
  }

  // Stop + save a recording in one call (for MCP / dsh tools).
  async recordStopAndSave(id) {
    const r = await this.recordStop(id);
    if (!r.ok) return r;
    const saved = saveRecording(r.recording);
    return { ok: true, recording: r.recording, path: saved.path };
  }

  _kill(session) {
    if (session.target && session.target.child) {
      try { session.target.child.kill(); } catch (e) {}
    }
  }

  compile(recording, { name, description } = {}) {
    return compile(recording, { name, description });
  }

  async replay(skill, { variables = {}, secrets = null, cdpUrl, headless = false } = {}) {
    const secretMap = secrets || secretsAsMap();
    const target = await resolveTarget({ cdpUrl, headless });
    const replayer = new MultiTabReplayer(target.endpoint);
    try {
      return await replayer.run(skill, { variables, secrets: secretMap });
    } finally {
      if (target.child) { try { target.child.kill(); } catch (e) {} }
    }
  }

  // Replay a skill from a file path.
  async replayFile(skillFile, { variables, secrets, cdpUrl, headless } = {}) {
    const skill = loadJson(skillFile);
    return this.replay(skill, { variables, secrets, cdpUrl, headless });
  }

  // Convenience: compile a recording file from disk and save the skill.
  compileFile(recordingFile, { name, description } = {}) {
    const recording = loadJson(recordingFile);
    const { skill, learnPrompt } = compile(recording, { name, description });
    const saved = saveSkill(skill, { name: name || skill.name });
    return { skill, skillPath: saved.path, learnPrompt };
  }

  // Emit a portable Agent Skill bundle from a compiled skill file.
  emit(skillFile, { outDir, name } = {}) {
    const skill = loadJson(skillFile);
    return emitSkill(skill, { outDir, name: name || skill.name });
  }

  list() {
    return { recordings: listRecordings(), skills: listSkills() };
  }

  // Secret store passthroughs.
  secretGet(name) { return getSecret(name); }
  secretSet(name, value) { return setSecret(name, value); }
  secretDelete(name) { return deleteSecret(name); }
  secretList() { return listSecrets(); }
}
