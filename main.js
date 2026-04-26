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
    isLikelyAuthenticationError,
    isCharging,
    isCustomDirectionEnabled,
    manualZones,
    parseCommandSelection,
    rawRobotStatus,
} = require("./lib/anthbot");

function t(en, de) {
    return { en, de };
}

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

        await this.ensureBaseObjects();
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

    async ensureBaseObjects() {
        await this.extendObjectAsync("info.connection", {
            type: "state",
            common: {
                name: t("Cloud connection", "Cloud-Verbindung"),
                type: "boolean",
                role: "indicator.connected",
                read: true,
                write: false,
                def: false,
            },
            native: {},
        });
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
        return this.runRefreshCycle(forceLogin, false);
    }

    async runRefreshCycle(forceLogin, retriedAfterAuthFailure) {
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
            if (!retriedAfterAuthFailure && !forceLogin && isLikelyAuthenticationError(error)) {
                this.log.info("Anthbot cloud session expired, retrying refresh with a new login.");
                return this.runRefreshCycle(true, true);
            }
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

        const seenSerials = new Set(devices.map(device => device.serialNumber));
        await this.removeStaleDeviceContexts(seenSerials);

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

    async removeStaleDeviceContexts(seenSerials) {
        for (const serial of this.deviceContexts.keys()) {
            if (seenSerials.has(serial)) {
                continue;
            }
            this.deviceContexts.delete(serial);
            try {
                await this.delObjectAsync(serial, { recursive: true });
                this.log.info(`Removed stale device objects for ${serial}.`);
            } catch (error) {
                this.log.warn(`Failed to remove stale device objects for ${serial}: ${error.message}`);
            }
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
            ["info", "channel", t("Info", "Informationen"), null],
            ["metrics", "channel", t("Metrics", "Messwerte"), null],
            ["consumable", "channel", t("Consumable", "Verbrauchsmaterial"), null],
            ["controls", "channel", t("Controls", "Steuerung"), null],
            ["commands", "channel", t("Commands", "Befehle"), null],
            ["zones", "channel", t("Zones", "Zonen"), null],
            ["raw", "channel", t("Raw", "Rohdaten"), null],
        ];

        for (const [id, type, name] of definitions) {
            await this.setObjectNotExistsAsync(`${root}.${id}`, {
                type,
                common: { name },
                native: {},
            });
        }

        const states = {
            "info.alias": { type: "string", role: "text", read: true, write: false, name: t("Alias", "Alias") },
            "info.model": { type: "string", role: "text", read: true, write: false, name: t("Model", "Modell") },
            "info.region": { type: "string", role: "text", read: true, write: false, name: t("Region", "Region") },
            "info.endpoint": { type: "string", role: "text", read: true, write: false, name: t("IoT endpoint", "IoT-Endpunkt") },
            "info.online": { type: "boolean", role: "indicator.reachable", read: true, write: false, name: t("Online", "Online") },
            "info.charging": { type: "boolean", role: "indicator.working", read: true, write: false, name: t("Charging", "Lädt") },
            "info.lastServiceCommand": { type: "string", role: "text", read: true, write: false, name: t("Last service command", "Letzter Servicebefehl") },
            "info.lastPoll": { type: "string", role: "date", read: true, write: false, name: t("Last poll", "Letzte Abfrage") },
            "consumable.station": { type: "number", role: "value.usage.station", unit: "%", read: true, write: false, name: t("Station lifetime", "Station Lebensdauer") },
            "consumable.cameras": { type: "number", role: "value.usage.cameras", unit: "%", read: true, write: false, name: t("Cameras lifetime", "Kameras Lebensdauer") },
            "consumable.blades": { type: "number", role: "value.usage.blades", unit: "%", read: true, write: false, name: t("Blades lifetime", "Klingen Lebensdauer") },
            "metrics.batteryLevel": { type: "number", role: "value.battery", unit: "%", read: true, write: false, name: t("Battery level", "Akkustand") },
            "metrics.mowerStatus": { type: "string", role: "value", read: true, write: false, name: t("Mower status", "Mäherstatus") },
            "metrics.robotStatusRaw": { type: "string", role: "text", read: true, write: false, name: t("Raw robot status", "Rohstatus des Roboters") },
            "metrics.cuttingHeight": { type: "number", role: "value", unit: "mm", read: true, write: false, name: t("Cutting height", "Schnitthöhe") },
            "metrics.voiceVolume": { type: "number", role: "level.volume", unit: "%", read: true, write: false, name: t("Voice volume", "Sprachlautstärke") },
            "metrics.mowingTime": { type: "number", role: "value.interval", unit: "s", read: true, write: false, name: t("Mowing time", "Mähzeit") },
            "metrics.mowingArea": { type: "number", role: "value", unit: "m²", read: true, write: false, name: t("Mowing area", "Gemähte Fläche") },
            "metrics.customMowingDirection": { type: "number", role: "value", unit: "deg", read: true, write: false, name: t("Custom mowing direction", "Benutzerdefinierte Mährichtung") },
            "metrics.customMowingDirectionEnabled": { type: "boolean", role: "indicator", read: true, write: false, name: t("Custom mowing direction enabled", "Benutzerdefinierte Mährichtung aktiv") },
            "metrics.rainPerceptionEnabled": { type: "boolean", role: "indicator", read: true, write: false, name: t("Rain perception enabled", "Regenerkennung aktiv") },
            "metrics.rainContinueTime": { type: "number", role: "value.interval", unit: "s", read: true, write: false, name: t("Rain continue time", "Regen-Fortsetzungszeit") },
            "controls.mowHeight": { type: "number", role: "level", unit: "mm", min: 30, max: 70, read: true, write: true, name: t("Set mow height", "Mähhöhe einstellen") },
            "controls.voiceVolume": { type: "number", role: "level.volume", unit: "%", min: 0, max: 100, read: true, write: true, name: t("Set voice volume", "Sprachlautstärke einstellen") },
            "controls.customMowingDirection": { type: "number", role: "level", unit: "deg", min: 0, max: 180, read: true, write: true, name: t("Set custom mowing direction", "Benutzerdefinierte Mährichtung einstellen") },
            "controls.customMowingDirectionEnabled": { type: "boolean", role: "switch", read: true, write: true, name: t("Enable custom mowing direction", "Benutzerdefinierte Mährichtung aktivieren") },
            "controls.rainPerceptionEnabled": { type: "boolean", role: "switch", read: true, write: true, name: t("Enable rain perception", "Regenerkennung aktivieren") },
            "controls.rainContinueTimeHours": { type: "number", role: "level", unit: "h", min: 0, max: 8, read: true, write: true, name: t("Set rain continue time", "Regen-Fortsetzungszeit einstellen") },
            "commands.startFullMow": { type: "boolean", role: "button", read: true, write: true, name: t("Start full mow", "Vollständiges Mähen starten"), def: false },
            "commands.stopMow": { type: "boolean", role: "button", read: true, write: true, name: t("Stop mow", "Mähen stoppen"), def: false },
            "commands.returnToDock": { type: "boolean", role: "button", read: true, write: true, name: t("Return to dock", "Zur Ladestation zurückkehren"), def: false },
            "commands.requestRefresh": { type: "boolean", role: "button", read: true, write: true, name: t("Request refresh", "Aktualisierung anfordern"), def: false },
            "commands.zoneMow": { type: "string", role: "text", read: true, write: true, name: t("Start manual zone mow", "Manuelles Zonenmähen starten") },
            "commands.autoZoneMow": { type: "string", role: "text", read: true, write: true, name: t("Start auto zone mow", "Automatisches Zonenmähen starten") },
            "zones.manual": { type: "string", role: "json", read: true, write: false, name: t("Manual zones", "Manuelle Zonen") },
            "zones.auto": { type: "string", role: "json", read: true, write: false, name: t("Auto zones", "Automatische Zonen") },
            "zones.activeManualIds": { type: "string", role: "json", read: true, write: false, name: t("Active manual zone IDs", "Aktive manuelle Zonen-IDs") },
            "raw.property": { type: "string", role: "json", read: true, write: false, name: t("Raw property shadow", "Rohdaten Property Shadow") },
            "raw.service": { type: "string", role: "json", read: true, write: false, name: t("Raw service shadow", "Rohdaten Service Shadow") },
            "raw.areaDefinition": { type: "string", role: "json", read: true, write: false, name: t("Raw area definition", "Rohdaten Flächendefinition") },
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
                if (isLikelyAuthenticationError(error)) {
                    await this.ensureSession(true);
                    context.areaDefinition = await this.cloudClient.getDeviceAreaDefinition(context.device.serialNumber);
                    context.lastAreaTime = areaTime;
                } else {
                    this.log.debug(`Area definition refresh failed for ${context.device.serialNumber}: ${error.message}`);
                }
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

            // 2026-04-26: The cloud API misspells "percent" as "pecent" in the robot_maintenance object, so we need to use the wrong spelling here to get the data until it's fixed upstream.
            "consumable.station": typeof data.robot_maintenance?.ccp_pecent === "number" ? data.robot_maintenance.ccp_pecent : null,
            "consumable.cameras": typeof data.robot_maintenance?.cl_pecent === "number" ? data.robot_maintenance.cl_pecent : null,
            "consumable.blades": typeof data.robot_maintenance?.rc_pecent === "number" ? data.robot_maintenance.rc_pecent : null,

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

        let commandError = null;
        try {
            if (section === "commands") {
                await this.handleCommandState(context, command, state.val);
            } else if (section === "controls") {
                await this.handleControlState(context, command, state.val);
            }
        } catch (error) {
            commandError = error;
        } finally {
            try {
                await this.refreshDevice(context);
            } catch (refreshError) {
                this.log.warn(`Post-command refresh failed for ${id}: ${refreshError.message}`);
            }
            await this.resetWriteState(id, section, command, context);
        }

        if (commandError) {
            this.log.error(`Command failed for ${id}: ${commandError.message}`);
        }
    }

    async resetWriteState(id, section, command, context) {
        if (["startFullMow", "stopMow", "returnToDock", "requestRefresh"].includes(command)) {
            await this.setStateAsync(id, { val: false, ack: true });
            return;
        }
        if (["zoneMow", "autoZoneMow"].includes(command)) {
            await this.setStateAsync(id, { val: "", ack: true });
            return;
        }
        if (section === "controls") {
            const fallbackValue = this.getControlFallbackValue(context, command);
            if (fallbackValue !== undefined) {
                await this.setStateAsync(id, { val: fallbackValue, ack: true });
            }
        }
    }

    getControlFallbackValue(context, control) {
        const data = context.lastReported || {};
        if (control === "mowHeight") {
            if (typeof data?.param_set?.cutter_height === "number") {
                return data.param_set.cutter_height;
            }
            if (typeof data?.mow_remote?.cutter_height === "number") {
                return data.mow_remote.cutter_height;
            }
            return null;
        }
        if (control === "voiceVolume") {
            return typeof data.volume === "number" ? data.volume : null;
        }
        if (control === "customMowingDirection") {
            return typeof data?.param_set?.mow_head === "number" ? data.param_set.mow_head : null;
        }
        if (control === "customMowingDirectionEnabled") {
            return isCustomDirectionEnabled(data);
        }
        if (control === "rainPerceptionEnabled") {
            return coerceEnabledValue(data.rain_switch);
        }
        if (control === "rainContinueTimeHours") {
            return typeof data.rain_continue_time === "number" ? Math.round(data.rain_continue_time / 3600) : null;
        }
        return undefined;
    }

    async handleCommandState(context, command, value) {
        const shouldRun = value === true || value === 1 || value === "true" || (typeof value === "string" && value.trim() !== "");
        if (!shouldRun) {
            return;
        }

        const shouldRequestProperties = await this.executeCommand(context, command, value);
        if (shouldRequestProperties) {
            await context.shadowClient.requestAllProperties();
        }
        await this.delay(1000);
    }

    async handleControlState(context, control, value) {
        if (value === null || value === undefined || value === "") {
            return;
        }

        await this.executeControl(context, control, value);
        await context.shadowClient.requestAllProperties();
        await this.delay(1000);
    }

    async executeCommand(context, command, value) {
        switch (command) {
            case "startFullMow":
                await context.shadowClient.publishServiceCommand({ cmd: "app_state", data: 1 });
                await context.shadowClient.publishServiceCommand({ cmd: "mow_start", data: 1 });
                return true;
            case "stopMow":
                await context.shadowClient.publishServiceCommand({ cmd: "stop_all_tasks", data: 1 });
                return true;
            case "returnToDock":
                await context.shadowClient.publishServiceCommand({ cmd: "charge_start", data: 1 });
                return true;
            case "requestRefresh":
                await context.shadowClient.requestAllProperties();
                return false;
            case "zoneMow": {
                const matchedIds = this.resolveManualZoneSelection(context, value);
                if (!matchedIds.length) {
                    throw new AnthbotGenieError("No matching manual zones found");
                }
                await context.shadowClient.publishServiceCommand({
                    cmd: "custom_area_mow_start",
                    data: { id: matchedIds },
                });
                return true;
            }
            case "autoZoneMow": {
                const points = this.resolveAutoZoneSelection(context, value);
                if (!points.length) {
                    throw new AnthbotGenieError("No matching auto zones found");
                }
                await context.shadowClient.publishServiceCommand({
                    cmd: "region_mow_start",
                    data: { points },
                });
                return true;
            }
            default:
                throw new AnthbotGenieError(`Unsupported command '${command}'`);
        }
    }

    async executeControl(context, control, value) {
        const data = context.lastReported || {};

        switch (control) {
            case "mowHeight": {
                const intValue = this.parseIntegerControlValue(value, {
                    label: "Mow height",
                    min: 30,
                    max: 70,
                    step: 5,
                    suffix: "in 5 mm steps",
                });
                await context.shadowClient.publishServiceCommand({
                    cmd: "param_set",
                    data: { cutter_height: intValue, rid_switch: 0 },
                });
                return;
            }
            case "voiceVolume": {
                const intValue = this.parseIntegerControlValue(value, {
                    label: "Voice volume",
                    min: 0,
                    max: 100,
                });
                await context.shadowClient.publishServiceCommand({
                    cmd: "volume_ctl",
                    data: { volume: intValue },
                });
                return;
            }
            case "customMowingDirection": {
                const intValue = this.parseIntegerControlValue(value, {
                    label: "Custom mowing direction",
                    min: 0,
                    max: 180,
                });
                await context.shadowClient.publishServiceCommand({
                    cmd: "param_set",
                    data: { mow_head: intValue, enable_adaptive_head: 0 },
                });
                return;
            }
            case "customMowingDirectionEnabled": {
                const enabled = coerceEnabledValue(value);
                const mowHead = typeof data?.param_set?.mow_head === "number" ? data.param_set.mow_head : 0;
                await context.shadowClient.publishServiceCommand({
                    cmd: "param_set",
                    data: {
                        mow_head: mowHead,
                        enable_adaptive_head: enabled ? 0 : 1,
                    },
                });
                return;
            }
            case "rainPerceptionEnabled": {
                const enabled = coerceEnabledValue(value);
                const continueTime = typeof data.rain_continue_time === "number" && data.rain_continue_time > 0 ? data.rain_continue_time : 10800;
                await context.shadowClient.publishServiceCommand({
                    cmd: "ctl_rainer",
                    data: {
                        switch: enabled ? 1 : 0,
                        continue_time: continueTime,
                    },
                });
                return;
            }
            case "rainContinueTimeHours": {
                const intValue = this.parseIntegerControlValue(value, {
                    label: "Rain continue time",
                    min: 0,
                    max: 8,
                    suffix: "hours",
                });
                await context.shadowClient.publishServiceCommand({
                    cmd: "ctl_rainer",
                    data: {
                        switch: coerceEnabledValue(data.rain_switch) ? 1 : 0,
                        continue_time: intValue * 3600,
                    },
                });
                return;
            }
            default:
                throw new AnthbotGenieError(`Unsupported control '${control}'`);
        }
    }

    parseIntegerControlValue(value, { label, min, max, step = 1, suffix = "" }) {
        const intValue = Math.round(Number(value));
        const invalidStep = step > 1 && intValue % step !== 0;
        if (!Number.isFinite(intValue) || intValue < min || intValue > max || invalidStep) {
            const rangeText = `${min}..${max}`;
            const suffixText = suffix ? ` ${suffix}` : "";
            throw new AnthbotGenieError(`${label} must be ${rangeText}${suffixText}`);
        }
        return intValue;
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
