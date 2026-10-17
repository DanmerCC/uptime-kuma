exports.up = function (knex) {
    return knex.schema.alterTable("api_key", (table) => {
        table.text("scopes_json").notNullable().defaultTo("[]");
    });
};

exports.down = function (knex) {
    return knex.schema.alterTable("api_key", (table) => table.dropColumn("scopes_json"));
};