# ioBroker.anthbot-genie

![Logo](admin/anthbot-genie.png)

![Test and Release](https://github.com/reloxx13/ioBroker.anthbot-genie/workflows/Test%20and%20Release/badge.svg)
![Automerge Dependabot](https://github.com/reloxx13/ioBroker.anthbot-genie/workflows/Automerge%20Dependabot/badge.svg)
[![NPM version](https://img.shields.io/npm/v/iobroker.anthbot-genie.svg)](https://www.npmjs.com/package/iobroker.anthbot-genie)
[![Downloads](https://img.shields.io/npm/dm/iobroker.anthbot-genie.svg)](https://www.npmjs.com/package/iobroker.anthbot-genie)
![GitHub release](https://img.shields.io/github/v/release/reloxx13/ioBroker.anthbot-genie)
![License](https://img.shields.io/github/license/reloxx13/ioBroker.anthbot-genie)
![ioBroker phase](https://img.shields.io/badge/ioBroker%20phase-testing-yellow)
[![ioBroker forum](https://img.shields.io/badge/ioBroker-forum-blue)](https://forum.iobroker.net/topic/84392)

[![NPM](https://nodei.co/npm/iobroker.anthbot-genie.png?downloads=true)](https://nodei.co/npm/iobroker.anthbot-genie/)

Unofficial ioBroker adapter for [Anthbot Genie robotic lawn mowers](https://de.anthbot.com/products/genie-mahroboter).

The adapter connects to the Anthbot cloud account, discovers bound mowers, reads cloud and IoT shadow data, and exposes status, settings, mower commands, zone data, and raw diagnostic payloads in ioBroker.

This adapter is currently in testing. Please report feedback and test results in the [ioBroker forum test thread](https://forum.iobroker.net/topic/84392).

An example ioBroker Blockly with conditions for mower automation is available in the [Blockly automation example](https://forum.iobroker.net/topic/84392/2).

## Features

- Anthbot cloud login with encrypted password storage in ioBroker native config
- Automatic discovery of mowers bound to the configured Anthbot account
- Region and IoT endpoint lookup per mower
- Polling of property and service shadows
- Status states for connection, online state, battery, mower status, charging state, mowing time, mowing area, map, error, and consumable lifetime
- Diagnostic states for RTK, firmware, OTA, network, GPS/location, map lifecycle, and mower error data
- Writable control states for full-map mowing, zone mowing, cutting height, voice volume, custom mowing direction, rain settings, and mowing near the charging pile
- Command states for full mowing, stop, return to dock, pause return to dock, grass dump, disk maintenance mode, edge mowing, mowing near the charging pile, refresh, manual zone mowing, and automatic zone mowing
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
| `<serial>.metrics.status.mower` | string | | Normalized mower status |
| `<serial>.metrics.status.robotRaw` | string | | Raw robot status |
| `<serial>.metrics.mowing.time` | number | `s` | Reported mowing time |
| `<serial>.metrics.mowing.area` | number | `m2` | Reported mowing area |
| `<serial>.metrics.mowing.borderActive` | boolean | | Border mowing active |
| `<serial>.metrics.mowing.nearChargerActive` | boolean | | Near-charger mowing active |
| `<serial>.metrics.mowing.fullYardActive` | boolean | | Full-yard mowing active |
| `<serial>.metrics.pointMowing.active` | boolean | | Point mowing active |
| `<serial>.metrics.pointMowing.x` | number | | Last point mowing X coordinate |
| `<serial>.metrics.pointMowing.y` | number | | Last point mowing Y coordinate |
| `<serial>.metrics.zones.manualCount` | number | | Number of manual zones |
| `<serial>.metrics.zones.autoCount` | number | | Number of automatic zones |
| `<serial>.metrics.map.totalArea` | number | `m2` | Total mapped area |
| `<serial>.metrics.map.status` | string | | Raw map status |
| `<serial>.metrics.error.code` | number | | Last mower error code |
| `<serial>.metrics.error.description` | string | | Human-readable error description when known |
| `<serial>.metrics.error.active` | boolean | | Whether a non-zero mower error is active |

### Location

| State | Type | Description |
| --- | --- | --- |
| `<serial>.location.gps.latitude` | number | GPS latitude from anti-loss position data |
| `<serial>.location.gps.longitude` | number | GPS longitude from anti-loss position data |
| `<serial>.location.pose.x` | number | Local mower pose X |
| `<serial>.location.pose.y` | number | Local mower pose Y |
| `<serial>.location.pose.yaw` | number | Local mower pose yaw |
| `<serial>.location.pose.type` | string | Reported pose type |

### Diagnostics

The `diagnostics` channel exposes read-only troubleshooting data derived from the mower shadow, including RTK state, RTK base state, camera/map/network flags, obstacle avoidance, firmware versions, OTA progress, WiFi/SIM details, timestamps, and the next appointment.

### Consumables

| State | Type | Unit | Description |
| --- | --- | --- | --- |
| `<serial>.consumable.chargingPort.life` | number | `%` | Charging port lifetime |
| `<serial>.consumable.chargingPort.reset` | boolean | | Reset charging port lifetime |
| `<serial>.consumable.cameras.life` | number | `%` | Cameras lifetime |
| `<serial>.consumable.cameras.reset` | boolean | | Reset cameras lifetime |
| `<serial>.consumable.blades.life` | number | `%` | Blades lifetime |
| `<serial>.consumable.blades.reset` | boolean | | Reset blades lifetime |

The mower accepts consumable reset commands only when the related lifetime value is at or below 5%.

### Controls

Writable control states update mower settings through the Anthbot IoT service shadow.

| State | Type | Range | Description |
| --- | --- | --- | --- |
| `<serial>.controls.fullMapMowing.mowHeight` | number | `30..70 mm`, 5 mm steps | Set full-map cutting height |
| `<serial>.controls.fullMapMowing.includeEdgeTrimming` | boolean | `true`/`false` | Include edge trimming in full-map mowing |
| `<serial>.controls.fullMapMowing.customMowingDirection` | number | `0..180 deg` | Set full-map custom mowing direction |
| `<serial>.controls.fullMapMowing.customMowingDirectionEnabled` | boolean | `true`/`false` | Enable or disable full-map custom mowing direction |
| `<serial>.controls.zoneMowing.mowHeight` | number | `30..70 mm`, 5 mm steps | Set zone mowing cutting height |
| `<serial>.controls.zoneMowing.mowCount` | number | `1..3` | Set zone mowing passes |
| `<serial>.controls.zoneMowing.customMowingDirection` | number | `0..180 deg` | Set zone mowing direction |
| `<serial>.controls.zoneMowing.customMowingDirectionEnabled` | boolean | `true`/`false` | Enable or disable zone mowing direction |
| `<serial>.controls.zoneMowing.obstacleAvoidanceEnabled` | boolean | `true`/`false` | Enable or disable zone obstacle avoidance |
| `<serial>.controls.zoneMowing.obstacleAvoidanceLevel` | number | `0..2` | Set zone obstacle avoidance level |
| `<serial>.controls.voiceVolume` | number | `0..100 %` | Set voice volume |
| `<serial>.controls.rain.perceptionEnabled` | boolean | `true`/`false` | Enable or disable rain perception |
| `<serial>.controls.rain.continueTimeHours` | number | `0..8 h` | Set rain continue time in hours |
| `<serial>.controls.nearChargerMowing.enabled` | boolean | `true`/`false` | Enable or disable mowing near the charging pile |
| `<serial>.controls.nearChargerMowing.mowHeight` | number | `30..70 mm`, 5 mm steps | Set cutting height for mowing near the charging pile |
| `<serial>.controls.nearChargerMowing.mowCount` | number | `1..3` | Set mowing passes near the charging pile |
| `<serial>.controls.nearChargerMowing.obstacleAvoidanceEnabled` | boolean | `true`/`false` | Enable or disable obstacle avoidance near the charging pile |
| `<serial>.controls.nearChargerMowing.obstacleAvoidanceLevel` | number | `0..2` | Set obstacle avoidance level near the charging pile |
### Commands

Command states are writable. Button states are reset to `false` after execution. Zone command states are reset to an empty string after execution. Consumable reset buttons are exposed under `consumable`.

| State | Type | Description |
| --- | --- | --- |
| `<serial>.commands.device.find` | boolean | Find the robot |
| `<serial>.commands.device.refresh` | boolean | Request all mower properties and refresh states |
| `<serial>.commands.device.cancelRtkAntennaMoved` | boolean | Cancel the RTK antenna moved warning |
| `<serial>.commands.docking.startReturn` | boolean | Return to the charging dock |
| `<serial>.commands.docking.pauseReturn` | boolean | Pause return to the charging dock |
| `<serial>.commands.maintenance.startGrassDump` | boolean | Start grass dump |
| `<serial>.commands.maintenance.startDiskMaintenance` | boolean | Start disk maintenance mode |
| `<serial>.commands.mowing.startFullMap` | boolean | Start full-map mowing |
| `<serial>.commands.mowing.startZone` | string | Start mowing one or more manual zones |
| `<serial>.commands.mowing.startAutoZone` | string | Start mowing one or more automatic zones |
| `<serial>.commands.mowing.startPoint` | string | Start point mowing with `x,y` or `{"x":123,"y":456}` |
| `<serial>.commands.mowing.startEdge` | boolean | Start edge mowing |
| `<serial>.commands.mowing.startNearCharger` | boolean | Start mowing near the charging pile |
| `<serial>.commands.mowing.pause` | boolean | Pause mowing |
| `<serial>.commands.mowing.resume` | boolean | Resume mowing |
| `<serial>.commands.mowing.stop` | boolean | Stop all mower tasks |
| `<serial>.commands.mowing.end` | boolean | End mowing |
| `<serial>.commands.mowing.stopPoint` | boolean | Stop point mowing |

Availability of `commands.maintenance.startDiskMaintenance`, `commands.maintenance.startGrassDump`, `commands.mowing.startEdge`, `commands.mowing.startNearCharger`, and `commands.mowing.startPoint` may depend on mower model, firmware, current mower mode, and map/edge data.

### Zones

| State | Type | Description |
| --- | --- | --- |
| `<serial>.zones.manual.list` | JSON string | Known manual/custom zones |
| `<serial>.zones.manual.activeIds` | JSON string | Currently active manual zone IDs |
| `<serial>.zones.autoList` | JSON string | Known automatic/region zones |

### Raw data

| State | Type | Description |
| --- | --- | --- |
| `<serial>.raw.shadow.property` | JSON string | Raw property shadow payload |
| `<serial>.raw.shadow.service` | JSON string | Raw service shadow payload |
| `<serial>.raw.areaDefinition` | JSON string | Raw area definition payload |

## Zone Mowing

The adapter exposes the mower's manual/custom zones in:

```text
<instance>.<serial>.zones.manual.list
```

This state contains a JSON array with known zones. Use the `id` or the exact `name` from that list to start mowing.

Write the selection to:

```text
<instance>.<serial>.commands.mowing.startZone
```

Accepted values:

- one zone by ID: `3`
- one zone by name: `Front yard`
- multiple zones as comma-separated IDs or names: `3,5,Back yard`
- multiple zones as a JSON array: `[3,5,"Back yard"]`

After a valid write, the adapter sends `custom_area_mow_start` with the matched manual zone IDs and clears `commands.mowing.startZone` again.

Automatic zones work similarly through:

```text
<instance>.<serial>.zones.autoList
<instance>.<serial>.commands.mowing.startAutoZone
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
- For zone commands, compare the written value with the IDs and names in `zones.manual.list` or `zones.autoList`.
- Check `raw.shadow.service` and the adapter log for command errors.

## Legal Notice

This project is unofficial and is not affiliated with, endorsed by, sponsored by, or approved by Anthbot.

Anthbot and Genie names, marks, and logos belong to their respective owners. See [NOTICE.md](NOTICE.md) for details.

## Credits

Special credit to the Home Assistant Anthbot Genie projects, which made the Anthbot cloud flow and command mapping much easier to understand:

- [vincentjanv](https://github.com/vincentjanv/anthbot_genie_ha)
- [AdrianTIonut](https://github.com/AdrianTIonut/anthbot_genie_ha)

This ioBroker adapter is an independent project, but it builds on public API research and implementation ideas from that Home Assistant integration.

## Changelog

### **WORK IN PROGRESS**

- Clean up repository readiness metadata and poll timer handling for ioBroker best practices.
- Align consumable lifetime and network diagnostic state roles with the documented ioBroker state role list.

### 0.1.0

- Add expanded diagnostics for model names, region fallback, errors, RTK, map, firmware, OTA, network, and GPS/location data.
- Add consumable reset buttons and correct the maintenance mapping for charging port, cameras, and blades.
- Add grouped command states for device, docking, maintenance, and mowing actions.
- Add writable mowing controls grouped by full-map, zone, near-charger, rain, and voice settings.
- Add full-map mowing control to include edge trimming.
- Fix near-charger mowing enable control to use the mower shadow setting.
- Remove unsupported camera-enabled and docking resume-return controls.

### 0.1.0-beta.2

- Add full-map mowing control to include edge trimming.
- Remove the unsupported camera-enabled control.
- Fix near-charger mowing enable control to use the mower shadow setting.
- Remove the docking resume-return command because the cloud command is not working reliably.

### 0.1.0-beta.1

- Add expanded diagnostics for model names, region fallback, errors, RTK, map, firmware, OTA, network, and GPS/location data.
- Correct consumable maintenance mapping to blades, cameras, and charging port.
- Add consumable reset buttons for charging port, cameras, and blades.
- Remove metric states duplicated by writable controls and group mowing controls by full-map, zone, and near-charger mowing.
- Group command states by device, docking, maintenance, and mowing with consistent action names.
- Refactor state layout into grouped metrics, diagnostics, consumables, zones, raw shadows, and rain controls while keeping single-entry controls flat.

### 0.1.0-beta.0

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

## License

MIT License

Copyright (c) 2026 reloxx13

See [LICENSE](LICENSE) for details.
