const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const knexFactory = require("knex");
const Dialect = require("knex/lib/dialects/sqlite3/index.js");
const Heartbeat = require("../../server/model/heartbeat");
const { captureResolvedIp, getLastResolvedIpMap, getRemoteAddress } = require("../../server/extensions/resolved-ip");
const migration = require("../../db/knex_migrations/2026-10-18-0000-add-resolved-ip-to-heartbeat");

Dialect.prototype._driver = () => require("@louislam/sqlite3");

test("getRemoteAddress reads the remote address from the final response socket", () => {
    assert.strictEqual(
        getRemoteAddress({
            request: {
                res: {
                    socket: {
                        remoteAddress: "203.0.113.12",
                    },
                },
            },
        }),
        "203.0.113.12"
    );

    assert.strictEqual(
        getRemoteAddress({
            request: {
                socket: {
                    remoteAddress: "2001:db8::12",
                },
            },
        }),
        "2001:db8::12"
    );
});

test("captureResolvedIp ignores proxied requests and responses without a socket", () => {
    const heartbeat = {};
    captureResolvedIp(
        heartbeat,
        {
            request: {
                socket: {
                    remoteAddress: "198.51.100.8",
                },
            },
        },
        true
    );
    assert.strictEqual(heartbeat.resolved_ip, undefined);

    captureResolvedIp(heartbeat, {});
    assert.strictEqual(heartbeat.resolved_ip, undefined);
});

test("heartbeat JSON includes the resolved IP for authenticated clients", () => {
    const heartbeat = {
        _monitorId: 6,
        _status: 1,
        _time: "2026-10-18 00:00:00.000",
        _msg: "200 - OK",
        _ping: 12,
        _important: false,
        _duration: 0,
        _retries: 0,
        _resolvedIp: "203.0.113.6",
        _response: null,
    };

    assert.strictEqual(Heartbeat.prototype.toJSON.call(heartbeat).resolvedIp, "203.0.113.6");
});

test("getLastResolvedIpMap skips empty lists and maps returned rows", async () => {
    let queryCalled = false;
    const fakeR = {
        async getAll(query, params) {
            queryCalled = true;
            assert.match(query, /resolved_ip IS NOT NULL/);
            assert.deepStrictEqual(params, [4, 8]);
            return [
                { monitor_id: 4, resolved_ip: "203.0.113.4" },
                { monitor_id: 8, resolved_ip: "2001:db8::8" },
            ];
        },
    };

    assert.deepStrictEqual(await getLastResolvedIpMap(fakeR, []), new Map());
    assert.strictEqual(queryCalled, false);

    const result = await getLastResolvedIpMap(fakeR, [4, 8]);
    assert.strictEqual(queryCalled, true);
    assert.deepStrictEqual(
        result,
        new Map([
            [4, "203.0.113.4"],
            [8, "2001:db8::8"],
        ])
    );
});

test("heartbeat migration adds a nullable resolved IP field", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kuma-resolved-ip-migration-"));
    const knex = knexFactory({
        client: Dialect,
        connection: { filename: path.join(tempDir, "migration.db") },
        useNullAsDefault: true,
    });

    try {
        await knex.schema.createTable("heartbeat", (table) => {
            table.increments("id").primary();
            table.integer("monitor_id").notNullable();
        });

        await migration.up(knex);

        await knex("heartbeat").insert({ monitor_id: 3, resolved_ip: null });
        const row = await knex("heartbeat").where({ monitor_id: 3 }).first();
        assert.strictEqual(row.resolved_ip, null);
        assert.strictEqual((await knex("heartbeat").columnInfo()).resolved_ip.maxLength, "45");
    } finally {
        await knex.destroy();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
