// src/store/secrets.js
//
// Local, plain-text secret store used to resolve {{SECRET:name}} placeholders
// at replay time. The value never enters the recording, the skill, or the agent
// conversation. v1 keeps it simple: a mode-0600 JSON file under the data dir,
// documented as "unencrypted, this machine only". An OS-keyring backend is a
// future option.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DATA_DIR = process.env.RECORDFORGE_HOME || path.join(os.homedir(), '.recordforge');

const secretsPath = () => path.join(DATA_DIR, 'secrets.json');

function load() {
  const p = secretsPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    return {};
  }
}

function save(map) {
  const p = secretsPath();
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(map, null, 2), { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch (e) {}
}

export function getSecret(name) {
  const v = load()[name];
  return v == null ? null : String(v);
}

export function setSecret(name, value) {
  if (!name || !value) return { ok: false, error: 'name and value are required' };
  const map = load();
  map[name] = String(value);
  save(map);
  return { ok: true };
}

export function deleteSecret(name) {
  const map = load();
  if (!(name in map)) return { ok: false, error: 'secret not found: ' + name };
  delete map[name];
  save(map);
  return { ok: true };
}

export function listSecrets() {
  return Object.keys(load()).map((name) => ({ name, value: '[REDACTED]' }));
}

// A Map snapshot for the replayer.
export function secretsAsMap() {
  return new Map(Object.entries(load()));
}
