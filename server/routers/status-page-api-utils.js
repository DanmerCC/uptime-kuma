const ALLOWED_PROPERTIES = new Set(["groups"]);
const GROUP_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;
const MAX_GROUPS = 10;
const MAX_MONITORS = 100;

/**
 * Normalize a group name for case/accent-insensitive matching.
 * @param {string} name Group name
 * @returns {string} Normalized name
 */
function normalizeGroupName(name) {
    return name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Validate monitor assignments for the scoped status-page API.
 * @param {object} payload Untrusted request body
 * @returns {{groups: Array<{name: string, monitorIDs: number[]}>}} Validated assignments
 * @throws {Error} If the request is malformed
 */
function validateStatusPageGroupsPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("Request body must be an object");
    }

    for (const property of Object.keys(payload)) {
        if (!ALLOWED_PROPERTIES.has(property)) {
            throw new Error("Unsupported property: " + property);
        }
    }

    if (!Array.isArray(payload.groups) || payload.groups.length < 1 || payload.groups.length > MAX_GROUPS) {
        throw new Error("groups must contain 1 to 10 named groups");
    }

    const seenGroups = new Set();
    const seenMonitorIDs = new Set();
    let totalMonitors = 0;
    const groups = payload.groups.map((group) => {
        if (!group || typeof group !== "object" || Array.isArray(group)) {
            throw new Error("Each group must be an object");
        }
        const keys = Object.keys(group);
        if (keys.some((key) => !["name", "monitorIDs"].includes(key))) {
            throw new Error("Each group supports only name and monitorIDs");
        }

        const name = typeof group.name === "string" ? group.name.trim() : "";
        if (!name || name.length > 100 || !GROUP_NAME_PATTERN.test(name)) {
            throw new Error("Group name must contain 1 to 100 letters, numbers, spaces, dots, underscores, or hyphens");
        }
        const normalizedName = normalizeGroupName(name);
        if (seenGroups.has(normalizedName)) {
            throw new Error("Duplicate group names are not allowed");
        }
        seenGroups.add(normalizedName);

        if (!Array.isArray(group.monitorIDs) || group.monitorIDs.length < 1) {
            throw new Error("Each group must contain at least one monitor ID");
        }
        const monitorIDs = group.monitorIDs.map((id) => {
            if (!Number.isSafeInteger(id) || id < 1) {
                throw new Error("Monitor IDs must be positive integers");
            }
            if (seenMonitorIDs.has(id)) {
                throw new Error("A monitor can be assigned only once per request");
            }
            seenMonitorIDs.add(id);
            totalMonitors++;
            return id;
        });

        return { name, normalizedName, monitorIDs };
    });

    if (totalMonitors > MAX_MONITORS) {
        throw new Error("A request can assign at most 100 monitors");
    }

    return { groups, monitorIDs: [...seenMonitorIDs] };
}

module.exports = {
    normalizeGroupName,
    validateStatusPageGroupsPayload,
};
