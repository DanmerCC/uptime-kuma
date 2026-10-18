/**
 * Helpers for storing and returning the most recent peer IP observed by HTTP checks.
 * Keep this fork-specific behavior outside the inherited monitor implementation.
 */

/**
 * Get the connected peer address from an Axios response or error.
 * @param {object} responseOrError Axios response or error
 * @returns {string|null} Connected peer IP, if available
 */
function getRemoteAddress(responseOrError) {
    const request = responseOrError?.request || responseOrError?.response?.request;
    const socket = request?.res?.socket || request?.socket;
    return typeof socket?.remoteAddress === "string" ? socket.remoteAddress : null;
}

/**
 * Store an observed peer IP on the heartbeat, omitting it for proxied requests
 * because the socket address would identify the proxy rather than the target.
 * @param {object} heartbeat Heartbeat bean
 * @param {object} responseOrError Axios response or error
 * @param {boolean} isUsingProxy Whether the request used an active proxy
 * @returns {void}
 */
function captureResolvedIp(heartbeat, responseOrError, isUsingProxy = false) {
    if (isUsingProxy) {
        return;
    }

    const address = getRemoteAddress(responseOrError);
    if (address) {
        heartbeat.resolved_ip = address;
    }
}

/**
 * Get each monitor's latest non-null resolved IP for list serialization.
 * @param {object} R RedBean instance
 * @param {Array<number>} monitorIDs Monitor IDs to query
 * @returns {Promise<Map<number, string>>} Latest IP by monitor ID
 */
async function getLastResolvedIpMap(R, monitorIDs) {
    if (monitorIDs.length === 0) {
        return new Map();
    }

    const placeholders = monitorIDs.map(() => "?").join(",");
    const rows = await R.getAll(
        `
        SELECT monitor_id, resolved_ip
        FROM heartbeat
        WHERE id IN (
            SELECT MAX(id)
            FROM heartbeat
            WHERE monitor_id IN (${placeholders}) AND resolved_ip IS NOT NULL
            GROUP BY monitor_id
        )
        `,
        monitorIDs
    );

    return new Map(rows.map((row) => [row.monitor_id, row.resolved_ip]));
}

module.exports = {
    captureResolvedIp,
    getLastResolvedIpMap,
    getRemoteAddress,
};
