const express = require("express");
const { log } = require("../../src/util");
const {
    validateMonitorPayload,
    validateMonitorUpdatePayload,
    normalizeTagName,
    toPublicMonitor,
} = require("./monitor-api-utils");

const DEFAULT_TAG_COLOR = "#6c757d";

/**
 * Return the fork's default color for a newly created tag.
 * @param {string} name Tag name
 * @returns {string} Hex color
 */
function getDefaultTagColor(name) {
    switch (normalizeTagName(name)) {
        case "caen":
            return "#005ea8";
        case "produccion":
            return "#198754";
        default:
            return DEFAULT_TAG_COLOR;
    }
}

/**
 * Replace all tags associated with a monitor using an existing transaction.
 * Tags are global in Uptime Kuma, while associations are per monitor.
 * @param {object} transaction RedBean transaction
 * @param {number} monitorID Monitor ID
 * @param {string[]} names Validated tag names
 * @returns {Promise<void>}
 */
async function replaceMonitorTags(transaction, monitorID, names) {
    const existingTags = await transaction.find("tag");
    const tagsToAssign = [];

    for (const name of names) {
        let tag = existingTags.find((item) => normalizeTagName(item.name) === normalizeTagName(name));
        if (!tag) {
            tag = transaction.dispense("tag");
            tag.name = name;
            tag.color = getDefaultTagColor(name);
            await transaction.store(tag);
            existingTags.push(tag);
        }
        tagsToAssign.push(tag);
    }

    await transaction.exec("DELETE FROM monitor_tag WHERE monitor_id = ?", [monitorID]);
    for (const tag of tagsToAssign) {
        await transaction.exec("INSERT INTO monitor_tag (tag_id, monitor_id, value) VALUES (?, ?, ?)", [
            tag.id,
            monitorID,
            "",
        ]);
    }
}

/**
 * Restore exact tag links after a monitor restart failure.
 * @param {object} transaction RedBean transaction
 * @param {number} monitorID Monitor ID
 * @param {object[]} tagRows Previous monitor_tag rows
 * @returns {Promise<void>}
 */
async function restoreMonitorTags(transaction, monitorID, tagRows) {
    await transaction.exec("DELETE FROM monitor_tag WHERE monitor_id = ?", [monitorID]);
    for (const tag of tagRows) {
        await transaction.exec("INSERT INTO monitor_tag (tag_id, monitor_id, value) VALUES (?, ?, ?)", [
            tag.tag_id,
            monitorID,
            tag.value || "",
        ]);
    }
}

/**
 * Create the scoped monitor management API router.
 * @param {object} dependencies Router dependencies
 * @param {object} dependencies.R RedBean instance
 * @param {object} dependencies.server Uptime Kuma server instance
 * @param {Function} dependencies.bearerAuth Scoped Bearer middleware factory
 * @returns {express.Router} Monitor API router
 */
function createMonitorApiRouter({ R, server, bearerAuth }) {
    const router = express.Router();

    router.get("/", bearerAuth("monitors:read"), async (request, response) => {
        try {
            const monitors = await R.find("monitor", " user_id = ? ORDER BY id ", [request.apiUserID]);
            const publicMonitors = await Promise.all(
                monitors.map(async (monitor) => toPublicMonitor(monitor, await monitor.getTags()))
            );
            response.json({ monitors: publicMonitors });
        } catch (e) {
            log.error("monitor-api", "Failed to list monitors");
            response.status(500).json({ error: "internal_error" });
        }
    });

    router.post("/", bearerAuth("monitors:write"), async (request, response) => {
        let values;
        try {
            values = validateMonitorPayload(request.body);
        } catch (e) {
            response.status(400).json({ error: "invalid_request", message: e.message });
            return;
        }

        let monitor;
        try {
            monitor = R.dispense("monitor");
            monitor.name = values.name;
            monitor.description = values.description;
            monitor.type = "http";
            monitor.url = values.url;
            monitor.interval = values.interval;
            monitor.retryInterval = values.interval;
            monitor.accepted_statuscodes_json = JSON.stringify(values.acceptedStatusCodes);
            monitor.ignoreTls = values.ignoreTls;
            monitor.method = "GET";
            monitor.active = values.active;
            monitor.user_id = request.apiUserID;

            monitor.validate();
            const transaction = await R.begin();
            try {
                await transaction.store(monitor);
                if (values.tags.length > 0) {
                    await replaceMonitorTags(transaction, monitor.id, values.tags);
                }
                await transaction.commit();
            } catch (e) {
                await transaction.rollback();
                throw e;
            }
        } catch (e) {
            log.error("monitor-api", "Failed to create monitor");
            response.status(500).json({ error: "internal_error" });
            return;
        }

        let started = false;
        if (monitor.active) {
            try {
                server.monitorList = server.monitorList || {};
                server.monitorList[monitor.id] = monitor;
                await monitor.start(server.io);
                started = true;
            } catch (e) {
                delete server.monitorList[monitor.id];
                try {
                    await monitor.stop();
                    await R.exec("UPDATE monitor SET active = 0 WHERE id = ? AND user_id = ?", [
                        monitor.id,
                        request.apiUserID,
                    ]);
                    monitor.active = false;
                } catch (stopError) {
                    log.error("monitor-api", "Failed to clean up an unstarted monitor");
                }
                log.error("monitor-api", "Monitor was saved but could not be started");
            }
        }

        try {
            await server.sendUpdateMonitorIntoList({ userID: request.apiUserID }, monitor.id);
        } catch (e) {
            log.error("monitor-api", "Saved monitor list update failed");
        }

        response.status(201).json({ monitor: toPublicMonitor(monitor, await monitor.getTags()), started });
    });

    router.patch("/:id", bearerAuth("monitors:write"), async (request, response) => {
        const monitorID = Number(request.params.id);
        if (!Number.isSafeInteger(monitorID) || monitorID < 1) {
            response.status(400).json({ error: "invalid_request", message: "Monitor ID must be a positive integer" });
            return;
        }

        let updates;
        try {
            updates = validateMonitorUpdatePayload(request.body);
        } catch (e) {
            response.status(400).json({ error: "invalid_request", message: e.message });
            return;
        }

        let monitor;
        try {
            monitor = await R.findOne("monitor", " id = ? AND user_id = ? ", [monitorID, request.apiUserID]);
        } catch (e) {
            log.error("monitor-api", "Failed to find monitor for update");
            response.status(500).json({ error: "internal_error" });
            return;
        }

        if (!monitor) {
            response.status(404).json({ error: "not_found" });
            return;
        }
        if (monitor.type !== "http") {
            response.status(400).json({ error: "unsupported_monitor_type" });
            return;
        }

        const previousURL = monitor.url;
        const urlChanged = updates.url !== undefined && updates.url !== previousURL;
        let previousTagRows = null;
        if (updates.tags !== undefined) {
            try {
                previousTagRows = await monitor.getTags();
            } catch (e) {
                log.error("monitor-api", "Failed to load current monitor tags");
                response.status(500).json({ error: "internal_error" });
                return;
            }
        }
        const runningMonitor = server.monitorList?.[monitorID];
        let oldRunnerStopped = false;
        let updateCommitted = false;
        try {
            if (urlChanged && runningMonitor) {
                await runningMonitor.stop();
                oldRunnerStopped = true;
            }

            const transaction = await R.begin();
            try {
                if (urlChanged) {
                    monitor.url = updates.url;
                    await transaction.store(monitor);
                }
                if (updates.tags !== undefined) {
                    await replaceMonitorTags(transaction, monitorID, updates.tags);
                }
                await transaction.commit();
                updateCommitted = true;
            } catch (e) {
                await transaction.rollback();
                monitor.url = previousURL;
                throw e;
            }

            if (urlChanged) {
                server.monitorList = server.monitorList || {};
                if (monitor.active) {
                    server.monitorList[monitorID] = monitor;
                    await monitor.start(server.io);
                } else {
                    delete server.monitorList[monitorID];
                }
            }
        } catch (e) {
            if (server.monitorList?.[monitorID] === monitor) {
                try {
                    await monitor.stop();
                } catch (stopError) {
                    log.error("monitor-api", "Failed to stop monitor after update error");
                }
            }

            try {
                if (updateCommitted) {
                    const rollbackTransaction = await R.begin();
                    try {
                        if (urlChanged) {
                            monitor.url = previousURL;
                            await rollbackTransaction.store(monitor);
                        }
                        if (previousTagRows !== null) {
                            await restoreMonitorTags(rollbackTransaction, monitorID, previousTagRows);
                        }
                        await rollbackTransaction.commit();
                    } catch (rollbackError) {
                        await rollbackTransaction.rollback();
                        throw rollbackError;
                    }
                } else {
                    monitor.url = previousURL;
                }

                if (runningMonitor) {
                    server.monitorList[monitorID] = runningMonitor;
                    if (oldRunnerStopped) {
                        await runningMonitor.start(server.io);
                    }
                } else {
                    delete server.monitorList[monitorID];
                }
            } catch (rollbackError) {
                log.error("monitor-api", "Failed to restore monitor after update error");
            }
            log.error("monitor-api", "Failed to update monitor");
            response.status(500).json({ error: "internal_error" });
            return;
        }

        try {
            await server.sendUpdateMonitorIntoList({ userID: request.apiUserID }, monitorID);
        } catch (e) {
            log.error("monitor-api", "Updated monitor list notification failed");
        }

        response.json({ monitor: toPublicMonitor(monitor, await monitor.getTags()) });
    });

    return router;
}

module.exports = {
    createMonitorApiRouter,
};
