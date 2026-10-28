// src/cli.js
//
// The recordforge command line. Thin wrapper over RecordForge for humans and
// for agents that only have a shell.
import readline from 'node:readline';
import { RecordForge } from './engine.js';
import { saveRecording, loadJson } from './store/recordings.js';

const USAGE = `recordforge — record browser workflows and replay them deterministically.

Usage:
  recordforge record [--cdp URL] [--name N] [--headless]
      Record the active browser tab (or launch a fresh Chrome). Press Ctrl-C to stop and save.

  recordforge compile <recording.json> [--name N]
      Compile a recording into a deterministic replay skill and save it.

  recordforge emit <skill.json> [--name N] [--out DIR]
      Emit a portable Agent Skill (SKILL.md + install guide) for Hermes,
      Claude Code, Codex, Pi, OpenClaw and DeepSeek Harness.

  recordforge replay <skill.json> [--cdp URL] [--headless] [KEY=VALUE ...]
      Replay a compiled skill, filling {{name}} placeholders from KEY=VALUE pairs.

  recordforge list
      List saved recordings and skills.

  recordforge secret set <name>       Store a secret (prompts with input masked)
  recordforge secret list             List stored secret names
  recordforge secret delete <name>    Delete a stored secret
`;

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args.flags[key] = next; i++; }
      else args.flags[key] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function parseVars(pairs) {
  const vars = {};
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i > 0) vars[p.slice(0, i)] = p.slice(i + 1);
  }
  return vars;
}

function promptSecret(label) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    rl.question(label, (ans) => { resolve(ans); rl.close(); });
    // Mask the typed value.
    rl._writeToOutput = function _writeToOutput() { rl.output.write('*'); };
  });
}

async function cmdRecord(forge, args) {
  const res = await forge.recordStart({ cdpUrl: args.flags.cdp, name: args.flags.name });
  console.log(`Recording started on ${res.startUrl} (id ${res.id.slice(0, 8)})`);
  console.log('Do the workflow in the browser, then press Ctrl-C here to stop and save.');
  const stop = async () => {
    try {
      const r = await forge.recordStop(res.id);
      if (!r.ok) { console.error('Error stopping: ' + r.error); process.exit(1); }
      const saved = saveRecording(r.recording, { name: args.flags.name });
      console.log(`\nSaved ${r.recording.steps.length} steps -> ${saved.path}`);
      console.log(`Next: recordforge compile "${saved.path}" ${args.flags.name ? '--name ' + args.flags.name : ''}`);
    } catch (e) {
      console.error('Error stopping: ' + e.message);
    }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise(() => {}); // stay alive until Ctrl-C
}

async function cmdCompile(forge, args) {
  const file = args._[1];
  if (!file) { console.error('Missing recording file'); process.exit(1); }
  const { skill, skillPath, learnPrompt } = forge.compileFile(file, { name: args.flags.name });
  console.log(`Compiled skill -> ${skillPath}`);
  console.log(`Variables: ${JSON.stringify(skill.variables)}`);
  console.log(`Secrets: ${JSON.stringify(skill.secrets)}`);
  console.log(`Steps: ${skill.script.length}`);
  console.log('\n--- learn prompt (optional, for the host agent) ---');
  console.log(learnPrompt);
}

async function cmdEmit(forge, args) {
  const file = args._[1];
  if (!file) { console.error('Missing skill file'); process.exit(1); }
  const r = forge.emit(file, { outDir: args.flags.out, name: args.flags.name });
  console.log(`Emitted "${r.name}" -> ${r.dir}`);
  for (const f of r.files) console.log('  ' + f);
  console.log('Copy SKILL.md into the target agent\'s skills directory (see README.md in the bundle).');
}

async function cmdReplay(forge, args) {
  const file = args._[1];
  if (!file) { console.error('Missing skill file'); process.exit(1); }
  const skill = loadJson(file);
  const variables = parseVars(args._.slice(2));
  const result = await forge.replay(skill, { variables, cdpUrl: args.flags.cdp, headless: !!args.flags.headless });
  if (result.ok) {
    console.log(`Replay OK — ${result.stepsRun} steps.`);
  } else {
    console.error(`Replay FAILED at step ${result.failedAt} (${result.step && result.step.op}): ${result.reason}`);
    process.exit(1);
  }
}

async function cmdList(forge) {
  const { recordings, skills } = forge.list();
  console.log('Recordings:');
  for (const r of recordings) console.log('  ' + r);
  console.log('Skills:');
  for (const s of skills) console.log('  ' + s);
}

async function cmdSecret(forge, args) {
  const sub = args._[1];
  if (sub === 'set') {
    const name = args._[2];
    if (!name) { console.error('Missing secret name'); process.exit(1); }
    const value = await promptSecret('Value for "' + name + '": ');
    const r = forge.secretSet(name, value);
    console.log(r.ok ? 'Stored.' : 'Error: ' + r.error);
  } else if (sub === 'list') {
    for (const s of forge.secretList()) console.log('  ' + s.name);
  } else if (sub === 'delete') {
    const r = forge.secretDelete(args._[2]);
    console.log(r.ok ? 'Deleted.' : 'Error: ' + r.error);
  } else {
    console.error('Unknown secret subcommand. Use: set | list | delete');
    process.exit(1);
  }
}

export async function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  const forge = new RecordForge();
  try {
    switch (cmd) {
      case 'record': return await cmdRecord(forge, args);
      case 'compile': return await cmdCompile(forge, args);
      case 'emit': return await cmdEmit(forge, args);
      case 'replay': return await cmdReplay(forge, args);
      case 'list': return await cmdList(forge);
      case 'secret': return await cmdSecret(forge, args);
      case 'help':
      case undefined:
      default:
        console.log(USAGE);
        if (cmd && cmd !== 'help') process.exit(1);
    }
  } finally {
    // nothing to clean up here; RecordForge sessions die with the process
  }
}
