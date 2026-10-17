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
const { createStatusPageApiRouter } = require("../../server/routers/status-page-api-router");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kuma-status-page-api-"));
const testDb = new TestDB(dataDir);
let httpServer;
let baseURL;
let userA;
let userB;
let statusWriteToken;
let monitorWriteToken;
let statusPageID;
let existingGroupID;
let otherPageGroupID;
let keepMonitorID;
let moveMonitorID;
let newMonitorID;
let otherUserMonitorID;

/**
 * Insert an active test user.
 * @param {string} username Username
 * @returns {Promise<object>} User bean
 */
async function createUser(username) {
    const user = R.dispense("user");
    user.username = username;
    user.password = "test-hash";
    user.active = true;
    await R.store(user);
    return user;
}

/**
 * Insert an inactive HTTP test monitor.
 * @param {number} userID Owner user ID
 * @param {string} name Monitor name
 * @returns {Promise<object>} Monitor bean
 */
async function createMonitor(userID, name) {
    const monitor = R.dispense("monitor");
    monitor.name = name;
    monitor.type = "http";
    monitor.url = "https://example.org/" + name.toLowerCase().replace(/\s+/g, "-");
    monitor.interval = 60;
    monitor.retryInterval = 60;
    monitor.accepted_statuscodes_json = JSON.stringify(["200-299"]);
    monitor.active = false;
    monitor.user_id = userID;
    await R.store(monitor);
    return monitor;
}

/**
 * Insert a public status-page group.
 * @param {number} statusPageID Status page ID
 * @param {string} name Group name
 * @param {number} weight Group ordering weight
 * @returns {Promise<object>} Group bean
 */
async function createGroup(statusPageID, name, weight) {
    const group = R.dispense("group");
    group.status_page_id = statusPageID;
    group.name = name;
    group.public = true;
    group.weight = weight;
    await R.store(group);
    return group;
}

/**
 * Link a monitor to a test group.
 * @param {number} groupID Group ID
 * @param {number} monitorID Monitor ID
 * @param {number} weight Ordering weight
 * @returns {Promise<void>} Completion promise
 */
async function assign(groupID, monitorID, weight = 1) {
    const relation = R.dispense("monitor_group");
    relation.group_id = groupID;
    relation.monitor_id = monitorID;
    relation.weight = weight;
    relation.send_url = false;
    await R.store(relation);
}

/**
 * Create a hashed API token for a test user.
 * @param {number} userID Owner user ID
 * @param {string[]} scopes Token scopes
 * @returns {Promise<string>} One-time clear token
 */
async function createToken(userID, scopes) {
    const raw = "test_" + crypto.randomBytes(32).toString("base64url");
    const key = await APIKey.save(
        { key: await passwordHash.generate(raw), name: "test token", active: true, expires: null },
        userID,
        scopes
    );
    return "uk" + key.id + "_" + raw;
}

/**
 * Send a request to the ephemeral status-page API test server.
 * @param {string} method HTTP method
 * @param {string|null} token Bearer token
 * @param {object|undefined} body Optional JSON body
 * @param {string} slug Status-page slug
 * @returns {Promise<object>} Response and decoded JSON body
 */
async function request(method, token, body, slug = "todos") {
    const response = await fetch(baseURL + "/api/v1/status-pages/" + slug + "/groups", {
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
    userA = await createUser("status-page-api-a");
    userB = await createUser("status-page-api-b");
    statusWriteToken = await createToken(userA.id, ["status-pages:write"]);
    monitorWriteToken = await createToken(userA.id, ["monitors:write"]);

    const statusPage = R.dispense("status_page");
    statusPage.slug = "todos";
    statusPage.title = "Public status";
    statusPage.icon = "";
    statusPage.theme = "auto";
    statusPage.published = true;
    await R.store(statusPage);
    statusPageID = statusPage.id;

    const existingGroup = await createGroup(statusPageID, "Servicios", 1);
    existingGroupID = existingGroup.id;
    const keepMonitor = await createMonitor(userA.id, "Keep existing");
    const moveMonitor = await createMonitor(userA.id, "Move between groups");
    const newMonitor = await createMonitor(userA.id, "New API service");
    keepMonitorID = keepMonitor.id;
    moveMonitorID = moveMonitor.id;
    newMonitorID = newMonitor.id;
    otherUserMonitorID = (await createMonitor(userB.id, "Other owner monitor")).id;
    await assign(existingGroupID, keepMonitorID, 1);
    await assign(existingGroupID, moveMonitorID, 2);

    const otherPage = R.dispense("status_page");
    otherPage.slug = "another-page";
    otherPage.title = "Another status";
    otherPage.icon = "";
    otherPage.theme = "auto";
    await R.store(otherPage);
    const otherPageGroup = await createGroup(otherPage.id, "Other page group", 1);
    otherPageGroupID = otherPageGroup.id;
    await assign(otherPageGroupID, moveMonitorID, 1);

    const app = express();
    app.use(express.json());
    app.use("/api/v1/status-pages", createStatusPageApiRouter({ R, bearerAuth }));
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

test("status-page write API requires a valid token and the dedicated scope", async () => {
    assert.equal((await request("PATCH", null, { groups: [{ name: "APIs", monitorIDs: [newMonitorID] }] })).response.status, 401);
    assert.equal(
        (await request("PATCH", monitorWriteToken, { groups: [{ name: "APIs", monitorIDs: [newMonitorID] }] })).response.status,
        403
    );
});

test("status-page write API validates slug, payload, and monitor ownership", async () => {
    const valid = { groups: [{ name: "APIs", monitorIDs: [newMonitorID] }] };
    assert.equal((await request("PATCH", statusWriteToken, valid, "missing-page")).response.status, 404);
    assert.equal((await request("PATCH", statusWriteToken, valid, "bad--slug")).response.status, 400);
    assert.equal((await request("PATCH", statusWriteToken, { groups: valid.groups, published: true })).response.status, 400);
    assert.equal(
        (await request("PATCH", statusWriteToken, { groups: [{ name: "APIs", monitorIDs: [otherUserMonitorID] }] })).response.status,
        404
    );
    assert.equal(
        (await request("PATCH", statusWriteToken, { groups: [{ name: "APIs", monitorIDs: [99999] }] })).response.status,
        404
    );
});

test("status-page write API adds monitors to named groups without deleting unrelated page data", async () => {
    const payload = {
        groups: [
            { name: "Servicios", monitorIDs: [moveMonitorID] },
            { name: "APIs institucionales", monitorIDs: [newMonitorID] },
        ],
    };
    const first = await request("PATCH", statusWriteToken, payload);
    assert.equal(first.response.status, 200);
    assert.equal(first.body.ok, true);
    assert.equal(first.body.groups.length, 2);
    assert.equal(first.body.groups[0].id, existingGroupID);
    assert.equal(first.body.groups[1].name, "APIs institucionales");

    const assignedRows = await R.getAll(
        `SELECT monitor_group.monitor_id, monitor_group.group_id, monitor_group.send_url
        FROM monitor_group
        INNER JOIN \`group\` ON \`group\`.id = monitor_group.group_id
        WHERE \`group\`.status_page_id = ? AND \`group\`.public = 1
        ORDER BY \`group\`.weight, monitor_group.weight`,
        [statusPageID]
    );
    assert.deepEqual(assignedRows.map((row) => Number(row.monitor_id)).sort((a, b) => a - b),
        [keepMonitorID, moveMonitorID, newMonitorID].sort((a, b) => a - b));
    assert.ok(assignedRows.every((row) => row.send_url === 0 || row.send_url === false));
    assert.equal(assignedRows.filter((row) => Number(row.monitor_id) === moveMonitorID).length, 1);

    const otherPageMembership = await R.getAll("SELECT id FROM monitor_group WHERE group_id = ? AND monitor_id = ?", [
        otherPageGroupID,
        moveMonitorID,
    ]);
    assert.equal(otherPageMembership.length, 1);

    const repeated = await request("PATCH", statusWriteToken, payload);
    assert.equal(repeated.response.status, 200);
    const repeatedRows = await R.getAll(
        `SELECT monitor_group.monitor_id FROM monitor_group
        INNER JOIN \`group\` ON \`group\`.id = monitor_group.group_id
        WHERE \`group\`.status_page_id = ? AND \`group\`.public = 1`,
        [statusPageID]
    );
    assert.equal(repeatedRows.length, 3);
});
