"use strict";

const crypto = require("node:crypto");

const DEFAULT_IOT_REGION = "us-east-1";
const DEFAULT_IOT_ENDPOINT = "a2bhy9nr7jkgaj-ats.iot.us-east-1.amazonaws.com";
const IOT_ENDPOINT_TEMPLATE = "a2bhy9nr7jkgaj-ats.iot.{region}.amazonaws.com";
const CN_NORTHWEST_IOT_ENDPOINT = "a2iw0czxjowiip-ats.iot.cn-northwest-1.amazonaws.com.cn";
const AWS_ACCESS_KEY_DEFAULT = "AKIAV2C4RVIAOLEXB545";
const AWS_SECRET_KEY_DEFAULT = "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";
const AWS_ACCESS_KEY_CN = "AKIAWJ3KIT7IV6AHMJ5V";
const AWS_SECRET_KEY_CN = "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";
const AWS_ACCESS_KEY_CN_NORTHWEST = "AKIAYVWVSSRF7W5YWI74";
const AWS_SECRET_KEY_CN_NORTHWEST = "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";

const ROBOT_STATUS_BY_CODE = [
    "idle",
    "pause",
    "charge",
    "sleep",
    "ota",
    "position",
    "globalmowing",
    "zonemowing",
    "pointmowing",
    "mapping",
    "backtodock",
    "resume_point",
    "shutdown",
    "remotectrl",
    "factory",
    "sleep",
    "camera_cleaning",
    "gototarget",
    "bordermowing",
    "regionmowing",
    "nestmowing",
];

class AnthbotGenieError extends Error {
    constructor(message) {
        super(message);
        this.name = "AnthbotGenieError";
    }
}

function isLikelyAuthenticationError(error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return /(401|403|auth|authorization|unauthori[sz]ed|token|bearer token|login rejected)/i.test(message);
}

class AnthbotCloudApiClient {
    constructor({ http, host, bearerToken = null }) {
        this.http = http;
        this.host = host;
        this.bearerToken = bearerToken;
        this.authHeaders = {
            Accept: "application/json, text/plain, */*",
            version: "v2",
            language: "en",
            "User-Agent": "LdMower/1581 CFNetwork/3860.400.51 Darwin/25.3.0",
        };
        if (bearerToken) {
            this.authHeaders.Authorization = bearerToken;
        }
    }

    async login({ username, password, areaCode }) {
        const response = await this.http.post(`https://${this.host}/api/v1/login`, {
            username,
            password,
            areaCode,
        }, {
            headers: {
                Accept: "application/json, text/plain, */*",
                "content-type": "application/json",
                version: "v2",
                language: "en",
                "User-Agent": "LdMower/1581 CFNetwork/3860.400.51 Darwin/25.3.0",
            },
        });
        const data = response.data;
        if (response.status !== 200) {
            throw new AnthbotGenieError(`Login failed (${response.status}): ${String(response.data).slice(0, 300)}`);
        }
        if (!data || typeof data !== "object") {
            throw new AnthbotGenieError("Invalid login payload type");
        }
        if (data.code !== 0) {
            throw new AnthbotGenieError(`Login rejected: code=${JSON.stringify(data.code)}`);
        }
        const accessToken = data?.data?.access_token;
        if (typeof accessToken !== "string" || !accessToken) {
            throw new AnthbotGenieError("Login payload missing access_token");
        }
        this.bearerToken = `Bearer ${accessToken}`;
        this.authHeaders.Authorization = this.bearerToken;
        return this.bearerToken;
    }

    requireToken() {
        if (!this.bearerToken) {
            throw new AnthbotGenieError("Bearer token not configured");
        }
    }

    static buildVerificationToken(serialNumber, timestamp = null) {
        const unixTimestamp = timestamp || Math.floor(Date.now() / 1000);
        const tokenSuffix = String(unixTimestamp);
        const tokenPrefix = crypto.createHash("md5").update(`${serialNumber}${tokenSuffix}`, "utf8").digest("hex");
        return `${tokenPrefix}${tokenSuffix}`;
    }

    async getBoundDevices() {
        this.requireToken();
        const response = await this.http.get(`https://${this.host}/api/v1/device/bind/list`, {
            headers: this.authHeaders,
        });
        const payload = response.data;
        if (response.status !== 200) {
            throw new AnthbotGenieError(`Bind list failed (${response.status}): ${String(payload).slice(0, 300)}`);
        }
        if (!payload || typeof payload !== "object") {
            throw new AnthbotGenieError("Invalid bind list payload type");
        }
        if (payload.code !== 0) {
            throw new AnthbotGenieError(`Bind list returned code=${JSON.stringify(payload.code)}`);
        }
        if (!Array.isArray(payload.data)) {
            throw new AnthbotGenieError("Bind list payload missing data array");
        }
        return payload.data
            .filter(item => item && typeof item === "object" && typeof item.sn === "string" && item.sn)
            .map(item => ({
                serialNumber: item.sn,
                alias: typeof item.alias === "string" && item.alias ? item.alias : item.sn,
                model: item.category_id != null ? String(item.category_id) : "Anthbot mower",
                isOwner: typeof item.is_owner === "boolean" ? item.is_owner : typeof item.is_owner === "number" ? item.is_owner === 1 : null,
            }));
    }

    async getDeviceRegion(serialNumber) {
        this.requireToken();
        const response = await this.http.get(`https://${this.host}/api/v1/device/v2/region`, {
            headers: this.authHeaders,
            params: { sn: serialNumber },
        });
        const payload = response.data;
        if (response.status !== 200) {
            throw new AnthbotGenieError(`Device region failed (${response.status}): ${String(payload).slice(0, 300)}`);
        }
        if (!payload || typeof payload !== "object") {
            throw new AnthbotGenieError("Invalid device region payload type");
        }
        if (payload.code !== 0) {
            throw new AnthbotGenieError(`Device region returned code=${JSON.stringify(payload.code)}`);
        }
        const data = payload.data;
        if (!data || typeof data !== "object") {
            throw new AnthbotGenieError("Device region payload missing data object");
        }
        if (typeof data.region_name !== "string" || !data.region_name) {
            throw new AnthbotGenieError("Device region missing region_name");
        }
        if (typeof data.iot_endpoint !== "string" || !data.iot_endpoint) {
            throw new AnthbotGenieError("Device region missing iot_endpoint");
        }
        return {
            serialNumber,
            regionName: data.region_name,
            iotEndpoint: data.iot_endpoint,
        };
    }

    async getDeviceAreaDefinition(serialNumber) {
        this.requireToken();
        const response = await this.http.get(`https://${this.host}/api/v1/device/v2/presigned_url`, {
            headers: this.authHeaders,
            params: {
                filename: `area_${serialNumber}.txt`,
                sn: serialNumber,
                category: "device",
                sub_category: "area",
                verification_token: AnthbotCloudApiClient.buildVerificationToken(serialNumber),
            },
        });
        const payload = response.data;
        if (response.status !== 200) {
            throw new AnthbotGenieError(`Area presigned URL failed (${response.status}): ${String(payload).slice(0, 300)}`);
        }
        if (!payload || typeof payload !== "object") {
            throw new AnthbotGenieError("Invalid area presigned URL payload type");
        }
        if (payload.code !== 0) {
            throw new AnthbotGenieError(`Area presigned URL returned code=${JSON.stringify(payload.code)}`);
        }
        const presignedUrl = payload?.data?.presigned_url;
        if (typeof presignedUrl !== "string" || !presignedUrl) {
            throw new AnthbotGenieError("Area presigned URL payload missing presigned_url");
        }
        const areaResponse = await this.http.get(presignedUrl);
        if (areaResponse.status !== 200) {
            throw new AnthbotGenieError(`Area definition download failed (${areaResponse.status}): ${String(areaResponse.data).slice(0, 300)}`);
        }
        const rawText = typeof areaResponse.data === "string" ? areaResponse.data : JSON.stringify(areaResponse.data);
        let areaDefinition;
        try {
            areaDefinition = JSON.parse(rawText);
        } catch {
            throw new AnthbotGenieError("Area definition is not valid JSON");
        }
        if (!areaDefinition || typeof areaDefinition !== "object" || Array.isArray(areaDefinition)) {
            throw new AnthbotGenieError("Area definition payload type is not an object");
        }
        return areaDefinition;
    }
}

class AnthbotShadowApiClient {
    constructor({ http, serialNumber, regionName, iotEndpoint }) {
        this.http = http;
        this.serialNumber = serialNumber;
        this.regionName = typeof regionName === "string" && regionName ? regionName : null;
        this.iotEndpoint = AnthbotShadowApiClient.normalizeEndpoint(iotEndpoint);
    }

    static normalizeEndpoint(iotEndpoint) {
        if (typeof iotEndpoint !== "string" || !iotEndpoint) {
            return DEFAULT_IOT_ENDPOINT;
        }
        return iotEndpoint.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "") || DEFAULT_IOT_ENDPOINT;
    }

    static guessRegionFromEndpoint(iotEndpoint) {
        if (!iotEndpoint || !String(iotEndpoint).includes(".iot.")) {
            return null;
        }
        const right = String(iotEndpoint).split(".iot.", 2)[1];
        const region = right.split(".", 1)[0];
        return region || null;
    }

    get signingRegion() {
        return AnthbotShadowApiClient.guessRegionFromEndpoint(this.iotEndpoint) || this.regionName || DEFAULT_IOT_REGION;
    }

    static buildDefaultIotEndpointForRegion(regionName) {
        return IOT_ENDPOINT_TEMPLATE.replace("{region}", regionName);
    }

    accessKeyId() {
        if (this.iotEndpoint === CN_NORTHWEST_IOT_ENDPOINT) {
            return AWS_ACCESS_KEY_CN_NORTHWEST;
        }
        if (this.signingRegion.startsWith("cn")) {
            return AWS_ACCESS_KEY_CN;
        }
        return AWS_ACCESS_KEY_DEFAULT;
    }

    secretAccessKey() {
        if (this.iotEndpoint === CN_NORTHWEST_IOT_ENDPOINT) {
            return AWS_SECRET_KEY_CN_NORTHWEST;
        }
        if (this.signingRegion.startsWith("cn")) {
            return AWS_SECRET_KEY_CN;
        }
        return AWS_SECRET_KEY_DEFAULT;
    }

    sign(key, msg) {
        return crypto.createHmac("sha256", key).update(msg, "utf8").digest();
    }

    signingKey(dateStamp) {
        const kDate = this.sign(Buffer.from(`AWS4${this.secretAccessKey()}`, "utf8"), dateStamp);
        const kRegion = this.sign(kDate, this.signingRegion);
        const kService = this.sign(kRegion, "iotdata");
        return this.sign(kService, "aws4_request");
    }

    buildAuthorization({ amzDate, dateStamp, canonicalRequest }) {
        const algorithm = "AWS4-HMAC-SHA256";
        const signedHeaders = this.signedHeadersFromRequest(canonicalRequest);
        const credentialScope = `${dateStamp}/${this.signingRegion}/iotdata/aws4_request`;
        const stringToSign = [
            algorithm,
            amzDate,
            credentialScope,
            crypto.createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
        ].join("\n");
        const signature = crypto
            .createHmac("sha256", this.signingKey(dateStamp))
            .update(stringToSign, "utf8")
            .digest("hex");
        return `${algorithm} Credential=${this.accessKeyId()}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    }

    static normalizeHeaderValue(value) {
        return String(value).trim().split(/\s+/).join(" ");
    }

    static canonicalHeaders(headers) {
        const lowered = {};
        for (const [key, value] of Object.entries(headers)) {
            lowered[key.toLowerCase()] = AnthbotShadowApiClient.normalizeHeaderValue(value);
        }
        const orderedKeys = Object.keys(lowered).sort();
        return {
            canonical: orderedKeys.map(key => `${key}:${lowered[key]}\n`).join(""),
            signedHeaders: orderedKeys.join(";"),
        };
    }

    signedHeadersFromRequest(canonicalRequest) {
        const parts = canonicalRequest.split("\n");
        return parts.length >= 6 ? parts[parts.length - 2] : "host;x-amz-content-sha256;x-amz-date";
    }

    static canonicalUriForSigv4(requestUri) {
        const encoded = [];
        for (const byte of Buffer.from(requestUri, "utf8")) {
            if (
                (byte >= 0x30 && byte <= 0x39) ||
                (byte >= 0x41 && byte <= 0x5a) ||
                (byte >= 0x61 && byte <= 0x7a) ||
                [45, 46, 95, 126, 47].includes(byte)
            ) {
                encoded.push(String.fromCharCode(byte));
            } else {
                encoded.push(`%${byte.toString(16).toUpperCase().padStart(2, "0")}`);
            }
        }
        return encoded.join("");
    }

    async getNamedShadowReportedState(shadowName) {
        const requestUri = `/things/${encodeURIComponent(this.serialNumber).replace(/%2F/g, "/")}/shadow`;
        const canonicalUri = AnthbotShadowApiClient.canonicalUriForSigv4(requestUri);
        const canonicalQuery = `name=${encodeURIComponent(shadowName)}`;
        const payloadHash = crypto.createHash("sha256").update("", "utf8").digest("hex");
        const now = new Date();
        const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15) + "Z";
        const dateStamp = amzDate.slice(0, 8);
        const signedHeaderValues = {
            host: this.iotEndpoint,
            "x-amz-content-sha256": payloadHash,
            "x-amz-date": amzDate,
        };
        const { canonical, signedHeaders } = AnthbotShadowApiClient.canonicalHeaders(signedHeaderValues);
        const canonicalRequest = [
            "GET",
            canonicalUri,
            canonicalQuery,
            canonical,
            signedHeaders,
            payloadHash,
        ].join("\n");
        const authorization = this.buildAuthorization({ amzDate, dateStamp, canonicalRequest });
        const response = await this.http.get(`https://${this.iotEndpoint}${requestUri}?${canonicalQuery}`, {
            headers: {
                Accept: "*/*",
                Host: this.iotEndpoint,
                "x-amz-date": amzDate,
                "x-amz-content-sha256": payloadHash,
                Authorization: authorization,
                "User-Agent": "LdMower/1581 CFNetwork/3860.400.51 Darwin/25.3.0",
            },
        });
        if (response.status !== 200) {
            throw new AnthbotGenieError(`Shadow request failed (${response.status}): ${JSON.stringify(response.data).slice(0, 300)}`);
        }
        const payload = response.data;
        if (!payload || typeof payload !== "object") {
            throw new AnthbotGenieError("Invalid response payload type");
        }
        const reported = payload?.state?.reported;
        if (!reported || typeof reported !== "object") {
            throw new AnthbotGenieError("Missing state.reported in response");
        }
        return reported;
    }

    async getShadowReportedState() {
        return this.getNamedShadowReportedState("property");
    }

    async getServiceReportedState() {
        return this.getNamedShadowReportedState("service");
    }

    async signedPost({ requestUri, canonicalQuery, payloadBytes, includeSdkHeaders, canonicalUriOverride = null, signContentLength = true }) {
        const payloadHash = crypto.createHash("sha256").update(payloadBytes).digest("hex");
        const now = new Date();
        const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15) + "Z";
        const dateStamp = amzDate.slice(0, 8);
        const signedHeaderValues = {
            host: this.iotEndpoint,
            "content-type": "application/octet-stream",
            "x-amz-content-sha256": payloadHash,
            "x-amz-date": amzDate,
        };
        const headers = {
            Accept: "*/*",
            Host: this.iotEndpoint,
            "Content-Type": "application/octet-stream",
            "x-amz-content-sha256": payloadHash,
            "x-amz-date": amzDate,
        };
        if (signContentLength) {
            signedHeaderValues["content-length"] = String(payloadBytes.length);
            headers["Content-Length"] = String(payloadBytes.length);
        }
        if (includeSdkHeaders) {
            const invocationId = crypto.randomUUID();
            signedHeaderValues["amz-sdk-invocation-id"] = invocationId;
            signedHeaderValues["amz-sdk-request"] = "attempt=1; max=3";
            signedHeaderValues["x-amz-user-agent"] = "aws-sdk-js/3.846.0";
            headers["amz-sdk-invocation-id"] = invocationId;
            headers["amz-sdk-request"] = "attempt=1; max=3";
            headers["x-amz-user-agent"] = "aws-sdk-js/3.846.0";
            headers["User-Agent"] = "aws-sdk-js/3.846.0 ua/2.1 os/other lang/js md/rn api/iot-data-plane#3.846.0 m/N,E,e";
        } else {
            headers["User-Agent"] = "LdMower/1581 CFNetwork/3860.400.51 Darwin/25.3.0";
        }
        const { canonical, signedHeaders } = AnthbotShadowApiClient.canonicalHeaders(signedHeaderValues);
        const canonicalUri = canonicalUriOverride || AnthbotShadowApiClient.canonicalUriForSigv4(requestUri);
        const canonicalRequest = [
            "POST",
            canonicalUri,
            canonicalQuery,
            canonical,
            signedHeaders,
            payloadHash,
        ].join("\n");
        headers.Authorization = this.buildAuthorization({ amzDate, dateStamp, canonicalRequest });
        const url = canonicalQuery ? `https://${this.iotEndpoint}${requestUri}?${canonicalQuery}` : `https://${this.iotEndpoint}${requestUri}`;
        const response = await this.http.post(url, payloadBytes, { headers });
        const bodyText = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
        return {
            status: response.status,
            bodyText,
            payload: response.data && typeof response.data === "object" && !Array.isArray(response.data) ? response.data : null,
            headers: {
                errortype: response.headers["x-amzn-errortype"] || "",
                requestid: response.headers["x-amzn-requestid"] || response.headers["x-amzn-request-id"] || "",
            },
        };
    }

    async publishServiceCommand({ cmd, data, ...desired }) {
        const body = {
            state: {
                desired: {
                    cmd,
                    ...(data === undefined ? {} : { data }),
                    ...desired,
                },
            },
        };
        const payloadBytes = Buffer.from(JSON.stringify(body), "utf8");
        const topic = `$aws/things/${this.serialNumber}/shadow/name/service/update`;
        const requestUriEncoded = `/topics/${encodeURIComponent(topic).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
        const requestUriRaw = `/topics/${topic}`;
        const attempts = [
            [requestUriEncoded, true, null, true],
            [requestUriEncoded, true, requestUriEncoded, true],
            [requestUriEncoded, true, null, false],
            [requestUriEncoded, false, null, true],
            [requestUriRaw, true, null, true],
            [requestUriRaw, true, requestUriRaw, true],
            [requestUriRaw, false, null, true],
        ];
        let last = null;
        for (const [requestUri, includeSdkHeaders, canonicalUriOverride, signContentLength] of attempts) {
            const result = await this.signedPost({
                requestUri,
                canonicalQuery: "",
                payloadBytes,
                includeSdkHeaders,
                canonicalUriOverride,
                signContentLength,
            });
            if (result.status === 200 && result.payload && typeof result.payload === "object") {
                return;
            }
            last = result;
            if (result.status !== 403) {
                break;
            }
        }
        throw new AnthbotGenieError(`Command '${cmd}' failed (${last?.status || 0}) at endpoint '${this.iotEndpoint}' (region '${this.signingRegion}', errortype '${last?.headers?.errortype || ""}', requestid '${last?.headers?.requestid || ""}'): ${(last?.bodyText || "").slice(0, 300)}`);
    }

    async requestAllProperties() {
        await this.publishServiceCommand({ cmd: "get_all_props", data: 1 });
    }
}

function listOfDicts(value) {
    return Array.isArray(value) ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) : [];
}

function getAreaDefinition(data) {
    return data && typeof data._area_definition === "object" && !Array.isArray(data._area_definition) ? data._area_definition : {};
}

function manualZones(data) {
    const areaDefinition = getAreaDefinition(data || {});
    for (const key of ["custom_areas", "zones", "customAreas"]) {
        const zones = listOfDicts(areaDefinition[key]);
        if (zones.length) {
            return zones;
        }
    }
    return listOfDicts(data?.custom_areas);
}

function autoZones(data) {
    const areaDefinition = getAreaDefinition(data || {});
    for (const key of ["region_areas", "regionAreas", "auto_regions", "autoRegions", "auto_zones", "autoZones", "regions"]) {
        const zones = listOfDicts(areaDefinition[key]);
        if (zones.length) {
            return zones;
        }
    }
    return listOfDicts(data?.region_areas);
}

function activeManualZoneIds(data) {
    const ids = data?.active_area?.id;
    return Array.isArray(ids) ? ids.filter(id => Number.isInteger(id)) : [];
}

function coerceEnabledValue(value) {
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "number") {
        return value === 1;
    }
    if (typeof value === "string") {
        return ["1", "true", "on", "enabled", "enable"].includes(value.trim().toLowerCase());
    }
    return false;
}

function isCustomDirectionEnabled(data) {
    const raw = data?.param_set?.enable_adaptive_head;
    return !coerceEnabledValue(raw);
}

function rawRobotStatus(data) {
    const value = data?.robot_sta?.value;
    if (typeof value === "string") {
        return value.toLowerCase();
    }
    if (Number.isInteger(value)) {
        return ROBOT_STATUS_BY_CODE[value] || String(value);
    }
    return null;
}

function generalMowerStatus(data) {
    const raw = rawRobotStatus(data);
    if (raw == null) {
        return "unknown";
    }
    if (["globalmowing", "zonemowing", "pointmowing", "bordermowing", "regionmowing", "nestmowing", "wastelandmowing"].includes(raw)) {
        return "mowing";
    }
    if (["charge", "charging", "charge_start"].includes(raw)) {
        return "charging";
    }
    if (raw === "backtodock") {
        return "returning_to_dock";
    }
    if (raw === "idle") {
        return "standby";
    }
    if (raw === "pause") {
        return "paused";
    }
    if (raw === "mapping") {
        return "mapping";
    }
    if (raw === "position") {
        return "positioning";
    }
    if (raw === "resume_point") {
        return "resuming";
    }
    if (raw === "sleep") {
        return "sleeping";
    }
    if (raw === "ota") {
        return "ota_updating";
    }
    if (raw === "remotectrl") {
        return "remote_control";
    }
    if (raw === "factory") {
        return "factory_mode";
    }
    if (raw === "camera_cleaning") {
        return "camera_cleaning";
    }
    if (raw === "gototarget") {
        return "going_to_target";
    }
    if (raw === "shutdown") {
        return "shutdown";
    }
    return "unknown";
}

function isCharging(data) {
    return generalMowerStatus(data) === "charging";
}

function compactZonePayload(zones) {
    return zones.map(zone => {
        const item = {};
        for (const key of ["id", "name", "mow_count", "mow_mode", "mow_order", "cutter_height", "enable_adaptive_head", "mow_head", "visual_ignore_obstacle_switch", "obstacle_avoid_level", "x", "y", "vertexs", "points"]) {
            if (zone[key] !== undefined && zone[key] !== null) {
                item[key] = zone[key];
            }
        }
        return item;
    });
}

function parseCommandSelection(value) {
    if (Array.isArray(value)) {
        return value;
    }
    if (typeof value === "number") {
        return [value];
    }
    if (typeof value !== "string") {
        return [];
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return [];
    }
    if (trimmed.startsWith("[")) {
        try {
            const parsed = JSON.parse(trimmed);
            return Array.isArray(parsed) ? parsed : [parsed];
        } catch {
            return [trimmed];
        }
    }
    return trimmed.split(",").map(part => part.trim()).filter(Boolean);
}

module.exports = {
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
};
