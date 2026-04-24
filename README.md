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

Notes:

- this is based on the public Home Assistant integration logic from `vincentjanv/anthbot_genie_ha`
- it is a local first version, not a published ioBroker adapter yet
- the password is stored in encrypted native config

## Credits

Special credit to the Home Assistant Anthbot Genie project that made the
cloud flow and command mapping much easier to understand:

- `vincentjanv/anthbot_genie_ha`
- https://github.com/vincentjanv/anthbot_genie_ha

This ioBroker adapter scaffold is an independent local project, but it
directly builds on the public API research and implementation approach from
that Home Assistant integration.
