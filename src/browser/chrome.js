// src/browser/chrome.js
//
// Locate, launch and attach to a Chromium-family browser. Two modes:
//   - attach: a `cdpUrl` points at a browser already running with
//     --remote-debugging-port; the first page target is used.
//   - launch: spawn our own Chrome (headed, temp user-data-dir) with a fresh
//     debugging port.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Find an installed Chromium-family binary.
export function findChrome() {
  const candidates = [];
  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    );
  } else if (process.platform === 'linux') {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/snap/bin/chromium',
    );
  } else if (process.platform === 'win32') {
    candidates.push(
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
    );
  }
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

async function waitForEndpoint(endpoint, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(endpoint + '/json/version');
      if (res.ok) return;
    } catch (e) {}
    await sleep(150);
  }
  throw new Error('Chrome did not open a debugging port in time at ' + endpoint);
}

// Launch a fresh Chrome instance with a debugging port and a throwaway profile.
export async function launchChrome({ port = 9222, headless = false } = {}) {
  const binary = findChrome();
  if (!binary) {
    throw new Error('No Chromium-family browser found. Install Chrome/Chromium/Edge or pass --cdp to attach to a running browser.');
  }
  const userDataDir = path.join(os.tmpdir(), 'recordforge-' + Date.now());
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');
  // On CI (and in containers) the sandbox and /dev/shm are often unavailable.
  if (process.env.CI) args.unshift('--no-sandbox', '--disable-dev-shm-usage');
  const child = spawn(binary, args, { stdio: 'ignore' });
  child.unref();
  const endpoint = `http://127.0.0.1:${port}`;
  await waitForEndpoint(endpoint, 15000);
  return { child, endpoint, userDataDir };
}

// List page (tab) targets at a browser endpoint.
export async function listPageTargets(endpoint) {
  const res = await fetch(endpoint + '/json');
  if (!res.ok) throw new Error('Cannot reach CDP endpoint ' + endpoint);
  const list = await res.json();
  return list.filter((t) => t.type === 'page');
}

// Bring a page target's tab to the front via the HTTP endpoint.
export async function activateTarget(endpoint, targetId) {
  await fetch(`${endpoint}/json/activate/${encodeURIComponent(targetId)}`);
}

// Resolve a recording/replay target: attach to the first page of an existing
// browser, or launch a fresh one. Returns { endpoint, targetWsUrl, child }.
export async function resolveTarget({ cdpUrl, headless = false } = {}) {
  if (cdpUrl) {
    const targets = await listPageTargets(cdpUrl);
    if (!targets.length) throw new Error('No page targets found at ' + cdpUrl);
    return { endpoint: cdpUrl, targetWsUrl: targets[0].webSocketDebuggerUrl, child: null };
  }
  const { child, endpoint } = await launchChrome({ headless });
  const targets = await listPageTargets(endpoint);
  if (!targets.length) throw new Error('Launched Chrome but found no page target');
  return { endpoint, targetWsUrl: targets[0].webSocketDebuggerUrl, child };
}
