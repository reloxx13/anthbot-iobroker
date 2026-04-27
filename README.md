# ioBroker.anthbot-genie

![Logo](admin/anthbot-genie.png)

![Test and Release](https://github.com/reloxx13/ioBroker.anthbot-genie/workflows/Test%20and%20Release/badge.svg)
![Automerge Dependabot](https://github.com/reloxx13/ioBroker.anthbot-genie/workflows/Automerge%20Dependabot/badge.svg)
[![NPM version](https://img.shields.io/npm/v/iobroker.anthbot-genie.svg)](https://www.npmjs.com/package/iobroker.anthbot-genie)
[![Downloads](https://img.shields.io/npm/dm/iobroker.anthbot-genie.svg)](https://www.npmjs.com/package/iobroker.anthbot-genie)
![GitHub release](https://img.shields.io/github/v/release/reloxx13/ioBroker.anthbot-genie)
![License](https://img.shields.io/github/license/reloxx13/ioBroker.anthbot-genie)
![ioBroker phase](https://img.shields.io/badge/ioBroker%20phase-testing-yellow)
[![ioBroker forum](https://img.shields.io/badge/ioBroker-forum-blue)](https://forum.iobroker.net/topic/84392/test-adapter-anthbot-genie-v0.0.x-npm-github)

[![NPM](https://nodei.co/npm/iobroker.anthbot-genie.png?downloads=true)](https://nodei.co/npm/iobroker.anthbot-genie/)

Unofficial ioBroker adapter for [Anthbot Genie robotic lawn mowers](https://de.anthbot.com/products/genie-mahroboter).

The adapter connects to the Anthbot cloud account, discovers bound mowers, reads cloud and IoT shadow data, and exposes status, settings, mower commands, zone data, and raw diagnostic payloads in ioBroker.

This adapter is currently in testing. Please report feedback and test results in the [ioBroker forum Test Adapter anthbot-genie v0.0.x npm/GitHub thread](https://forum.iobroker.net/topic/84392/test-adapter-anthbot-genie-v0.0.x-npm-github).

An example ioBroker Blockly with conditions for mower automation is available in the [Blockly automation example](https://forum.iobroker.net/topic/84392/test-adapter-anthbot-genie-v0.0.x-npm-github/2?_=1777117406598).

## Features

- Anthbot cloud login with encrypted password storage in ioBroker native config
- Automatic discovery of mowers bound to the configured Anthbot account
- Region and IoT endpoint lookup per mower
- Polling of property and service shadows
- Status states for connection, online state, battery, mower status, charging state, mowing time, mowing area, rain handling, cutting height, voice volume, mowing near the charging pile, and consumable lifetime
- Writable control states for cutting height, voice volume, custom mowing direction, rain settings, and mowing near the charging pile
- Command states for full mowing, stop, return to dock, grass dump, disk maintenance mode, edge mowing, mowing near the charging pile, refresh, manual zone mowing, and automatic zone mowing
- Manual and automatic zone metadata as JSON states
- Raw property, service, and area payloads for troubleshooting

## Requirements

- ioBroker with js-controller `>= 6.0.11`
- ioBroker admin `>= 7.6.20`
- Node.js `>= 20`
- Anthbot account with at least one bound Genie mower
- Internet access from the ioBroker host to the Anthbot cloud and AWS IoT endpoint

## Configuration

Open the adapter instance configuration in ioBroker Admin and set:

| Setting | Description | Default |
| --- | --- | --- |
| Anthbot account username | Username or email address of the Anthbot account | empty |
| Anthbot account password | Anthbot account password, stored encrypted by ioBroker | empty |
| Area code | Phone or account area code, for example `49` for Germany | `49` |
| API host | Anthbot cloud API host | `api.anthbot.com` |
| Poll interval in seconds | Polling interval for mower data. The adapter enforces at least 10 seconds. | `30` |

After saving the configuration, start or restart the adapter instance.

## States

The adapter creates one device tree per mower serial number:

```text
anthbot-genie.<instance>.<serial>.*
```

### Info

| State | Type | Description |
| --- | --- | --- |
| `info.connection` | boolean | Global adapter cloud connection state |
| `<serial>.info.alias` | string | Mower alias from Anthbot |
| `<serial>.info.model` | string | Mower model/category |
| `<serial>.info.region` | string | Anthbot/AWS IoT region |
| `<serial>.info.endpoint` | string | IoT endpoint used for shadow access |
| `<serial>.info.online` | boolean | Online state reported by the mower |
| `<serial>.info.charging` | boolean | Whether the mower is currently charging |
| `<serial>.info.lastServiceCommand` | string | Last reported service command |
| `<serial>.info.lastPoll` | string | ISO timestamp of the last successful poll |

### Metrics

| State | Type | Unit | Description |
| --- | --- | --- | --- |
| `<serial>.metrics.batteryLevel` | number | `%` | Battery level |
| `<serial>.metrics.mowerStatus` | string | | Normalized mower status |
| `<serial>.metrics.robotStatusRaw` | string | | Raw robot status |
| `<serial>.metrics.cuttingHeight` | number | `mm` | Current cutting height |
| `<serial>.metrics.voiceVolume` | number | `%` | Current voice volume |
| `<serial>.metrics.mowingTime` | number | `s` | Reported mowing time |
| `<serial>.metrics.mowingArea` | number | `m2` | Reported mowing area |
| `<serial>.metrics.customMowingDirection` | number | `deg` | Custom mowing direction |
| `<serial>.metrics.customMowingDirectionEnabled` | boolean | | Custom mowing direction enabled |
| `<serial>.metrics.rainPerceptionEnabled` | boolean | | Rain perception enabled |
| `<serial>.metrics.rainContinueTime` | number | `s` | Delay before continuing after rain |
| `<serial>.metrics.nearChargerMowingEnabled` | boolean | | Mowing near the charging pile enabled |
| `<serial>.metrics.nearChargerMowHeight` | number | `mm` | Cutting height for mowing near the charging pile |
| `<serial>.metrics.nearChargerMowCount` | number | | Mowing passes near the charging pile |
| `<serial>.metrics.nearChargerObstacleAvoidanceEnabled` | boolean | | Obstacle avoidance for mowing near the charging pile |
| `<serial>.metrics.nearChargerObstacleAvoidanceLevel` | number | | Obstacle avoidance level for mowing near the charging pile |
| `<serial>.metrics.pointMowActive` | boolean | | Point mowing active |
| `<serial>.metrics.pointMowX` | number | | Last point mowing X coordinate |
| `<serial>.metrics.pointMowY` | number | | Last point mowing Y coordinate |
| `<serial>.metrics.cameraEnabled` | boolean | | Camera enabled |
| `<serial>.metrics.rtkAntennaMoved` | boolean | | RTK antenna moved warning active |

### Consumables

| State | Type | Unit | Description |
| --- | --- | --- | --- |
| `<serial>.consumable.station` | number | `%` | Station lifetime |
| `<serial>.consumable.cameras` | number | `%` | Cameras lifetime |
| `<serial>.consumable.blades` | number | `%` | Blades lifetime |
| `<serial>.consumable.station_reset` | boolean | | Reset station lifetime |
| `<serial>.consumable.cameras_reset` | boolean | | Reset cameras lifetime |
| `<serial>.consumable.blades_reset` | boolean | | Reset blades lifetime |

The mower accepts consumable reset commands only when the related lifetime value is at or below 5%.

### Controls

Writable control states update mower settings through the Anthbot IoT service shadow.

| State | Type | Range | Description |
| --- | --- | --- | --- |
| `<serial>.controls.mowHeight` | number | `30..70 mm`, 5 mm steps | Set cutting height |
| `<serial>.controls.voiceVolume` | number | `0..100 %` | Set voice volume |
| `<serial>.controls.customMowingDirection` | number | `0..180 deg` | Set custom mowing direction |
| `<serial>.controls.customMowingDirectionEnabled` | boolean | `true`/`false` | Enable or disable custom mowing direction |
| `<serial>.controls.rainPerceptionEnabled` | boolean | `true`/`false` | Enable or disable rain perception |
| `<serial>.controls.rainContinueTimeHours` | number | `0..8 h` | Set rain continue time in hours |
| `<serial>.controls.nearChargerMowingEnabled` | boolean | `true`/`false` | Enable or disable mowing near the charging pile |
| `<serial>.controls.nearChargerMowHeight` | number | `30..70 mm`, 5 mm steps | Set cutting height for mowing near the charging pile |
| `<serial>.controls.nearChargerMowCount` | number | `1..3` | Set mowing passes near the charging pile |
| `<serial>.controls.nearChargerObstacleAvoidanceEnabled` | boolean | `true`/`false` | Enable or disable obstacle avoidance near the charging pile |
| `<serial>.controls.nearChargerObstacleAvoidanceLevel` | number | `0..2` | Set obstacle avoidance level near the charging pile |
| `<serial>.controls.cameraEnabled` | boolean | `true`/`false` | Enable or disable the camera |

### Commands

Command states are writable. Button states are reset to `false` after execution. Zone command states are reset to an empty string after execution. Consumable reset buttons are exposed under `consumable`.

| State | Type | Description |
| --- | --- | --- |
| `<serial>.commands.findRobot` | boolean | Find the robot |
| `<serial>.commands.startFullMow` | boolean | Start full mowing |
| `<serial>.commands.pauseMow` | boolean | Pause mowing |
| `<serial>.commands.continueMow` | boolean | Continue mowing |
| `<serial>.commands.stopMow` | boolean | Stop all mower tasks |
| `<serial>.commands.endMow` | boolean | End mowing |
| `<serial>.commands.returnToDock` | boolean | Return to the charging dock |
| `<serial>.commands.pauseReturnToDock` | boolean | Pause return to the charging dock |
| `<serial>.commands.continueReturnToDock` | boolean | Continue return to the charging dock |
| `<serial>.commands.startGrassDump` | boolean | Start grass dump |
| `<serial>.commands.startDiskMaintenance` | boolean | Start disk maintenance mode |
| `<serial>.commands.startEdgeMow` | boolean | Start edge mowing |
| `<serial>.commands.startNearChargerMow` | boolean | Start mowing near the charging pile |
| `<serial>.commands.cancelRtkAntennaMoved` | boolean | Cancel the RTK antenna moved warning |
| `<serial>.commands.requestRefresh` | boolean | Request all mower properties and refresh states |
| `<serial>.commands.zoneMow` | string | Start mowing one or more manual zones |
| `<serial>.commands.autoZoneMow` | string | Start mowing one or more automatic zones |
| `<serial>.commands.pointMow` | string | Start point mowing with `x,y` or `{"x":123,"y":456}` |
| `<serial>.commands.stopPointMow` | boolean | Stop point mowing |

Availability of `startDiskMaintenance`, `startGrassDump`, `startEdgeMow`, `startNearChargerMow`, `nearChargerMowingEnabled`, `pointMow`, and `cameraEnabled` may depend on mower model, firmware, current mower mode, and map/edge data.

### Zones

| State | Type | Description |
| --- | --- | --- |
| `<serial>.zones.manual` | JSON string | Known manual/custom zones |
| `<serial>.zones.auto` | JSON string | Known automatic/region zones |
| `<serial>.zones.activeManualIds` | JSON string | Currently active manual zone IDs |

### Raw data

| State | Type | Description |
| --- | --- | --- |
| `<serial>.raw.property` | JSON string | Raw property shadow payload |
| `<serial>.raw.service` | JSON string | Raw service shadow payload |
| `<serial>.raw.areaDefinition` | JSON string | Raw area definition payload |

## Zone Mowing

The adapter exposes the mower's manual/custom zones in:

```text
<instance>.<serial>.zones.manual
```

This state contains a JSON array with known zones. Use the `id` or the exact `name` from that list to start mowing.

Write the selection to:

```text
<instance>.<serial>.commands.zoneMow
```

Accepted values:

- one zone by ID: `3`
- one zone by name: `Front yard`
- multiple zones as comma-separated IDs or names: `3,5,Back yard`
- multiple zones as a JSON array: `[3,5,"Back yard"]`

After a valid write, the adapter sends `custom_area_mow_start` with the matched manual zone IDs and clears `commands.zoneMow` again.

Automatic zones work similarly through:

```text
<instance>.<serial>.zones.auto
<instance>.<serial>.commands.autoZoneMow
```

For automatic zones, the adapter resolves the selected zone IDs or names to the zone coordinates and sends `region_mow_start`.

## Troubleshooting

### Adapter does not connect

- Check username, password, and area code.
- Confirm that the mower is visible in the Anthbot app with the same account.
- Increase the adapter log level to `debug` and restart the instance.
- Check `anthbot-genie.<instance>.info.connection`.

### No mower objects are created

- The Anthbot account must have at least one bound mower.
- Check the adapter log for `No Anthbot devices found for this account`.
- Verify that the ioBroker host has internet access.

### Commands do not work

- Check whether status polling works first.
- Verify that the target state is under the correct mower serial number.
- For zone commands, compare the written value with the IDs and names in `zones.manual` or `zones.auto`.
- Check `raw.service` and the adapter log for command errors.

## Legal Notice

This project is unofficial and is not affiliated with, endorsed by, sponsored by, or approved by Anthbot.

Anthbot and Genie names, marks, and logos belong to their respective owners. See [NOTICE.md](NOTICE.md) for details.

## Credits

Special credit to the Home Assistant Anthbot Genie project, which made the Anthbot cloud flow and command mapping much easier to understand:

- `vincentjanv/anthbot_genie_ha`
- <https://github.com/vincentjanv/anthbot_genie_ha>

This ioBroker adapter is an independent project, but it builds on public API research and implementation ideas from that Home Assistant integration.

## Changelog

### **WORK IN PROGRESS**

### 0.0.9-beta.0

- Add consumable reset buttons for station, cameras, and blades.
- Add mower action commands: find robot, grass dump, disk maintenance mode, edge mowing, near-charger mowing, and point mowing.
- Add task control commands: pause/continue mowing, pause/continue return-to-dock, and end mowing.
- Add RTK antenna moved warning cancel command.
- Add status and control states for mowing near the charging pile, including its mowing parameters.
- Add camera switch status and control.
- Add RTK antenna moved warning status.

### 0.0.8

- Add consumable channels and values ​​to the adapter definition.

### 0.0.7

- Add Dependabot automerge configuration.
- Update repository metadata for ioBroker checks.

### 0.0.6

- Fix ioBroker repository checker issues.
- Move admin configuration translations to i18n files.

### 0.0.5

- Prepare adapter metadata for ioBroker repository checks.

### 0.0.4

- Add adapter icon, legal notice, German translations, and ensure the connection state object exists.

### 0.0.3

- Release 0.0.3.

### 0.0.2

- Release 0.0.2.

### 0.0.1

- Initial local adapter scaffold for Anthbot Genie.

## License

MIT License

Copyright (c) 2026 reloxx13

See [LICENSE](LICENSE) for details.
