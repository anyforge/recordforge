---
name: recordforge
description: Use when recording or replaying browser workflows with recordforge. Record → compile → emit → replay.
---

# RecordForge

Record browser workflows over CDP and replay them **deterministically** (no page re-reading, no LLM in the replay loop). Repo: github.com/anyforge/recordforge. Install: `npm install -g @anyforgex/recordforge` (or from source: `git clone` + `./install.sh`).

## Pipeline

`record → compile → emit → replay`

## Record

```bash
recordforge record --name order-status            # launches a fresh Chrome; Ctrl-C to stop + save
recordforge record --cdp http://127.0.0.1:9222    # attach to a running browser
```

Captures click / type / hover / scroll / select / upload / contextmenu / submit / navigate across **all tabs**. Passwords and `autocomplete`-sensitive fields are recorded as `{SECRET:name}` — the value never leaves the page. Saved to `~/.recordforge/recordings/<name>-<ts>.json`.

## Compile

```bash
recordforge compile ~/.recordforge/recordings/<name>-<ts>.json --name order-status
```

Deterministic (no LLM): parameterizes every typed value into `{{name}}` placeholders, routes secrets to the store, emits a replay script. Skill saved to `~/.recordforge/skills/<name>.json`.

## Emit (native skill for any agent)

```bash
recordforge emit ~/.recordforge/skills/<name>.json --name order-status
```

Produces a universal `SKILL.md` (loadable by Hermes, Claude Code, Codex, Pi, OpenClaw) + a per-agent install guide (`README.md`) + the replay payload (`skill.json`).

## Replay

```bash
recordforge replay ~/.recordforge/skills/<name>.json 金额=800 事由=出差   # KEY=VALUE for each {{var}}
```

`{{SECRET:name}}` resolves from the local store — never from variables or chat. Stops on the first failed step and reports the step index + reason.

## Secrets

```bash
recordforge secret set password     # prompts with input masked
recordforge secret list             # names only
recordforge secret delete password
```

Store: `~/.recordforge/secrets.json` (mode 0600, plaintext v1).

## MCP

10 tools (`record_start`, `record_stop`, `record_cancel`, `compile`, `emit`, `replay`, `list`, `secret_*`). Wire as an MCP server with: `recordforge-mcp` (installed with the package; or `node /abs/path/to/recordforge/src/index.js` from source).
