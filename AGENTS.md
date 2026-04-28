# Repository Guidelines

## Project Structure & Module Organization

This repository is a small Node.js ioBroker adapter for Anthbot Genie mowers.

- `main.js` is the adapter entry point and owns ioBroker lifecycle handling, polling, object/state creation, and command handling.
- `lib/anthbot.js` contains the Anthbot cloud/shadow API clients plus parsing and mapping helpers.
- `admin/` contains adapter admin assets and `jsonConfig.json` for ioBroker configuration UI.
- `io-package.json` defines adapter metadata, encrypted native config, default settings, and ioBroker objects.
- `README.md`, `NOTICE.md`, and `LICENSE` contain user documentation and legal notices.

There is currently no dedicated `test/` directory or generated build output.

## Build, Test, and Development Commands

- `npm install` installs runtime dependencies.
- `npm run check` runs `node --check` against `main.js` and `lib/anthbot.js`; use it before every commit.
- `npm run check:repo` runs the ioBroker repository checker against the GitHub repository.
- `npm run release` invokes the ioBroker release script; use it for preparing new adapter versions.
- `npm pack` can be used to inspect the package contents listed in `package.json`.

The adapter is intended to run inside ioBroker. Avoid treating `node main.js` as a complete local integration test unless an ioBroker runtime is available.

## Coding Style & Naming Conventions

Use CommonJS modules with `"use strict";`. Match the existing style: 4-space indentation, semicolons, double quotes, `async`/`await`, and descriptive camelCase identifiers. Classes use PascalCase, for example `AnthbotCloudApiClient`.

Keep protocol/API constants near the top of `lib/anthbot.js`. Keep ioBroker object and state definitions in `main.js` unless they become reusable helpers. Prefer small pure functions for payload parsing and value coercion.

## Git & Workflow Rules

Before making changes, run `git status --short` and preserve unrelated local changes.

Work on the current branch. Do not create branches, commits, tags, releases, pull requests, or pushes unless explicitly requested.

Commit only files related to the task. Use non-interactive git commands and never run destructive commands such as `git reset --hard`, `git checkout --`, or history-rewriting rebase without explicit approval.

Before asking where code or behavior lives, search the repository first. Prefer `rg`, `fd`, and `jq` for inspection when available.

After code changes, run the relevant npm checks and report the exact validation performed. For runtime issues, prefer ioBroker/manual adapter verification over treating `node main.js` as sufficient.

## ioBroker Adapter Rules

Every state must have a matching `state` object before values are written. Keep the object tree stable under each mower serial number and use `device`, `channel`, and `state` object types consistently.

For every state object, set precise `common.type`, `common.role`, `common.read`, `common.write`, units, min/max, and `common.states` where applicable. Prefer specific roles such as `indicator.connected`, `value.battery`, `level.*`, `switch.*`, `button`, `text`, or `json` over generic `state` when the purpose is known.

Use ioBroker `ack` semantics consistently: values read from Anthbot cloud, shadow, or derived parsing are written with `ack: true`; user requests are handled only from subscribed write states with `ack === false`.

Command states under `commands.*` are user-triggered controls. Validate input, send the Anthbot command, then reset button/text command states with `ack: true` so ioBroker users can trigger them again.

Keep raw cloud/shadow payload states diagnostic-only and avoid storing credentials, tokens, serial-number samples from a real user, or other secrets in code, docs, logs, or fixtures.

When changing `admin/jsonConfig.json`, keep `common.adminUI.config` in `io-package.json` aligned, preserve `i18n: true`, and add or update translations in `admin/i18n/*/translations.json`.

When changing configuration fields, keep `io-package.json` `native`, `encryptedNative`, `protectedNative`, and the admin JSON config in sync. The `password` field must stay encrypted and protected.

Preserve the daemon/cloud-poll adapter shape in `io-package.json`: `mode: "daemon"`, `compact: true`, `connectionType: "cloud"`, and `dataSource: "poll"` unless there is a deliberate adapter architecture change.

## Testing Guidelines

`@iobroker/testing` is available for package-file and integration tests, but no test files are configured yet. For now, run `npm run check` after changes and manually verify behavior in an ioBroker instance when touching login, polling, object creation, or mower commands.

If adding tests, use file names like `*.test.js` and place them under `test/` or beside the module they cover. Focus first on pure helpers in `lib/anthbot.js`.

## Commit & Pull Request Guidelines

Recent commits use short, imperative summaries such as `Add German translations` and release commits like `Release 0.0.4`. Keep commit subjects concise and specific.

When making user-visible or release-relevant changes, update the `README.md` changelog under `WORK IN PROGRESS` in the same change.

When state objects, command behavior, config fields, or user-visible adapter behavior change, update the README sections that document those states, commands, or settings in the same change.

When preparing a release, use `npm run release` and keep `README.md` changelog entries, `io-package.json` news, `package.json`, and `package-lock.json` versions consistent with the release script output.

Pull requests should include a clear description, validation performed (`npm run check`, manual ioBroker checks), linked issues when applicable, and screenshots only for admin UI changes.

## Security & Configuration Tips

Do not commit real Anthbot credentials, tokens, serial numbers, or local ioBroker data. The adapter stores `password` as encrypted native config; preserve that behavior when changing configuration.
