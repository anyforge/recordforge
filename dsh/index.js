// dsh/index.js — DeepSeek Harness plugin: recordforge as native dsh tools.
//
// Registers record / compile / emit / replay / list as dsh tools backed by the
// recordforge engine, so a dsh agent can record and replay browser workflows
// without a shell. Secrets resolve from the local recordforge store — they
// never enter the recording, the skill, or the conversation.
import { defineTool } from '@deepseek-ai/dsh-tools'
import { RecordForge } from '@anyforgex/recordforge'

export const name = 'recordforge'
export const inject = ['tools']

// One engine instance lives for the lifetime of the plugin, so an active
// recording session survives across tool calls (mirrors the MCP server).
const forge = new RecordForge()

const text = (v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }]
const objectOut = { schema: { type: 'object' }, render: (_args, v) => text(v) }

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'recordforge_record_start',
    description: 'Start recording browser actions (attach to a running Chromium via cdp_url, or launch a fresh Chrome). Returns a recording_id for recordforge_record_stop.',
    parameters: {
      cdp_url: { type: 'string', required: false, description: 'CDP endpoint, e.g. http://127.0.0.1:9222' },
      name: { type: 'string', required: false, description: 'Workflow name' },
    },
    output: objectOut,
    async execute(args) {
      return forge.recordStart({ cdpUrl: args.cdp_url, name: args.name })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'recordforge_record_stop',
    description: 'Stop the recording, save it, and return the recording plus its file path.',
    parameters: {
      recording_id: { type: 'string', required: true, description: 'id from recordforge_record_start' },
    },
    output: objectOut,
    async execute(args) {
      const r = await forge.recordStopAndSave(args.recording_id)
      if (!r.ok) throw new Error(r.error)
      return r
    },
  }))

  ctx.tools.register(defineTool({
    name: 'recordforge_compile',
    description: 'Compile a saved recording into a deterministic replay skill (parameterized variables, secrets routed to the store).',
    parameters: {
      recording_file: { type: 'string', required: true, description: 'path to the recording JSON' },
      name: { type: 'string', required: false, description: 'skill name' },
    },
    output: objectOut,
    async execute(args) {
      return forge.compileFile(args.recording_file, { name: args.name })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'recordforge_emit',
    description: 'Emit a portable Agent Skill (SKILL.md + per-agent install guide) from a compiled skill file.',
    parameters: {
      skill_file: { type: 'string', required: true, description: 'path to the compiled skill JSON' },
      name: { type: 'string', required: false },
      out_dir: { type: 'string', required: false },
    },
    output: objectOut,
    async execute(args) {
      return forge.emit(args.skill_file, { name: args.name, outDir: args.out_dir })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'recordforge_replay',
    description: 'Replay a compiled skill deterministically. Secrets resolve from the local store; pass variables for {{name}} placeholders.',
    parameters: {
      skill_file: { type: 'string', required: true, description: 'path to the compiled skill JSON' },
      variables: { type: 'object', required: false, description: 'map of placeholder -> value' },
      cdp_url: { type: 'string', required: false, description: 'attach to a running Chromium instead of launching' },
    },
    output: objectOut,
    async execute(args) {
      return forge.replayFile(args.skill_file, { variables: args.variables || {}, cdpUrl: args.cdp_url })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'recordforge_list',
    description: 'List saved recordings and compiled skills.',
    parameters: {},
    output: objectOut,
    async execute() {
      return forge.list()
    },
  }))
}
