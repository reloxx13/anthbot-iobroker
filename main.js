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
        this.subscribeStates("*.consumable.*_reset");

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
            "consumable.station_reset": { type: "boolean", role: "button", read: true, write: true, name: t("Reset station lifetime", "Station-Lebensdauer zurücksetzen"), def: false },
            "consumable.cameras_reset": { type: "boolean", role: "button", read: true, write: true, name: t("Reset cameras lifetime", "Kameras-Lebensdauer zurücksetzen"), def: false },
            "consumable.blades_reset": { type: "boolean", role: "button", read: true, write: true, name: t("Reset blades lifetime", "Klingen-Lebensdauer zurücksetzen"), def: false },
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
            "metrics.nearChargerMowingEnabled": { type: "boolean", role: "indicator", read: true, write: false, name: t("Mowing near charging pile enabled", "Mähen nahe der Ladestation aktiv") },
            "metrics.nearChargerMowHeight": { type: "number", role: "value", unit: "mm", read: true, write: false, name: t("Near charger mow height", "Mähhöhe nahe der Ladestation") },
            "metrics.nearChargerMowCount": { type: "number", role: "value", read: true, write: false, name: t("Near charger mow count", "Mähdurchgänge nahe der Ladestation") },
            "metrics.nearChargerObstacleAvoidanceEnabled": { type: "boolean", role: "indicator", read: true, write: false, name: t("Near charger obstacle avoidance enabled", "Hindernisvermeidung nahe der Ladestation aktiv") },
            "metrics.nearChargerObstacleAvoidanceLevel": { type: "number", role: "value", read: true, write: false, name: t("Near charger obstacle avoidance level", "Hindernisvermeidung nahe der Ladestation Stufe") },
            "metrics.pointMowActive": { type: "boolean", role: "indicator", read: true, write: false, name: t("Point mowing active", "Punktmähen aktiv") },
            "metrics.pointMowX": { type: "number", role: "value", read: true, write: false, name: t("Point mowing X", "Punktmähen X") },
            "metrics.pointMowY": { type: "number", role: "value", read: true, write: false, name: t("Point mowing Y", "Punktmähen Y") },
            "metrics.cameraEnabled": { type: "boolean", role: "indicator", read: true, write: false, name: t("Camera enabled", "Kamera aktiv") },
            "metrics.rtkAntennaMoved": { type: "boolean", role: "indicator", read: true, write: false, name: t("RTK antenna moved", "RTK-Antenne bewegt") },
            "controls.mowHeight": { type: "number", role: "level", unit: "mm", min: 30, max: 70, read: true, write: true, name: t("Set mow height", "Mähhöhe einstellen") },
            "controls.voiceVolume": { type: "number", role: "level.volume", unit: "%", min: 0, max: 100, read: true, write: true, name: t("Set voice volume", "Sprachlautstärke einstellen") },
            "controls.customMowingDirection": { type: "number", role: "level", unit: "deg", min: 0, max: 180, read: true, write: true, name: t("Set custom mowing direction", "Benutzerdefinierte Mährichtung einstellen") },
            "controls.customMowingDirectionEnabled": { type: "boolean", role: "switch", read: true, write: true, name: t("Enable custom mowing direction", "Benutzerdefinierte Mährichtung aktivieren") },
            "controls.rainPerceptionEnabled": { type: "boolean", role: "switch", read: true, write: true, name: t("Enable rain perception", "Regenerkennung aktivieren") },
            "controls.rainContinueTimeHours": { type: "number", role: "level", unit: "h", min: 0, max: 8, read: true, write: true, name: t("Set rain continue time", "Regen-Fortsetzungszeit einstellen") },
            "controls.nearChargerMowingEnabled": { type: "boolean", role: "switch", read: true, write: true, name: t("Enable mowing near charging pile", "Mähen nahe der Ladestation aktivieren") },
            "controls.nearChargerMowHeight": { type: "number", role: "level", unit: "mm", min: 30, max: 70, read: true, write: true, name: t("Set near charger mow height", "Mähhöhe nahe der Ladestation einstellen") },
            "controls.nearChargerMowCount": { type: "number", role: "level", min: 1, max: 3, read: true, write: true, name: t("Set near charger mow count", "Mähdurchgänge nahe der Ladestation einstellen") },
            "controls.nearChargerObstacleAvoidanceEnabled": { type: "boolean", role: "switch", read: true, write: true, name: t("Enable near charger obstacle avoidance", "Hindernisvermeidung nahe der Ladestation aktivieren") },
            "controls.nearChargerObstacleAvoidanceLevel": { type: "number", role: "level", min: 0, max: 2, read: true, write: true, name: t("Set near charger obstacle avoidance level", "Hindernisvermeidung nahe der Ladestation einstellen") },
            "controls.cameraEnabled": { type: "boolean", role: "switch", read: true, write: true, name: t("Enable camera", "Kamera aktivieren") },
            "commands.findRobot": { type: "boolean", role: "button", read: true, write: true, name: t("Find robot", "Roboter finden"), def: false },
            "commands.startFullMow": { type: "boolean", role: "button", read: true, write: true, name: t("Start full mow", "Vollständiges Mähen starten"), def: false },
            "commands.pauseMow": { type: "boolean", role: "button", read: true, write: true, name: t("Pause mowing", "Mähen pausieren"), def: false },
            "commands.continueMow": { type: "boolean", role: "button", read: true, write: true, name: t("Continue mowing", "Mähen fortsetzen"), def: false },
            "commands.stopMow": { type: "boolean", role: "button", read: true, write: true, name: t("Stop mow", "Mähen stoppen"), def: false },
            "commands.returnToDock": { type: "boolean", role: "button", read: true, write: true, name: t("Return to dock", "Zur Ladestation zurückkehren"), def: false },
            "commands.pauseReturnToDock": { type: "boolean", role: "button", read: true, write: true, name: t("Pause return to dock", "Rückfahrt zur Ladestation pausieren"), def: false },
            "commands.continueReturnToDock": { type: "boolean", role: "button", read: true, write: true, name: t("Continue return to dock", "Rückfahrt zur Ladestation fortsetzen"), def: false },
            "commands.startGrassDump": { type: "boolean", role: "button", read: true, write: true, name: t("Start grass dump", "Grasablage starten"), def: false },
            "commands.startDiskMaintenance": { type: "boolean", role: "button", read: true, write: true, name: t("Start disk maintenance mode", "Scheibenwartungsmodus starten"), def: false },
            "commands.startEdgeMow": { type: "boolean", role: "button", read: true, write: true, name: t("Start edge mow", "Kantenmähen starten"), def: false },
            "commands.startNearChargerMow": { type: "boolean", role: "button", read: true, write: true, name: t("Start mowing near charging pile", "Mähen nahe der Ladestation starten"), def: false },
            "commands.endMow": { type: "boolean", role: "button", read: true, write: true, name: t("End mowing", "Mähen beenden"), def: false },
            "commands.cancelRtkAntennaMoved": { type: "boolean", role: "button", read: true, write: true, name: t("Cancel RTK antenna moved warning", "RTK-Antenne-bewegt-Warnung abbrechen"), def: false },
            "commands.requestRefresh": { type: "boolean", role: "button", read: true, write: true, name: t("Request refresh", "Aktualisierung anfordern"), def: false },
            "commands.zoneMow": { type: "string", role: "text", read: true, write: true, name: t("Start manual zone mow", "Manuelles Zonenmähen starten") },
            "commands.autoZoneMow": { type: "string", role: "text", read: true, write: true, name: t("Start auto zone mow", "Automatisches Zonenmähen starten") },
            "commands.pointMow": { type: "string", role: "text", read: true, write: true, name: t("Start point mow", "Punktmähen starten") },
            "commands.stopPointMow": { type: "boolean", role: "button", read: true, write: true, name: t("Stop point mow", "Punktmähen stoppen"), def: false },
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
        const nearChargerMowingEnabled = coerceEnabledValue(data.near_chg_mow_ctl);
        const nearChargerSettings = this.nearChargerMowingSettings(data);
        const pointMow = data?.mow_point && typeof data.mow_point === "object" ? data.mow_point : {};
        const rtkAntennaMoved = coerceEnabledValue(data?.rtk_move_sta?.value);
        const cameraEnabled = coerceEnabledValue(data.camera_switch);
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
            "metrics.nearChargerMowingEnabled": nearChargerMowingEnabled,
            "metrics.nearChargerMowHeight": nearChargerSettings.cutter_height,
            "metrics.nearChargerMowCount": nearChargerSettings.mow_count,
            "metrics.nearChargerObstacleAvoidanceEnabled": coerceEnabledValue(nearChargerSettings.pobctl_switch),
            "metrics.nearChargerObstacleAvoidanceLevel": nearChargerSettings.pobctl_level,
            "metrics.pointMowActive": coerceEnabledValue(pointMow.sta),
            "metrics.pointMowX": typeof pointMow.x === "number" ? pointMow.x : null,
            "metrics.pointMowY": typeof pointMow.y === "number" ? pointMow.y : null,
            "metrics.cameraEnabled": cameraEnabled,
            "metrics.rtkAntennaMoved": rtkAntennaMoved,

            "controls.mowHeight": cutterHeight,
            "controls.voiceVolume": typeof data.volume === "number" ? data.volume : null,
            "controls.customMowingDirection": customDirection,
            "controls.customMowingDirectionEnabled": isCustomDirectionEnabled(data),
            "controls.rainPerceptionEnabled": rainPerceptionEnabled,
            "controls.rainContinueTimeHours": typeof rainContinueTime === "number" ? Math.round(rainContinueTime / 3600) : null,
            "controls.nearChargerMowingEnabled": nearChargerMowingEnabled,
            "controls.nearChargerMowHeight": nearChargerSettings.cutter_height,
            "controls.nearChargerMowCount": nearChargerSettings.mow_count,
            "controls.nearChargerObstacleAvoidanceEnabled": coerceEnabledValue(nearChargerSettings.pobctl_switch),
            "controls.nearChargerObstacleAvoidanceLevel": nearChargerSettings.pobctl_level,
            "controls.cameraEnabled": cameraEnabled,

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
            } else if (section === "consumable") {
                await this.handleConsumableState(context, command, state.val);
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
        if (["findRobot", "startFullMow", "pauseMow", "continueMow", "stopMow", "returnToDock", "pauseReturnToDock", "continueReturnToDock", "startGrassDump", "startDiskMaintenance", "startEdgeMow", "startNearChargerMow", "endMow", "stopPointMow", "cancelRtkAntennaMoved", "requestRefresh", "station_reset", "cameras_reset", "blades_reset"].includes(command)) {
            await this.setStateAsync(id, { val: false, ack: true });
            return;
        }
        if (["zoneMow", "autoZoneMow", "pointMow"].includes(command)) {
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
        if (control === "nearChargerMowingEnabled") {
            return coerceEnabledValue(data.near_chg_mow_ctl);
        }
        if (control === "nearChargerMowHeight") {
            return this.nearChargerMowingSettings(data).cutter_height;
        }
        if (control === "nearChargerMowCount") {
            return this.nearChargerMowingSettings(data).mow_count;
        }
        if (control === "nearChargerObstacleAvoidanceEnabled") {
            return coerceEnabledValue(this.nearChargerMowingSettings(data).pobctl_switch);
        }
        if (control === "nearChargerObstacleAvoidanceLevel") {
            return this.nearChargerMowingSettings(data).pobctl_level;
        }
        if (control === "cameraEnabled") {
            return coerceEnabledValue(data.camera_switch);
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

    async handleConsumableState(context, command, value) {
        const shouldRun = value === true || value === 1 || value === "true";
        if (!shouldRun) {
            return;
        }

        await this.executeConsumableCommand(context, command);
        await this.delay(1000);
    }

    async executeCommand(context, command, value) {
        switch (command) {
            case "findRobot":
                await context.shadowClient.publishServiceCommand({ cmd: "find_robot" });
                return true;
            case "startFullMow":
                await context.shadowClient.publishServiceCommand({ cmd: "app_state", data: 1 });
                await context.shadowClient.publishServiceCommand({ cmd: "mow_start", data: 1 });
                return true;
            case "pauseMow":
                await context.shadowClient.publishServiceCommand({ cmd: "mow_pause" });
                return true;
            case "continueMow":
                await context.shadowClient.publishServiceCommand({ cmd: "mow_continue" });
                return true;
            case "stopMow":
                await context.shadowClient.publishServiceCommand({ cmd: "stop_all_tasks", data: 1 });
                return true;
            case "endMow":
                await context.shadowClient.publishServiceCommand({ cmd: "stop_all_tasks", data: 1 });
                return true;
            case "cancelRtkAntennaMoved":
                await context.shadowClient.publishServiceCommand({ cmd: "clear_rtk_move" });
                return true;
            case "returnToDock":
                await context.shadowClient.publishServiceCommand({ cmd: "charge_start", data: 1 });
                return true;
            case "pauseReturnToDock":
                await context.shadowClient.publishServiceCommand({ cmd: "charge_pause" });
                return true;
            case "continueReturnToDock":
                await context.shadowClient.publishServiceCommand({ cmd: "charge_continue" });
                return true;
            case "startGrassDump":
                await context.shadowClient.publishServiceCommand({ cmd: "start_dump" });
                return true;
            case "startDiskMaintenance":
                await context.shadowClient.publishServiceCommand({ cmd: "clean_mode_cmd" });
                return true;
            case "startEdgeMow":
                await context.shadowClient.publishServiceCommand({ cmd: "ridable_mow_start", data: 1 });
                return true;
            case "startNearChargerMow":
                await context.shadowClient.publishServiceCommand({ cmd: "nest_mow_start", data: 1 });
                return true;
            case "pointMow": {
                await context.shadowClient.publishServiceCommand({
                    cmd: "mow_point",
                    data: this.parsePointMowValue(value),
                });
                return true;
            }
            case "stopPointMow":
                await context.shadowClient.publishServiceCommand({ cmd: "mow_point_stop" });
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

    async executeConsumableCommand(context, command) {
        const maintenanceTypes = {
            "blades_reset": 0,
            "cameras_reset": 1,
            "station_reset": 2,
        };
        const robotMaintenance = maintenanceTypes[command];

        if (robotMaintenance === undefined) {
            throw new AnthbotGenieError(`Unsupported consumable command '${command}'`);
        }

        await context.shadowClient.publishServiceCommand({
            cmd: "robot_maintenance_reset",
            robot_maintenance: robotMaintenance,
        });
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
            case "nearChargerMowingEnabled": {
                const enabled = coerceEnabledValue(value);
                await context.shadowClient.publishServiceCommand({
                    cmd: "ctl_near_chg_mow",
                    data: { switch: enabled ? 1 : 0 },
                });
                return;
            }
            case "nearChargerMowHeight": {
                const intValue = this.parseIntegerControlValue(value, {
                    label: "Near charger mow height",
                    min: 30,
                    max: 70,
                    step: 5,
                    suffix: "in 5 mm steps",
                });
                await context.shadowClient.publishServiceCommand({
                    cmd: "nest_param_set",
                    data: { ...this.nearChargerMowingSettings(data, true), cutter_height: intValue },
                });
                return;
            }
            case "nearChargerMowCount": {
                const intValue = this.parseIntegerControlValue(value, {
                    label: "Near charger mow count",
                    min: 1,
                    max: 3,
                });
                await context.shadowClient.publishServiceCommand({
                    cmd: "nest_param_set",
                    data: { ...this.nearChargerMowingSettings(data, true), mow_count: intValue },
                });
                return;
            }
            case "nearChargerObstacleAvoidanceEnabled": {
                const enabled = coerceEnabledValue(value);
                await context.shadowClient.publishServiceCommand({
                    cmd: "nest_param_set",
                    data: { ...this.nearChargerMowingSettings(data, true), pobctl_switch: enabled ? 1 : 0 },
                });
                return;
            }
            case "nearChargerObstacleAvoidanceLevel": {
                const intValue = this.parseIntegerControlValue(value, {
                    label: "Near charger obstacle avoidance level",
                    min: 0,
                    max: 2,
                });
                await context.shadowClient.publishServiceCommand({
                    cmd: "nest_param_set",
                    data: { ...this.nearChargerMowingSettings(data, true), pobctl_level: intValue },
                });
                return;
            }
            case "cameraEnabled": {
                const enabled = coerceEnabledValue(value);
                await context.shadowClient.publishServiceCommand({
                    cmd: "camera_switch",
                    data: { switch: enabled ? 1 : 0 },
                });
                return;
            }
            default:
                throw new AnthbotGenieError(`Unsupported control '${control}'`);
        }
    }

    nearChargerMowingSettings(data, withDefaults = false) {
        const settings = data?.nest_param_set && typeof data.nest_param_set === "object" ? data.nest_param_set : {};
        return {
            cutter_height: typeof settings.cutter_height === "number" ? settings.cutter_height : withDefaults ? 30 : null,
            mow_count: typeof settings.mow_count === "number" ? settings.mow_count : withDefaults ? 2 : null,
            pobctl_level: typeof settings.pobctl_level === "number" ? settings.pobctl_level : withDefaults ? 0 : null,
            pobctl_switch: typeof settings.pobctl_switch === "number" ? settings.pobctl_switch : withDefaults ? 1 : null,
        };
    }

    parsePointMowValue(value) {
        let parsed = value;
        if (typeof value === "string") {
            const trimmed = value.trim();
            if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
                try {
                    parsed = JSON.parse(trimmed);
                } catch (error) {
                    throw new AnthbotGenieError(`Point mow value is invalid JSON: ${error.message}`);
                }
            } else {
                parsed = trimmed.split(",").map(part => part.trim());
            }
        }

        const x = Array.isArray(parsed) ? parsed[0] : parsed?.x;
        const y = Array.isArray(parsed) ? parsed[1] : parsed?.y;
        const point = {
            x: Math.round(Number(x)),
            y: Math.round(Number(y)),
        };

        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
            throw new AnthbotGenieError("Point mow must be \"x,y\" or {\"x\":number,\"y\":number}");
        }
        return point;
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
