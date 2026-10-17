const SENSITIVE_QUERY_PARAM =
    /(?:pass(?:word|wd)?|pwd|token|secret|(?:^|[_-])key(?:$|[_-])|api[_-]?key|authorization|auth|signature|^sig$|access[_-]?key|client[_-]?secret|credential|session|jwt|bearer)/i;
const ALLOWED_MONITOR_PROPERTIES = new Set([
    "name",
    "url",
    "interval",
    "description",
    "acceptedStatusCodes",
    "active",
    "ignoreTls",
    "tags",
]);
const ALLOWED_MONITOR_UPDATE_PROPERTIES = new Set(["url", "tags"]);
const TAG_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;
const MAX_MONITOR_TAGS = 10;

/**
 * Validate and normalize the deliberately narrow HTTP monitor API payload.
 * @param {object} payload Untrusted request body
 * @returns {object} Validated monitor values
 * @throws {Error} If the payload is invalid
 */
function validateMonitorPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("Request body must be an object");
    }

    for (const property of Object.keys(payload)) {
        if (!ALLOWED_MONITOR_PROPERTIES.has(property)) {
            throw new Error("Unsupported property: " + property);
        }
    }

    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    if (!name || name.length > 150) {
        throw new Error("Name must contain 1 to 150 characters");
    }

    const url = parseMonitorURL(payload.url);
    const interval = payload.interval === undefined ? 60 : payload.interval;
    if (!Number.isInteger(interval) || interval < 30 || interval > 86400) {
        throw new Error("Interval must be an integer from 30 to 86400 seconds");
    }

    const description = payload.description === undefined ? "" : payload.description;
    if (typeof description !== "string" || description.length > 1000) {
        throw new Error("Description must be a string of at most 1000 characters");
    }

    const acceptedStatusCodes = payload.acceptedStatusCodes === undefined ? ["200-299"] : payload.acceptedStatusCodes;
    if (
        !Array.isArray(acceptedStatusCodes) ||
        acceptedStatusCodes.length < 1 ||
        acceptedStatusCodes.length > 10 ||
        acceptedStatusCodes.some((code) => typeof code !== "string" || !isValidStatusCodeRange(code))
    ) {
        throw new Error("acceptedStatusCodes must contain 1 to 10 valid HTTP status codes or ranges");
    }

    if (payload.active !== undefined && typeof payload.active !== "boolean") {
        throw new Error("Active must be a boolean");
    }
    if (payload.ignoreTls !== undefined && typeof payload.ignoreTls !== "boolean") {
        throw new Error("ignoreTls must be a boolean");
    }
    const tags = payload.tags === undefined ? [] : validateTagNames(payload.tags);

    return {
        name,
        url,
        interval,
        description,
        acceptedStatusCodes,
        active: payload.active === undefined ? true : payload.active,
        ignoreTls: payload.ignoreTls === undefined ? false : payload.ignoreTls,
        tags,
    };
}

/**
 * Validate the deliberately narrow monitor update API payload.
 * @param {object} payload Untrusted request body
 * @returns {object} Validated monitor updates
 * @throws {Error} If the payload is invalid
 */
function validateMonitorUpdatePayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("Request body must be an object");
    }

    const properties = Object.keys(payload);
    if (properties.length === 0) {
        throw new Error("Request body must contain at least one supported property");
    }

    for (const property of properties) {
        if (!ALLOWED_MONITOR_UPDATE_PROPERTIES.has(property)) {
            throw new Error("Unsupported property: " + property);
        }
    }

    const updates = {};
    if (Object.hasOwn(payload, "url")) {
        updates.url = parseMonitorURL(payload.url);
    }
    if (Object.hasOwn(payload, "tags")) {
        updates.tags = validateTagNames(payload.tags);
    }
    return updates;
}

/**
 * Validate the complete set of tag names for a monitor.
 * @param {unknown} value Tag name array
 * @returns {string[]} Normalized tag names
 * @throws {Error} If the tag set is invalid
 */
function validateTagNames(value) {
    if (!Array.isArray(value) || value.length > MAX_MONITOR_TAGS) {
        throw new Error("tags must be an array containing at most 10 tag names");
    }

    const seen = new Set();
    return value.map((item) => {
        const name = typeof item === "string" ? item.trim() : "";
        if (!name || name.length > 64 || !TAG_NAME_PATTERN.test(name)) {
            throw new Error("Each tag name must contain 1 to 64 letters, numbers, spaces, dots, underscores, or hyphens");
        }

        const key = normalizeTagName(name);
        if (seen.has(key)) {
            throw new Error("Duplicate tag names are not allowed");
        }
        seen.add(key);
        return name;
    });
}

/**
 * Normalize a tag name for case/accent-insensitive matching.
 * @param {string} name Tag name
 * @returns {string} Normalized tag name
 */
function normalizeTagName(name) {
    return name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/**
 * Check a single code or inclusive range.
 * @param {string} code HTTP status code or range
 * @returns {boolean} Whether the value is valid
 */
function isValidStatusCodeRange(code) {
    const match = /^([1-5]\d{2})(?:-([1-5]\d{2}))?$/.exec(code);
    if (!match) {
        return false;
    }
    return !match[2] || Number(match[1]) <= Number(match[2]);
}

/**
 * Parse and validate an HTTP(S) monitor target.
 * @param {string} value Untrusted URL
 * @returns {string} Canonical URL
 * @throws {Error} If the URL is invalid or contains credentials
 */
function parseMonitorURL(value) {
    if (typeof value !== "string" || value.length > 2048) {
        throw new Error("URL must be an HTTP or HTTPS URL no longer than 2048 characters");
    }

    let url;
    try {
        url = new URL(value);
    } catch (e) {
        throw new Error("URL must be a valid HTTP or HTTPS URL");
    }

    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
        throw new Error("URL must use HTTP or HTTPS and must not contain credentials or a fragment");
    }

    for (const key of url.searchParams.keys()) {
        if (SENSITIVE_QUERY_PARAM.test(key)) {
            throw new Error("URL must not contain credentials or secret query parameters");
        }
    }

    return url.toString();
}

/**
 * Remove URL credentials and secret query parameters before returning stored data.
 * @param {string} value Monitor URL
 * @returns {string|null} Sanitized URL, or null for invalid values
 */
function redactMonitorURL(value) {
    try {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        for (const key of [...url.searchParams.keys()]) {
            if (SENSITIVE_QUERY_PARAM.test(key)) {
                url.searchParams.delete(key);
            }
        }
        url.hash = "";
        return url.toString();
    } catch (e) {
        return null;
    }
}

/**
 * Build a safe public representation of a monitor row.
 * @param {object} monitor Monitor bean or row
 * @param {object[]} tags Monitor tags
 * @returns {object} Allowlisted monitor fields
 */
function toPublicMonitor(monitor, tags = []) {
    return {
        id: Number(monitor.id),
        name: monitor.name,
        description: monitor.description || "",
        type: "http",
        url: redactMonitorURL(monitor.url),
        interval: Number(monitor.interval),
        active: Boolean(monitor.active),
        tags: tags.map((tag) => ({
            name: tag.name,
            value: tag.value || "",
            color: /^#[\da-f]{6}$/i.test(tag.color || "") ? tag.color : null,
        })),
    };
}

module.exports = {
    validateMonitorPayload,
    validateMonitorUpdatePayload,
    validateTagNames,
    normalizeTagName,
    redactMonitorURL,
    toPublicMonitor,
};
