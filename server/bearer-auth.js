const passwordHash = require("./password-hash");
const { R } = require("redbean-node");
const { log } = require("../src/util");
const { apiRateLimiter } = require("./rate-limiter");
const dayjs = require("dayjs");

/**
 * Authenticate a scoped API token from the Authorization header.
 * @param {string} requiredScope Scope required by the endpoint
 * @returns {Function} Express middleware
 */
exports.bearerAuth = function (requiredScope) {
    return async (req, res, next) => {
        try {
            const pass = await apiRateLimiter.pass(null, 0);
            if (!pass) {
                return res.status(429).set("WWW-Authenticate", "Bearer").json({ error: "rate_limited" });
            }
            apiRateLimiter.removeTokens(1);

            const authorization = req.get("authorization") || "";
            const match = /^Bearer\s+(uk([1-9]\d*)_([A-Za-z0-9_-]{20,128}))$/i.exec(authorization);
            if (!match) {
                return res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized" });
            }

            const [, , keyID, clearToken] = match;
            const key = await R.findOne("api_key", " id = ? ", [keyID]);
            const expires = key && key.expires ? dayjs(key.expires) : null;
            if (!key || !key.active || !key.user_id || (expires && (!expires.isValid() || !expires.isAfter(dayjs())))) {
                return res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized" });
            }

            let validToken = false;
            try {
                validToken = passwordHash.verify(clearToken, key.key);
            } catch (e) {
                // Treat malformed hashes the same as an invalid token.
            }
            if (!validToken) {
                return res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized" });
            }

            const owner = await R.findOne("user", " id = ? AND active = 1 ", [key.user_id]);
            if (!owner) {
                return res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized" });
            }

            let scopes;
            try {
                scopes = JSON.parse(key.scopes_json);
            } catch (e) {
                scopes = [];
            }
            if (!Array.isArray(scopes) || !scopes.includes(requiredScope)) {
                return res.status(403).json({ error: "insufficient_scope" });
            }

            req.apiUserID = key.user_id;
            req.apiKeyID = key.id;
            req.apiKeyScopes = scopes;
            return next();
        } catch (e) {
            log.error("api-auth", "Bearer authentication failed unexpectedly");
            return res.status(503).json({ error: "authentication_unavailable" });
        }
    };
};