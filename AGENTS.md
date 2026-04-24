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
- `npm pack` can be used to inspect the package contents listed in `package.json`.

The adapter is intended to run inside ioBroker. Avoid treating `node main.js` as a complete local integration test unless an ioBroker runtime is available.

## Coding Style & Naming Conventions

Use CommonJS modules with `"use strict";`. Match the existing style: 4-space indentation, semicolons, double quotes, `async`/`await`, and descriptive camelCase identifiers. Classes use PascalCase, for example `AnthbotCloudApiClient`.

Keep protocol/API constants near the top of `lib/anthbot.js`. Keep ioBroker object and state definitions in `main.js` unless they become reusable helpers. Prefer small pure functions for payload parsing and value coercion.

## Testing Guidelines

`@iobroker/testing` is available for package-file and integration tests, but no test files are configured yet. For now, run `npm run check` after changes and manually verify behavior in an ioBroker instance when touching login, polling, object creation, or mower commands.

If adding tests, use file names like `*.test.js` and place them under `test/` or beside the module they cover. Focus first on pure helpers in `lib/anthbot.js`.

## Commit & Pull Request Guidelines

Recent commits use short, imperative summaries such as `Add German translations` and release commits like `Release 0.0.4`. Keep commit subjects concise and specific.

Pull requests should include a clear description, validation performed (`npm run check`, manual ioBroker checks), linked issues when applicable, and screenshots only for admin UI changes.

## Security & Configuration Tips

Do not commit real Anthbot credentials, tokens, serial numbers, or local ioBroker data. The adapter stores `password` as encrypted native config; preserve that behavior when changing configuration.
