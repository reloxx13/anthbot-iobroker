# Anthbot Genie ioBroker Adapter

Local scaffold for an unofficial Anthbot Genie ioBroker adapter.

Current scope:

- Anthbot cloud login
- device discovery
- region and IoT endpoint lookup
- polling of mower property and service shadows
- writable control states for the main mower commands
- zone metadata and zone-start commands

Exposed per mower:

- `info.*`
- `metrics.*`
- `controls.*`
- `commands.*`
- `zones.*`
- `raw.*`

## Manual zone mowing

The adapter exposes the mower's manual/custom zones in:

- `<instance>.<serial>.zones.manual`

This state contains a JSON array with the known manual zones. Use the `id` or
the exact `name` from that list to start mowing.

Write the selection to:

- `<instance>.<serial>.commands.zoneMow`

Accepted values:

- one zone by ID: `3`
- one zone by name: `Front yard`
- multiple zones as comma-separated IDs or names: `3,5,Back yard`
- multiple zones as a JSON array: `[3,5,"Back yard"]`

After a valid write, the adapter sends `custom_area_mow_start` with the matched
manual zone IDs and clears `commands.zoneMow` again.

Notes:

- this is based on the public Home Assistant integration logic from `vincentjanv/anthbot_genie_ha`
- this project is unofficial and not affiliated with or endorsed by Anthbot; see `NOTICE.md`
- it is a local first version, not a published ioBroker adapter yet
- the password is stored in encrypted native config

## Changelog

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

## Credits

Special credit to the Home Assistant Anthbot Genie project that made the
cloud flow and command mapping much easier to understand:

- `vincentjanv/anthbot_genie_ha`
- https://github.com/vincentjanv/anthbot_genie_ha

This ioBroker adapter scaffold is an independent local project, but it
directly builds on the public API research and implementation approach from
that Home Assistant integration.

## License

Copyright (c) 2026 reloxx13

MIT License. See [LICENSE](LICENSE) for details.
