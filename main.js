"use strict";

const utils = require("@iobroker/adapter-core");
const axios = require("axios");
const {
    AnthbotCloudApiClient,
    AnthbotShadowApiClient,
    AnthbotGenieError,
    activeManualZoneIds,
    autoZones,
    compactZonePayload,
    coerceEnabledValue,
    generalMowerStatus,
    isCharging,
    isCustomDirectionEnabled,
    manualZones,
    parseCommandSelection,
    rawRobotStatus,
} = require("./lib/anthbot");

class AnthbotGenieAdapter extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: "anthbot-genie",
        });

        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));

        this.http = null;
        this.cloudClient = null;
        this.authToken = null;
        this.deviceContexts = new Map();
        this.pollTimer = null;
        this.refreshInFlight = null;
    }

    async onReady() {
        this.http = axios.create({
            timeout: 15000,
            validateStatus: () => true,
        });

        await this.setStateAsync("info.connection", false, true);

        if (!this.config.username || !this.config.password) {
            this.log.error("Username and password must be configured.");
            return;
        }

        this.subscribeStates("*.commands.*");
        this.subscribeStates("*.controls.*");

        await this.refreshAll(true);
        this.schedulePoll();
    }

    onUnload(callback) {
        try {
            if (this.pollTimer) {
                clearTimeout(this.pollTimer);
                this.pollTimer = null;
            }
            callback();
        } catch {
            callback();
        }
    }

    schedulePoll() {
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
        }
        const intervalSeconds = Math.max(10, Number(this.config.pollInterval) || 30);
        this.pollTimer = setTimeout(async () => {
            this.pollTimer = null;
            try {
                await this.refreshAll();
            } finally {
                this.schedulePoll();
            }
        }, intervalSeconds * 1000);
    }

    async refreshAll(forceLogin = false) {
        if (this.refreshInFlight) {
            return this.refreshInFlight;
        }
        this.refreshInFlight = this.doRefreshAll(forceLogin)
            .finally(() => {
                this.refreshInFlight = null;
            });
        return this.refreshInFlight;
    }

    async doRefreshAll(forceLogin = false) {
        let successful = 0;
        try {
            await this.ensureSession(forceLogin);
            await this.discoverDevices(forceLogin);
            for (const context of this.deviceContexts.values()) {
                try {
                    await this.refreshDevice(context);
                    successful += 1;
                } catch (error) {
                    this.log.warn(`Refresh failed for ${context.device.serialNumber}: ${error.message}`);
                }
            }
        } catch (error) {
            this.log.error(`Global refresh failed: ${error.message}`);
        }

        await this.setStateAsync("info.connection", successful > 0, true);
    }

    async ensureSession(force = false) {
        if (!this.cloudClient || force) {
            this.cloudClient = new AnthbotCloudApiClient({
                http: this.http,
                host: this.config.apiHost || "api.anthbot.com",
                bearerToken: force ? null : this.authToken,
            });
        }
        if (!this.authToken || force) {
            this.authToken = await this.cloudClient.login({
                username: this.config.username,
                password: this.config.password,
                areaCode: String(this.config.areaCode || "49"),
            });
        }
    }

    async discoverDevices(force = false) {
        if (this.deviceContexts.size > 0 && !force) {
            return;
        }

        const devices = await this.cloudClient.getBoundDevices();
        if (!devices.length) {
            throw new AnthbotGenieError("No Anthbot devices found for this account");
        }

        for (const device of devices) {
            const region = await this.cloudClient.getDeviceRegion(device.serialNumber);
            const existing = this.deviceContexts.get(device.serialNumber);
            const context = {
                device,
                region,
                shadowClient: new AnthbotShadowApiClient({
                    http: this.http,
                    serialNumber: device.serialNumber,
                    regionName: region.regionName,
                    iotEndpoint: region.iotEndpoint,
                    awsConfig: {
                        awsAccessKeyDefault: this.config.awsAccessKeyDefault || "",
                        awsSecretKeyDefault: this.config.awsSecretKeyDefault || "",
                        awsAccessKeyCn: this.config.awsAccessKeyCn || "",
                        awsSecretKeyCn: this.config.awsSecretKeyCn || "",
                        awsAccessKeyCnNorthwest: this.config.awsAccessKeyCnNorthwest || "",
                        awsSecretKeyCnNorthwest: this.config.awsSecretKeyCnNorthwest || "",
                    },
                }),
                areaDefinition: existing?.areaDefinition || {},
                lastAreaTime: existing?.lastAreaTime || null,
                lastReported: existing?.lastReported || {},
                lastService: existing?.lastService || {},
            };
            this.deviceContexts.set(device.serialNumber, context);
            await this.ensureDeviceObjects(context);
        }
    }

    async ensureDeviceObjects(context) {
        const serial = context.device.serialNumber;
        const root = serial;

        await this.setObjectNotExistsAsync(root, {
            type: "device",
            common: {
                name: context.device.alias,
            },
            native: {
                serialNumber: serial,
            },
        });

        const definitions = [
            ["info", "channel", "Info", null],
            ["metrics", "channel", "Metrics", null],
            ["controls", "channel", "Controls", null],
            ["commands", "channel", "Commands", null],
            ["zones", "channel", "Zones", null],
            ["raw", "channel", "Raw", null],
        ];

        for (const [id, type, name] of definitions) {
            await this.setObjectNotExistsAsync(`${root}.${id}`, {
                type,
                common: { name },
                native: {},
            });
        }

        const states = {
            "info.alias": { type: "string", role: "text", read: true, write: false, name: "Alias" },
            "info.model": { type: "string", role: "text", read: true, write: false, name: "Model" },
            "info.region": { type: "string", role: "text", read: true, write: false, name: "Region" },
            "info.endpoint": { type: "string", role: "text", read: true, write: false, name: "IoT endpoint" },
            "info.online": { type: "boolean", role: "indicator.reachable", read: true, write: false, name: "Online" },
            "info.charging": { type: "boolean", role: "indicator.working", read: true, write: false, name: "Charging" },
            "info.lastServiceCommand": { type: "string", role: "text", read: true, write: false, name: "Last service command" },
            "info.lastPoll": { type: "string", role: "date", read: true, write: false, name: "Last poll" },
            "metrics.batteryLevel": { type: "number", role: "value.battery", unit: "%", read: true, write: false, name: "Battery level" },
            "metrics.mowerStatus": { type: "string", role: "value", read: true, write: false, name: "Mower status" },
            "metrics.robotStatusRaw": { type: "string", role: "text", read: true, write: false, name: "Raw robot status" },
            "metrics.cuttingHeight": { type: "number", role: "value", unit: "mm", read: true, write: false, name: "Cutting height" },
            "metrics.voiceVolume": { type: "number", role: "level.volume", unit: "%", read: true, write: false, name: "Voice volume" },
            "metrics.mowingTime": { type: "number", role: "value.interval", unit: "s", read: true, write: false, name: "Mowing time" },
            "metrics.mowingArea": { type: "number", role: "value", unit: "m²", read: true, write: false, name: "Mowing area" },
            "metrics.customMowingDirection": { type: "number", role: "value", unit: "deg", read: true, write: false, name: "Custom mowing direction" },
            "metrics.customMowingDirectionEnabled": { type: "boolean", role: "indicator", read: true, write: false, name: "Custom mowing direction enabled" },
            "metrics.rainPerceptionEnabled": { type: "boolean", role: "indicator", read: true, write: false, name: "Rain perception enabled" },
            "metrics.rainContinueTime": { type: "number", role: "value.interval", unit: "s", read: true, write: false, name: "Rain continue time" },
            "controls.mowHeight": { type: "number", role: "level", unit: "mm", min: 30, max: 70, read: true, write: true, name: "Set mow height" },
            "controls.voiceVolume": { type: "number", role: "level.volume", unit: "%", min: 0, max: 100, read: true, write: true, name: "Set voice volume" },
            "controls.customMowingDirection": { type: "number", role: "level", unit: "deg", min: 0, max: 180, read: true, write: true, name: "Set custom mowing direction" },
            "controls.customMowingDirectionEnabled": { type: "boolean", role: "switch", read: true, write: true, name: "Enable custom mowing direction" },
            "controls.rainPerceptionEnabled": { type: "boolean", role: "switch", read: true, write: true, name: "Enable rain perception" },
            "controls.rainContinueTimeHours": { type: "number", role: "level", unit: "h", min: 0, max: 8, read: true, write: true, name: "Set rain continue time" },
            "commands.startFullMow": { type: "boolean", role: "button", read: true, write: true, name: "Start full mow", def: false },
            "commands.stopMow": { type: "boolean", role: "button", read: true, write: true, name: "Stop mow", def: false },
            "commands.returnToDock": { type: "boolean", role: "button", read: true, write: true, name: "Return to dock", def: false },
            "commands.requestRefresh": { type: "boolean", role: "button", read: true, write: true, name: "Request refresh", def: false },
            "commands.zoneMow": { type: "string", role: "text", read: true, write: true, name: "Start manual zone mow" },
            "commands.autoZoneMow": { type: "string", role: "text", read: true, write: true, name: "Start auto zone mow" },
            "zones.manual": { type: "string", role: "json", read: true, write: false, name: "Manual zones" },
            "zones.auto": { type: "string", role: "json", read: true, write: false, name: "Auto zones" },
            "zones.activeManualIds": { type: "string", role: "json", read: true, write: false, name: "Active manual zone IDs" },
            "raw.property": { type: "string", role: "json", read: true, write: false, name: "Raw property shadow" },
            "raw.service": { type: "string", role: "json", read: true, write: false, name: "Raw service shadow" },
            "raw.areaDefinition": { type: "string", role: "json", read: true, write: false, name: "Raw area definition" },
        };

        for (const [suffix, common] of Object.entries(states)) {
            await this.setObjectNotExistsAsync(`${root}.${suffix}`, {
                type: "state",
                common,
                native: {},
            });
        }
    }

    async refreshDevice(context) {
        const propertyState = await context.shadowClient.getShadowReportedState();
        let serviceState = {};
        try {
            serviceState = await context.shadowClient.getServiceReportedState();
        } catch (error) {
            this.log.debug(`Service shadow failed for ${context.device.serialNumber}: ${error.message}`);
        }

        const areaTime = typeof propertyState.area_time === "string" ? propertyState.area_time : null;
        const shouldRefreshArea = !context.areaDefinition || Object.keys(context.areaDefinition).length === 0 || (areaTime && areaTime !== context.lastAreaTime);
        if (shouldRefreshArea) {
            try {
                context.areaDefinition = await this.cloudClient.getDeviceAreaDefinition(context.device.serialNumber);
                context.lastAreaTime = areaTime;
            } catch (error) {
                this.log.debug(`Area definition refresh failed for ${context.device.serialNumber}: ${error.message}`);
            }
        }

        context.lastReported = propertyState;
        context.lastService = serviceState;

        const merged = {
            ...propertyState,
            _service_reported: serviceState,
            _area_definition: context.areaDefinition || {},
        };
        await this.updateStates(context, merged);
    }

    async updateStates(context, data) {
        const serial = context.device.serialNumber;
        const manualZoneList = manualZones(data);
        const autoZoneList = autoZones(data);
        const cutterHeight = typeof data?.param_set?.cutter_height === "number"
            ? data.param_set.cutter_height
            : typeof data?.mow_remote?.cutter_height === "number"
                ? data.mow_remote.cutter_height
                : null;
        const mowingTime = typeof data?.mowing_time_new?.value === "number" ? data.mowing_time_new.value : null;
        const mowingArea = typeof data?.mowing_area_new?.value === "number" ? data.mowing_area_new.value : null;
        const customDirection = typeof data?.param_set?.mow_head === "number" ? data.param_set.mow_head : null;
        const rainContinueTime = typeof data.rain_continue_time === "number" ? data.rain_continue_time : null;
        const rainPerceptionEnabled = coerceEnabledValue(data.rain_switch);
        const serviceCommand = typeof data?._service_reported?.cmd === "string" ? data._service_reported.cmd : "";

        const updates = {
            "info.alias": context.device.alias,
            "info.model": context.device.model,
            "info.region": context.region.regionName,
            "info.endpoint": context.shadowClient.iotEndpoint,
            "info.online": coerceEnabledValue(data.online),
            "info.charging": isCharging(data),
            "info.lastServiceCommand": serviceCommand,
            "info.lastPoll": new Date().toISOString(),
            "metrics.batteryLevel": typeof data.elec === "number" ? data.elec : null,
            "metrics.mowerStatus": generalMowerStatus(data),
            "metrics.robotStatusRaw": rawRobotStatus(data) || "",
            "metrics.cuttingHeight": cutterHeight,
            "metrics.voiceVolume": typeof data.volume === "number" ? data.volume : null,
            "metrics.mowingTime": mowingTime,
            "metrics.mowingArea": mowingArea,
            "metrics.customMowingDirection": customDirection,
            "metrics.customMowingDirectionEnabled": isCustomDirectionEnabled(data),
            "metrics.rainPerceptionEnabled": rainPerceptionEnabled,
            "metrics.rainContinueTime": rainContinueTime,
            "controls.mowHeight": cutterHeight,
            "controls.voiceVolume": typeof data.volume === "number" ? data.volume : null,
            "controls.customMowingDirection": customDirection,
            "controls.customMowingDirectionEnabled": isCustomDirectionEnabled(data),
            "controls.rainPerceptionEnabled": rainPerceptionEnabled,
            "controls.rainContinueTimeHours": typeof rainContinueTime === "number" ? Math.round(rainContinueTime / 3600) : null,
            "zones.manual": JSON.stringify(compactZonePayload(manualZoneList)),
            "zones.auto": JSON.stringify(compactZonePayload(autoZoneList)),
            "zones.activeManualIds": JSON.stringify(activeManualZoneIds(data)),
            "raw.property": JSON.stringify(context.lastReported || {}),
            "raw.service": JSON.stringify(context.lastService || {}),
            "raw.areaDefinition": JSON.stringify(context.areaDefinition || {}),
        };

        for (const [suffix, value] of Object.entries(updates)) {
            await this.setStateAsync(`${serial}.${suffix}`, { val: value, ack: true });
        }
    }

    async onStateChange(id, state) {
        if (!state || state.ack) {
            return;
        }

        const parts = id.replace(`${this.namespace}.`, "").split(".");
        if (parts.length < 3) {
            return;
        }

        const [serial, section, command] = parts;
        const context = this.deviceContexts.get(serial);
        if (!context) {
            this.log.warn(`No device context for state ${id}`);
            return;
        }

        try {
            if (section === "commands") {
                await this.handleCommandState(context, command, state.val);
            } else if (section === "controls") {
                await this.handleControlState(context, command, state.val);
            }
            await this.refreshDevice(context);
        } catch (error) {
            this.log.error(`Command failed for ${id}: ${error.message}`);
        } finally {
            await this.resetWriteState(id, command);
        }
    }

    async resetWriteState(id, command) {
        if (["startFullMow", "stopMow", "returnToDock", "requestRefresh"].includes(command)) {
            await this.setStateAsync(id, { val: false, ack: true });
            return;
        }
        if (["zoneMow", "autoZoneMow"].includes(command)) {
            await this.setStateAsync(id, { val: "", ack: true });
        }
    }

    async handleCommandState(context, command, value) {
        const shouldRun = value === true || value === 1 || value === "true" || (typeof value === "string" && value.trim() !== "");
        if (!shouldRun) {
            return;
        }

        if (command === "startFullMow") {
            await context.shadowClient.publishServiceCommand({ cmd: "app_state", data: 1 });
            await context.shadowClient.publishServiceCommand({ cmd: "mow_start", data: 1 });
        } else if (command === "stopMow") {
            await context.shadowClient.publishServiceCommand({ cmd: "stop_all_tasks", data: 1 });
        } else if (command === "returnToDock") {
            await context.shadowClient.publishServiceCommand({ cmd: "charge_start", data: 1 });
        } else if (command === "requestRefresh") {
            await context.shadowClient.requestAllProperties();
        } else if (command === "zoneMow") {
            const matchedIds = this.resolveManualZoneSelection(context, value);
            if (!matchedIds.length) {
                throw new AnthbotGenieError("No matching manual zones found");
            }
            await context.shadowClient.publishServiceCommand({
                cmd: "custom_area_mow_start",
                data: { id: matchedIds },
            });
        } else if (command === "autoZoneMow") {
            const points = this.resolveAutoZoneSelection(context, value);
            if (!points.length) {
                throw new AnthbotGenieError("No matching auto zones found");
            }
            await context.shadowClient.publishServiceCommand({
                cmd: "region_mow_start",
                data: { points },
            });
        }

        await context.shadowClient.requestAllProperties();
        await this.delay(1000);
    }

    async handleControlState(context, control, value) {
        if (value === null || value === undefined || value === "") {
            return;
        }

        const data = context.lastReported || {};

        if (control === "mowHeight") {
            const intValue = Math.round(Number(value));
            if (intValue < 30 || intValue > 70 || intValue % 5 !== 0) {
                throw new AnthbotGenieError("Mow height must be 30..70 in 5 mm steps");
            }
            await context.shadowClient.publishServiceCommand({
                cmd: "param_set",
                data: { cutter_height: intValue, rid_switch: 0 },
            });
        } else if (control === "voiceVolume") {
            const intValue = Math.round(Number(value));
            if (intValue < 0 || intValue > 100) {
                throw new AnthbotGenieError("Voice volume must be 0..100");
            }
            await context.shadowClient.publishServiceCommand({
                cmd: "volume_ctl",
                data: { volume: intValue },
            });
        } else if (control === "customMowingDirection") {
            const intValue = Math.round(Number(value));
            if (intValue < 0 || intValue > 180) {
                throw new AnthbotGenieError("Custom mowing direction must be 0..180");
            }
            await context.shadowClient.publishServiceCommand({
                cmd: "param_set",
                data: { mow_head: intValue, enable_adaptive_head: 0 },
            });
        } else if (control === "customMowingDirectionEnabled") {
            const enabled = value === true || value === 1 || value === "true";
            const mowHead = typeof data?.param_set?.mow_head === "number" ? data.param_set.mow_head : 0;
            await context.shadowClient.publishServiceCommand({
                cmd: "param_set",
                data: {
                    mow_head: mowHead,
                    enable_adaptive_head: enabled ? 0 : 1,
                },
            });
        } else if (control === "rainPerceptionEnabled") {
            const enabled = value === true || value === 1 || value === "true";
            const continueTime = typeof data.rain_continue_time === "number" && data.rain_continue_time > 0 ? data.rain_continue_time : 10800;
            await context.shadowClient.publishServiceCommand({
                cmd: "ctl_rainer",
                data: {
                    switch: enabled ? 1 : 0,
                    continue_time: continueTime,
                },
            });
        } else if (control === "rainContinueTimeHours") {
            const intValue = Math.round(Number(value));
            if (intValue < 0 || intValue > 8) {
                throw new AnthbotGenieError("Rain continue time must be 0..8 hours");
            }
            await context.shadowClient.publishServiceCommand({
                cmd: "ctl_rainer",
                data: {
                    switch: coerceEnabledValue(data.rain_switch) ? 1 : 0,
                    continue_time: intValue * 3600,
                },
            });
        }

        await context.shadowClient.requestAllProperties();
        await this.delay(1000);
    }

    resolveManualZoneSelection(context, value) {
        const wanted = parseCommandSelection(value);
        const zones = manualZones({
            ...context.lastReported,
            _area_definition: context.areaDefinition || {},
        });
        const ids = new Set();
        for (const item of wanted) {
            if (typeof item === "number" || /^\d+$/.test(String(item))) {
                const asNumber = Number(item);
                if (zones.some(zone => zone.id === asNumber)) {
                    ids.add(asNumber);
                }
                continue;
            }
            const needle = String(item).trim().toLowerCase();
            for (const zone of zones) {
                if (typeof zone.name === "string" && zone.name.trim().toLowerCase() === needle && Number.isInteger(zone.id)) {
                    ids.add(zone.id);
                }
            }
        }
        return [...ids];
    }

    resolveAutoZoneSelection(context, value) {
        const wanted = parseCommandSelection(value);
        const zones = autoZones({
            ...context.lastReported,
            _area_definition: context.areaDefinition || {},
        });
        const points = [];
        const seen = new Set();
        for (const item of wanted) {
            for (const zone of zones) {
                const idMatch = (typeof item === "number" || /^\d+$/.test(String(item))) && zone.id === Number(item);
                const nameMatch = typeof zone.name === "string" && zone.name.trim().toLowerCase() === String(item).trim().toLowerCase();
                if ((idMatch || nameMatch) && Number.isInteger(zone.x) && Number.isInteger(zone.y)) {
                    const key = `${zone.x}:${zone.y}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        points.push([zone.x, zone.y]);
                    }
                }
            }
        }
        return points;
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

if (module.parent) {
    module.exports = options => new AnthbotGenieAdapter(options);
} else {
    new AnthbotGenieAdapter();
}
