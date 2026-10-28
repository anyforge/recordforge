// src/core/emitter.js
//
// Turn a compiled skill into a portable, agent-native skill bundle:
//   - SKILL.md      universal Agent Skills spec file (frontmatter name+description)
//   - skill.json    the deterministic replay payload
//   - README.md     per-agent install + MCP wiring for the six supported agents
//
// Hermes, Claude Code, Codex, Pi and OpenClaw all load a `SKILL.md` with the
// same frontmatter convention; DeepSeek Harness is plugin-based (Cordis) and is
// covered via MCP / AGENTS.md with a native plugin left as a follow-up.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO_URL = 'https://github.com/anyforge/recordforge';

export function skillName(name) {
  return String(name || 'workflow').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow';
}

function renderStep(s, i) {
  const n = i + 1;
  const label = s.label || s.selector || '';
  switch (s.op) {
    case 'navigate': return `${n}. Open ${s.value}`;
    case 'click': return `${n}. Click "${label}"`;
    case 'type': return `${n}. Type ${s.value} into "${label}"`;
    case 'hover': return `${n}. Hover "${label}"`;
    case 'select': return `${n}. Select "${s.value}" in "${label}"`;
    case 'scroll': return `${n}. Scroll ${s.value || 0}px`;
    case 'press': return `${n}. Press ${s.value || 'Enter'}`;
    case 'upload': return `${n}. Upload file(s): ${s.value || ''}`;
    case 'contextmenu': return `${n}. Right-click "${label}"`;
    default: return `${n}. ${s.op} ${label}`;
  }
}

export function buildSkillMarkdown(skill, opts = {}) {
  const name = skillName(opts.name || skill.name);
  const description = skill.description
    ? `Use when the user wants to ${skill.description}. Replays a recorded browser workflow via recordforge.`
    : `Use when the user asks to run the "${name}" workflow. Replays a recorded browser workflow via recordforge.`;
  const examples = skill.variableExamples || {};
  const vars = skill.variables || [];
  const secrets = skill.secrets || [];

  const L = [];
  L.push('---');
  L.push('name: ' + name);
  L.push('description: ' + JSON.stringify(description));
  L.push('---');
  L.push('');
  L.push('# ' + name);
  L.push('');
  L.push(`Replays the recorded "${name}" browser workflow (captured by [RecordForge](${REPO_URL})). Deterministic: no page re-reading, no per-step re-deciding.`);
  L.push('');

  if (vars.length) {
    L.push('## Variables');
    L.push('');
    L.push('Ask the user for these at replay time. Recorded examples are shown for reference only — never replay the example verbatim unless the user confirms it.');
    L.push('');
    L.push('| Variable | Recorded example |');
    L.push('|---|---|');
    for (const v of vars) {
      const ex = examples[v] !== undefined ? String(examples[v]).replace(/\|/g, '\\|').replace(/\n/g, ' ') : '';
      L.push('| `' + v + '` | ' + (ex ? '`' + ex + '`' : '—') + ' |');
    }
    L.push('');
  }

  if (secrets.length) {
    L.push('## Secrets');
    L.push('');
    L.push('Resolved automatically from the local RecordForge secret store. Never ask the user to paste them into chat, and never write them into this skill.');
    L.push('');
    for (const s of secrets) L.push('- `' + s + '`');
    L.push('');
  }

  L.push('## How to replay');
  L.push('');
  L.push('Replay the `skill.json` shipped next to this SKILL.md.');
  L.push('');
  L.push('Via the recordforge CLI:');
  L.push('');
  L.push('```bash');
  const cliArgs = vars.length ? ' ' + vars.map((v) => v + '=<value>').join(' ') : '';
  L.push('recordforge replay <path-to>/skill.json' + cliArgs);
  L.push('```');
  L.push('');
  L.push('Or via the recordforge MCP `replay` tool (`skill_file` + `variables`).');
  L.push('');

  L.push('## Steps');
  L.push('');
  L.push((skill.script || []).map(renderStep).join('\n'));
  L.push('');
  return L.join('\n');
}

export function buildInstallGuide(skill, opts = {}) {
  const name = skillName(opts.name || skill.name);
  const mcpStdio = '"command": "recordforge-mcp"';
  const L = [];
  L.push('# Installing "' + name + '"');
  L.push('');
  L.push('This bundle is a universal **Agent Skill** — a `SKILL.md` with `name` + `description` frontmatter, loadable by every agent that implements the Agent Skills spec: **Hermes, Claude Code, Codex, Pi, OpenClaw**, and (via MCP/AGENTS.md) **DeepSeek Harness**.');
  L.push('');
  L.push('Replay itself runs through the `recordforge` CLI or MCP server.');
  L.push('');
  L.push('Install recordforge first: `npm install -g @anyforgex/recordforge`.');
  L.push('');

  L.push('### Hermes');
  L.push('```bash');
  L.push(`mkdir -p ~/.hermes/skills/${name}`);
  L.push(`cp SKILL.md skill.json ~/.hermes/skills/${name}/`);
  L.push('```');
  L.push('Wire recordforge as MCP: `hermes mcp add recordforge -- recordforge-mcp` (from a source checkout: `-- node /abs/path/to/recordforge/src/index.js`)');
  L.push('');

  L.push('### Claude Code');
  L.push('```bash');
  L.push(`mkdir -p ~/.claude/skills/${name}   # or .claude/skills/${name} for a project`);
  L.push(`cp SKILL.md skill.json ~/.claude/skills/${name}/`);
  L.push('```');
  L.push(`MCP: add \`{"mcpServers":{"recordforge":{${mcpStdio}}}}\` to \`.mcp.json\`.`);
  L.push('');

  L.push('### Codex');
  L.push('Reference in `~/.codex/config.toml`:');
  L.push('```toml');
  L.push('[[skills.config]]');
  L.push(`path = "/abs/path/to/${name}/SKILL.md"`);
  L.push('```');
  L.push('MCP: `[mcp_servers.recordforge]` with `command = "recordforge-mcp"`.');
  L.push('');

  L.push('### Pi');
  L.push('```bash');
  L.push(`mkdir -p ~/.pi/agent/skills/${name}   # or .pi/skills/${name} for a project`);
  L.push(`cp SKILL.md skill.json ~/.pi/agent/skills/${name}/`);
  L.push('```');
  L.push('MCP: `pi mcp add recordforge -- recordforge-mcp` (config at `~/.pi/agent/mcp.json`).');
  L.push('');

  L.push('### OpenClaw');
  L.push('```bash');
  L.push(`mkdir -p ~/.openclaw/workspace/skills/${name}`);
  L.push(`cp SKILL.md skill.json ~/.openclaw/workspace/skills/${name}/`);
  L.push('```');
  L.push('Restart with `/new` (or `openclaw gateway restart`). MCP: add via the gateway settings.');
  L.push('');

  L.push('### DeepSeek Harness (dsh)');
  L.push('dsh is plugin-based (Cordis). Short term, recordforge works through its MCP support or shell — add a pointer in `AGENTS.md` and replay via `recordforge replay`. A native dsh plugin is a possible follow-up.');
  L.push('');
  return L.join('\n');
}

export function emit(skill, { outDir, name } = {}) {
  const slug = skillName(name || skill.name);
  const dir = outDir || path.join(process.cwd(), slug);
  mkdirSync(dir, { recursive: true });
  const files = {
    skillMarkdown: path.join(dir, 'SKILL.md'),
    skillJson: path.join(dir, 'skill.json'),
    readme: path.join(dir, 'README.md'),
  };
  writeFileSync(files.skillMarkdown, buildSkillMarkdown(skill, { name: slug }));
  writeFileSync(files.skillJson, JSON.stringify(skill, null, 2));
  writeFileSync(files.readme, buildInstallGuide(skill, { name: slug }));
  return {
    dir,
    name: slug,
    files: [files.skillMarkdown, files.skillJson, files.readme],
    skillMarkdown: buildSkillMarkdown(skill, { name: slug }),
  };
}
