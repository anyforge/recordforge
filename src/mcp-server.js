// src/mcp-server.js
//
// The MCP surface. Registers recordforge's operations as tools with typed
// schemas so any MCP-capable agent (Claude Code, Codex, Hermes, Cline, ...)
// discovers and calls them without per-agent glue.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const err = (message) => ({ content: [{ type: 'text', text: String(message) }], isError: true });

export function createMcpServer(forge) {
  const server = new McpServer({ name: 'recordforge', version: pkg.version });

  server.tool(
    'record_start',
    'Start recording browser actions. Attaches to a running Chromium browser (pass cdp_url) or launches a fresh Chrome. Returns a recording_id used by record_stop. While recording, have the user perform the workflow in the browser.',
    { cdp_url: z.string().optional(), name: z.string().optional() },
    async (args) => {
      try { return ok(await forge.recordStart({ cdpUrl: args.cdp_url, name: args.name })); }
      catch (e) { return err(e.message); }
    },
  );

  server.tool(
    'record_stop',
    'Stop the recording identified by recording_id, save it to disk, and return the recording plus its file path. Pass the path to compile next.',
    { recording_id: z.string() },
    async (args) => {
      try {
        const r = await forge.recordStop(args.recording_id);
        if (!r.ok) return err(r.error);
        const saved = await import('./store/recordings.js').then((m) => m.saveRecording(r.recording));
        return ok({ recording: r.recording, path: saved.path });
      } catch (e) { return err(e.message); }
    },
  );

  server.tool(
    'record_cancel',
    'Discard the recording identified by recording_id without saving.',
    { recording_id: z.string() },
    async (args) => {
      try { return ok(await forge.recordCancel(args.recording_id)); }
      catch (e) { return err(e.message); }
    },
  );

  server.tool(
    'compile',
    'Compile a saved recording file into a deterministic replay skill. Returns the skill (with parameterized variables and secrets) and a learn_prompt you may use to optionally improve the description and variable names before replaying.',
    { recording_file: z.string(), name: z.string().optional(), description: z.string().optional() },
    async (args) => {
      try {
        return ok(forge.compileFile(args.recording_file, { name: args.name, description: args.description }));
      } catch (e) { return err(e.message); }
    },
  );

  server.tool(
    'replay',
    'Replay a compiled skill deterministically. Pass variables to fill {{name}} placeholders. Secrets ({{SECRET:name}}) are resolved from the local secret store, not from variables. Stops on the first failed step and reports exactly which step and why.',
    {
      skill_file: z.string(),
      variables: z.record(z.string(), z.string()).optional(),
      cdp_url: z.string().optional(),
      headless: z.boolean().optional(),
    },
    async (args) => {
      try {
        const skill = await import('./store/recordings.js').then((m) => m.loadJson(args.skill_file));
        const result = await forge.replay(skill, {
          variables: args.variables || {},
          cdpUrl: args.cdp_url,
          headless: !!args.headless,
        });
        return ok(result);
      } catch (e) { return err(e.message); }
    },
  );

  server.tool(
    'emit',
    'Emit a portable Agent Skill from a compiled skill file: a universal SKILL.md (loadable by Hermes, Claude Code, Codex, Pi, OpenClaw) plus a per-agent install guide (README.md) and the replay payload (skill.json). Returns the generated SKILL.md text and file paths.',
    { skill_file: z.string(), name: z.string().optional(), out_dir: z.string().optional() },
    async (args) => {
      try {
        return ok(forge.emit(args.skill_file, { outDir: args.out_dir, name: args.name }));
      } catch (e) { return err(e.message); }
    },
  );

  server.tool(
    'list',
    'List saved recordings and compiled skills.',
    {},
    async () => {
      try { return ok(forge.list()); }
      catch (e) { return err(e.message); }
    },
  );

  server.tool(
    'secret_set',
    'Store a secret in the local store for resolving {{SECRET:name}} at replay time. NOTE: the value transits this MCP channel; for secrets you must not expose, prefer the CLI `recordforge secret set <name>` which prompts with input masked.',
    { name: z.string(), value: z.string() },
    async (args) => {
      try { return ok(forge.secretSet(args.name, args.value)); }
      catch (e) { return err(e.message); }
    },
  );

  server.tool(
    'secret_list',
    'List stored secret names (values are never returned).',
    {},
    async () => {
      try { return ok(forge.secretList()); }
      catch (e) { return err(e.message); }
    },
  );

  server.tool(
    'secret_delete',
    'Delete a stored secret by name.',
    { name: z.string() },
    async (args) => {
      try { return ok(forge.secretDelete(args.name)); }
      catch (e) { return err(e.message); }
    },
  );

  return server;
}
