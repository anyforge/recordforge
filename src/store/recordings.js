// src/store/recordings.js
//
// Persistence for raw recordings and compiled skills, under the data dir:
//   ~/.recordforge/recordings/<name>-<timestamp>.json
//   ~/.recordforge/skills/<name>.json
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './secrets.js';

const recordingsDir = () => path.join(DATA_DIR, 'recordings');
const skillsDir = () => path.join(DATA_DIR, 'skills');

const slugify = (s) =>
  String(s || '').toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow';

const timestamp = () => new Date().toISOString().replace(/[:.]/g, '-');

export function saveRecording(recording, { name } = {}) {
  mkdirSync(recordingsDir(), { recursive: true });
  const file = `${slugify(name)}-${timestamp()}.json`;
  const p = path.join(recordingsDir(), file);
  writeFileSync(p, JSON.stringify(recording, null, 2));
  return { path: p, file };
}

export function saveSkill(skill, { name } = {}) {
  mkdirSync(skillsDir(), { recursive: true });
  const file = `${slugify(name || skill.name)}.json`;
  const p = path.join(skillsDir(), file);
  writeFileSync(p, JSON.stringify(skill, null, 2));
  return { path: p, file };
}

export function loadJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function listRecordings() {
  const dir = recordingsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
}

export function listSkills() {
  const dir = skillsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
}

export { recordingsDir as recordingsPath, skillsDir as skillsPath };
