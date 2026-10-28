# Changelog

## 0.1.1

- Added `recordforge-mcp` bin — the MCP server as a standalone command, so MCP wiring no longer hardcodes a source path
- Docs / portable skill / emitter updated: install via `npm install -g @anyforgex/recordforge`, MCP via `recordforge-mcp`, source install as fallback

## 0.1.0 — initial

- CDP recorder (click / type / hover / scroll / select / upload / contextmenu / submit / navigate, across all frames)
- Deterministic compiler (typed values parameterized, secrets routed to the store, submit-after-click dedup)
- Deterministic replay engine (native value setter, real CDP mouse events, post-navigation verification)
- Local secret store (`~/.recordforge/secrets.json`, mode 0600)
- MCP server (10 tools) + CLI
- `emit`: portable Agent Skill for Hermes, Claude Code, Codex, Pi, OpenClaw and DeepSeek Harness
- Multi-tab recording + replay (per-tab capture, `tabUrl`-tagged steps, `/json/activate` tab switching)
- Native DeepSeek Harness bundle (`dsh/`)
- Upload values parameterized (recorded filename → real path supplied at replay)
- Recorder no longer double-records select / checkbox / radio / file on blur
- File upload resolves via `DOM.getDocument` + `DOM.querySelector` (`DOM.requestNode` returns 0 on some Chrome builds)
- Multi-tab tab matching normalizes URLs (origin + path, ignores query / hash)
- End-to-end tests for select / hover / scroll / upload / contextmenu
- ESLint + `npm run lint`
- dsh bundle depends on `recordforge@^0.1.0` (publishable; verified via `npm pack` + install + import)
