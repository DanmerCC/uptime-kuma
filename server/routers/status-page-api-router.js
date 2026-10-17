const express = require("express");
const apicache = require("../modules/apicache");
const { log } = require("../../src/util");
const { normalizeGroupName, validateStatusPageGroupsPayload } = require("./status-page-api-utils");

/**
 * Create the fork's scoped status-page management router.
 * @param {object} dependencies Router dependencies
 * @param {object} dependencies.R RedBean instance
 * @param {Function} dependencies.bearerAuth Scoped Bearer middleware factory
 * @returns {express.Router} Status-page API router
 */
function createStatusPageApiRouter({ R, bearerAuth }) {
    const router = express.Router();

    router.patch("/:slug/groups", bearerAuth("status-pages:write"), async (request, response) => {
        const slug = typeof request.params.slug === "string" ? request.params.slug.toLowerCase() : "";
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
            response.status(400).json({ error: "invalid_request", message: "Status page slug is invalid" });
            return;
        }

        let assignment;
        try {
            assignment = validateStatusPageGroupsPayload(request.body);
        } catch (e) {
            response.status(400).json({ error: "invalid_request", message: e.message });
            return;
        }

        try {
            const statusPage = await R.findOne("status_page", " slug = ? ", [slug]);
            if (!statusPage) {
                response.status(404).json({ error: "not_found" });
                return;
            }

            const ownedMonitorIDs = await R.getCol(
                `SELECT id FROM monitor WHERE user_id = ? AND id IN (${assignment.monitorIDs.map(() => "?").join(",")})`,
                [request.apiUserID, ...assignment.monitorIDs]
            );
            if (ownedMonitorIDs.length !== assignment.monitorIDs.length) {
                // Do not reveal whether a missing ID exists or belongs to another user.
                response.status(404).json({ error: "monitor_not_found" });
                return;
            }

            const existingGroups = await R.find(
                "group",
                " status_page_id = ? AND public = 1 ORDER BY weight ",
                [statusPage.id]
            );
            const existingGroupsByName = new Map();
            for (const group of existingGroups) {
                const key = normalizeGroupName(group.name);
                if (existingGroupsByName.has(key)) {
                    response.status(409).json({ error: "ambiguous_group_name" });
                    return;
                }
                existingGroupsByName.set(key, group);
            }

            const maxPageWeight = existingGroups.reduce((max, group) => Math.max(max, Number(group.weight) || 0), 0);
            let nextGroupWeight = maxPageWeight + 1;
            const targetGroups = assignment.groups.map((item) => {
                const existing = existingGroupsByName.get(item.normalizedName);
                return {
                    ...item,
                    bean: existing || R.dispense("group"),
                    isNew: !existing,
                };
            });

            const existingTargetIDs = targetGroups.filter((item) => !item.isNew).map((item) => item.bean.id);
            const currentWeights = new Map();
            if (existingTargetIDs.length > 0) {
                const rows = await R.getAll(
                    `SELECT group_id, MAX(weight) AS max_weight
                    FROM monitor_group
                    WHERE group_id IN (${existingTargetIDs.map(() => "?").join(",")})
                    AND monitor_id NOT IN (${assignment.monitorIDs.map(() => "?").join(",")})
                    GROUP BY group_id`,
                    [...existingTargetIDs, ...assignment.monitorIDs]
                );
                for (const row of rows) {
                    currentWeights.set(Number(row.group_id), Number(row.max_weight) || 0);
                }
            }

            const transaction = await R.begin();
            try {
                for (const target of targetGroups) {
                    if (target.isNew) {
                        target.bean.status_page_id = statusPage.id;
                        target.bean.name = target.name;
                        target.bean.public = true;
                        target.bean.weight = nextGroupWeight++;
                    }
                    await transaction.store(target.bean);
                }

                await transaction.exec(
                    `DELETE FROM monitor_group
                    WHERE monitor_id IN (${assignment.monitorIDs.map(() => "?").join(",")})
                    AND group_id IN (
                        SELECT id FROM \`group\` WHERE status_page_id = ? AND public = 1
                    )`,
                    [...assignment.monitorIDs, statusPage.id]
                );

                for (const target of targetGroups) {
                    let weight = currentWeights.get(Number(target.bean.id)) || 0;
                    for (const monitorID of target.monitorIDs) {
                        const relation = transaction.dispense("monitor_group");
                        relation.group_id = target.bean.id;
                        relation.monitor_id = monitorID;
                        relation.weight = ++weight;
                        relation.send_url = false;
                        await transaction.store(relation);
                    }
                }

                statusPage.modified_date = R.isoDateTime();
                await transaction.store(statusPage);
                await transaction.commit();
            } catch (e) {
                await transaction.rollback();
                throw e;
            }

            apicache.clear();
            response.json({
                ok: true,
                slug,
                groups: targetGroups.map((group) => ({
                    id: Number(group.bean.id),
                    name: group.bean.name,
                    monitorIDs: group.monitorIDs,
                })),
            });
        } catch (e) {
            log.error("status-page-api", "Failed to update public status-page monitor groups");
            response.status(500).json({ error: "internal_error" });
        }
    });

    return router;
}

module.exports = {
    createStatusPageApiRouter,
};
