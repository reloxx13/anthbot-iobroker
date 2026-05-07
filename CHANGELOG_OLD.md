# Changelog Archive

Older changelog entries can be moved here after future releases.

## 0.1.0-beta.2

- Add full-map mowing control to include edge trimming.
- Remove the unsupported camera-enabled control.
- Fix near-charger mowing enable control to use the mower shadow setting.
- Remove the docking resume-return command because the cloud command is not working reliably.

## 0.1.0-beta.1

- Add expanded diagnostics for model names, region fallback, errors, RTK, map, firmware, OTA, network, and GPS/location data.
- Correct consumable maintenance mapping to blades, cameras, and charging port.
- Add consumable reset buttons for charging port, cameras, and blades.
- Remove metric states duplicated by writable controls and group mowing controls by full-map, zone, and near-charger mowing.
- Group command states by device, docking, maintenance, and mowing with consistent action names.
- Refactor state layout into grouped metrics, diagnostics, consumables, zones, raw shadows, and rain controls while keeping single-entry controls flat.

## 0.1.0-beta.0

- Add mower action commands: find robot, grass dump, disk maintenance mode, edge mowing, near-charger mowing, and point mowing.
- Add task control commands: pause/continue mowing, pause/continue return-to-dock, and end mowing.
- Add RTK antenna moved warning cancel command.
- Add status and control states for mowing near the charging pile, including its mowing parameters.
- Add camera switch status and control.
- Add RTK antenna moved warning status.

## 0.0.9-beta.0

- Add mower service commands and controls.

## 0.0.7

- Add Dependabot automerge configuration and update repository metadata.

## 0.0.6

- Fix repository checker issues and move admin config translations to i18n files.

## 0.0.5

- Misc fixes.

## 0.0.4

- Add adapter icon, legal notice, German translations, and ensure the connection state object exists.

## 0.0.3

- Release 0.0.3.

## 0.0.2

- Release 0.0.2.

## 0.0.1

- Initial local adapter scaffold for Anthbot Genie.
