const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const knexFactory = require("knex");
const Dialect = require("knex/lib/dialects/sqlite3/index.js");
const migration = require("../../db/knex_migrations/2026-10-17-0000-api-key-scopes");

Dialect.prototype._driver = () => require("@louislam/sqlite3");

test("scopes migration preserves existing API keys and gives them no scopes", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kuma-key-scope-migration-"));
    const knex = knexFactory({
        client: Dialect,
        connection: { filename: path.join(tempDir, "migration.db") },
        useNullAsDefault: true,
    });

    try {
        await knex.schema.createTable("api_key", (table) => {
            table.increments("id").primary();
            table.string("key", 255).notNullable();
            table.string("name", 255).notNullable();
            table.integer("user_id").notNullable();
            table.boolean("active").notNullable().defaultTo(1);
            table.dateTime("expires").defaultTo(null);
        });
        await knex("api_key").insert({ id: 7, key: "bcrypt-hash", name: "legacy", user_id: 2, active: 1 });

        await migration.up(knex);

        const existingKey = await knex("api_key").where({ id: 7 }).first();
        assert.equal(existingKey.key, "bcrypt-hash");
        assert.equal(existingKey.name, "legacy");
        assert.equal(existingKey.scopes_json, "[]");

        await knex("api_key").insert({ key: "another-hash", name: "new", user_id: 2, active: 1 });
        const newKey = await knex("api_key").where({ name: "new" }).first();
        assert.equal(newKey.scopes_json, "[]");
    } finally {
        await knex.destroy();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});