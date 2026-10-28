# dsh-recordforge

A DeepSeek Harness (dsh) bundle that exposes recordforge as native dsh tools:
`recordforge_record_start`, `recordforge_record_stop`, `recordforge_compile`,
`recordforge_emit`, `recordforge_replay`, `recordforge_list`.

## Install

From the recordforge repo root:

```bash
dsh plugin --profile <name> add ./dsh
```

The package declares `dsh.bundle`, so `dsh` links the checkout and appends the
bundle to the profile's `dsh.profile.bundles`.

## What it registers

The plugin exports `apply(ctx)` and registers six tools backed by one
recordforge engine instance (so an active recording survives across tool calls).
Record/replay drive a Chromium-family browser over CDP; secrets resolve from the
local recordforge store (`~/.recordforge/secrets.json`) and never enter the
recording, the skill, or the conversation.

## Caveats

- **Untested against a live dsh.** DeepSeek Harness is a developer preview under
  rapid iteration and its plugin API may shift. This bundle follows the
  documented format (bundle manifest + `cordis.patch.yml` + `apply(ctx)` via
  `@deepseek-ai/dsh-tools`), but has not been run through `dsh plugin add`.
- The bundle depends on `@anyforgex/recordforge` (published on npm), which `dsh plugin add`
  installs automatically. For an unpublished local build, `npm pack` recordforge and add the
  tarball alongside `./dsh`.
