process.env.UPTIME_KUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const TestDB = require("../mock-testdb");
const { R } = require("redbean-node");
const { Settings } = require("../../server/settings");
const APIKey = require("../../server/model/api_key");
const passwordHash = require("../../server/password-hash");
const { bearerAuth } = require("../../server/bearer-auth");
const { createMonitorApiRouter } = require("../../server/routers/monitor-api-router");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kuma-monitor-api-"));
const testDb = new TestDB(dataDir);
let httpServer;
let baseURL;
let userA;
let userB;
let otherMonitorID;
let readToken;
let writeToken;
let legacyToken;
let expiredToken;
let revokedToken;
let fakeServer;
let startCount = 0;

/**
 * Insert an active test user.
 * @param {string} username Username
 * @param {boolean} active Whether the user is active
 * @returns {Promise<object>} User bean
 */
async function createUser(username, active = true) {
    const user = R.dispense("user");
    user.username = username;
    user.password = "test-hash";
    user.active = active;
    await R.store(user);
    return user;
}

/**
 * Create a test API key and return its one-time clear token.
 * @param {number} userID Owning user ID
 * @param {string[]} scopes Assigned scopes
 * @param {object} options Active/expiry overrides
 * @param {boolean} options.active Whether the token is active
 * @param {string|null} options.expires Expiration timestamp
 * @returns {Promise<string>} Bearer token
 */
async function createToken(userID, scopes, { active = true, expires = null } = {}) {
    const clearToken = "test_" + crypto.randomBytes(32).toString("base64url");
    const key = await APIKey.save(
        {
            key: await passwordHash.generate(clearToken),
            name: "test token",
            active,
            expires,
        },
        userID,
        scopes
    );
    return "uk" + key.id + "_" + clearToken;
}

/**
 * Send a request to the ephemeral test server.
 * @param {string} method HTTP method
 * @param {string|null} token Bearer token
 * @param {object|undefined} body Optional JSON body
 * @param {string} suffix Optional route suffix
 * @returns {Promise<object>} Response and decoded body
 */
async function request(method, token, body, suffix = "") {
    const response = await fetch(baseURL + "/api/v1/monitors" + suffix, {
        method,
        headers: {
            ...(token ? { Authorization: "Bearer " + token } : {}),
            ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { response, body: await response.json() };
}

before(async () => {
    await testDb.create();
    userA = await createUser("monitor-api-a");
    userB = await createUser("monitor-api-b");
    readToken = await createToken(userA.id, ["monitors:read"]);
    writeToken = await createToken(userA.id, ["monitors:write"]);
    legacyToken = await createToken(userA.id, []);
    expiredToken = await createToken(userA.id, ["monitors:read"], {
        expires: new Date(Date.now() - 60_000).toISOString(),
    });
    revokedToken = await createToken(userA.id, ["monitors:read"], { active: false });

    const otherMonitor = R.dispense("monitor");
    otherMonitor.name = "Other user monitor";
    otherMonitor.type = "http";
    otherMonitor.url = "https://example.org/other";
    otherMonitor.interval = 60;
    otherMonitor.retryInterval = 60;
    otherMonitor.accepted_statuscodes_json = JSON.stringify(["200-299"]);
    otherMonitor.user_id = userB.id;
    otherMonitor.active = false;
    await R.store(otherMonitor);
    otherMonitorID = otherMonitor.id;

    const app = express();
    app.use(express.json());
    app.use(
        "/api/v1/monitors",
        createMonitorApiRouter({
            R,
            server: fakeServer = {
                monitorList: {},
                io: null,
                sendUpdateMonitorIntoList: async () => {},
            },
            bearerAuth,
        })
    );
    httpServer = app.listen(0, "127.0.0.1");
    await new Promise((resolve, reject) => {
        httpServer.once("listening", resolve);
        httpServer.once("error", reject);
    });
    baseURL = "http://127.0.0.1:" + httpServer.address().port;
});

after(async () => {
    if (httpServer) {
        await new Promise((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
    }
    Settings.stopCacheCleaner();
    await testDb.destroy();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test("monitor API requires a valid Bearer token and the matching scope", async () => {
    assert.equal((await request("GET", null)).response.status, 401);
    assert.equal((await request("GET", "not-a-token")).response.status, 401);
    assert.equal((await request("GET", expiredToken)).response.status, 401);
    assert.equal((await request("GET", revokedToken)).response.status, 401);
    assert.equal((await request("GET", legacyToken)).response.status, 403);
    assert.equal((await request("GET", writeToken)).response.status, 403);
    assert.equal((await request("POST", readToken, { name: "Denied", url: "https://example.org" })).response.status, 403);
    assert.equal((await request("PATCH", readToken, { url: "https://example.org" }, "/1")).response.status, 403);
});

test("monitor API creates only allowlisted HTTP monitors and restricts listing to the token owner", async () => {
    const createResult = await request("POST", writeToken, {
        name: "Asset health",
        url: "https://example.org/health?region=west",
        active: false,
        interval: 60,
        description: "WSP01 asset",
        tags: ["CAEN", "Producción"],
    });
    assert.equal(createResult.response.status, 201);
    assert.equal(createResult.body.monitor.name, "Asset health");
    assert.equal(createResult.body.monitor.active, false);
    assert.equal(createResult.body.started, false);
    assert.equal(Object.hasOwn(createResult.body.monitor, "user_id"), false);
    assert.equal(Object.hasOwn(createResult.body.monitor, "accepted_statuscodes_json"), false);
    assert.deepEqual(createResult.body.monitor.tags.map((tag) => tag.name), ["CAEN", "Producción"]);

    const listResult = await request("GET", readToken);
    assert.equal(listResult.response.status, 200);
    assert.deepEqual(listResult.body.monitors.map((monitor) => monitor.name), ["Asset health"]);
    assert.deepEqual(listResult.body.monitors[0].tags.map((tag) => tag.name), ["CAEN", "Producción"]);

    const invalid = await request("POST", writeToken, {
        name: "Must not persist",
        url: "https://example.org/",
        user_id: userB.id,
        active: false,
    });
    assert.equal(invalid.response.status, 400);
    assert.equal((await request("GET", readToken)).body.monitors.length, 1);
    const invalidTags = await request("POST", writeToken, {
        name: "Invalid tag monitor",
        url: "https://example.org/",
        active: false,
        tags: ["bad/<tag>"],
    });
    assert.equal(invalidTags.response.status, 400);
    assert.equal((await request("GET", readToken)).body.monitors.length, 1);
});
test("monitor API starts newly created active monitors", async () => {
    const Monitor = require("../../server/model/monitor");
    const originalStart = Monitor.prototype.start;
    Monitor.prototype.start = async function () {
        startCount++;
    };

    try {
        const result = await request("POST", writeToken, {
            name: "Active asset",
            url: "https://example.org/active",
        });
        assert.equal(result.response.status, 201);
        assert.equal(result.body.started, true);
        assert.equal(result.body.monitor.active, true);
        assert.equal(startCount, 1);
        assert.ok(fakeServer.monitorList[result.body.monitor.id]);
    } finally {
        Monitor.prototype.start = originalStart;
    }
});

test("monitor API updates only an owned HTTP monitor URL and restarts it", async () => {
    const Monitor = require("../../server/model/monitor");
    const originalStart = Monitor.prototype.start;
    const originalStop = Monitor.prototype.stop;
    let localStartCount = 0;
    let localStopCount = 0;
    let failNextStart = false;
    Monitor.prototype.start = async function () {
        localStartCount++;
        if (failNextStart) {
            failNextStart = false;
            throw new Error("simulated monitor startup failure");
        }
    };
    Monitor.prototype.stop = async function () {
        localStopCount++;
    };

    try {
        const created = await request("POST", writeToken, {
            name: "URL update target",
            url: "https://example.org/before",
        });
        assert.equal(created.response.status, 201);
        const monitorID = created.body.monitor.id;
        const startsBeforeUpdate = localStartCount;
        const stopsBeforeUpdate = localStopCount;

        const update = await request(
            "PATCH",
            writeToken,
            { url: "https://example.org/after", tags: ["CAEN", "Producción"] },
            "/" + monitorID
        );
        assert.equal(update.response.status, 200);
        assert.equal(update.body.monitor.url, "https://example.org/after");
        assert.equal(update.body.monitor.active, true);
        assert.deepEqual(update.body.monitor.tags.map((tag) => tag.name), ["CAEN", "Producción"]);
        assert.equal(localStopCount - stopsBeforeUpdate, 1);
        assert.equal(localStartCount - startsBeforeUpdate, 1);
        assert.equal(fakeServer.monitorList[monitorID].url, "https://example.org/after");

        const tagOnlyUpdate = await request("PATCH", writeToken, { tags: ["CAEN"] }, "/" + monitorID);
        assert.equal(tagOnlyUpdate.response.status, 200);
        assert.deepEqual(tagOnlyUpdate.body.monitor.tags.map((tag) => tag.name), ["CAEN"]);
        assert.equal(localStopCount - stopsBeforeUpdate, 1, "tag-only updates must not restart the monitor");
        assert.equal((await R.getAll("SELECT COUNT(*) AS count FROM tag WHERE name = ?", ["CAEN"]))[0].count, 1);

        const clearTags = await request("PATCH", writeToken, { tags: [] }, "/" + monitorID);
        assert.equal(clearTags.response.status, 200);
        assert.deepEqual(clearTags.body.monitor.tags, []);

        const restoreTags = await request("PATCH", writeToken, { tags: ["CAEN", "Producción"] }, "/" + monitorID);
        assert.equal(restoreTags.response.status, 200);

        const persisted = await R.findOne("monitor", " id = ? AND user_id = ? ", [monitorID, userA.id]);
        assert.equal(persisted.url, "https://example.org/after");

        const otherUserUpdate = await request("PATCH", writeToken, { url: "https://example.org/denied" }, "/" + otherMonitorID);
        assert.equal(otherUserUpdate.response.status, 404);

        const invalidUpdate = await request("PATCH", writeToken, { url: "javascript:alert(1)" }, "/" + monitorID);
        assert.equal(invalidUpdate.response.status, 400);
        const invalidTags = await request("PATCH", writeToken, { tags: ["bad/<tag>"] }, "/" + monitorID);
        assert.equal(invalidTags.response.status, 400);
        const unchanged = await R.findOne("monitor", " id = ? AND user_id = ? ", [monitorID, userA.id]);
        assert.equal(unchanged.url, "https://example.org/after");

        failNextStart = true;
        const failedRestart = await request(
            "PATCH",
            writeToken,
            { url: "https://example.org/failure", tags: ["CAEN"] },
            "/" + monitorID
        );
        assert.equal(failedRestart.response.status, 500);
        const rolledBack = await R.findOne("monitor", " id = ? AND user_id = ? ", [monitorID, userA.id]);
        assert.equal(rolledBack.url, "https://example.org/after");
        assert.equal(fakeServer.monitorList[monitorID].url, "https://example.org/after");
        const rolledBackTags = await rolledBack.getTags();
        assert.deepEqual(rolledBackTags.map((tag) => tag.name), ["CAEN", "Producción"]);
    } finally {
        Monitor.prototype.start = originalStart;
        Monitor.prototype.stop = originalStop;
    }
});

test("monitor API rejects invalid update IDs and empty update bodies", async () => {
    assert.equal((await request("PATCH", writeToken, { url: "https://example.org/" }, "/0")).response.status, 400);
    assert.equal((await request("PATCH", writeToken, {}, "/1")).response.status, 400);
});
