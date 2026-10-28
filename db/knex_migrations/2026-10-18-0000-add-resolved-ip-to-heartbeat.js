exports.up = function (knex) {
    return knex.schema.alterTable("heartbeat", function (table) {
        table.string("resolved_ip", 45).nullable().defaultTo(null);
    });
};

exports.down = function (knex) {
    return knex.schema.alterTable("heartbeat", function (table) {
        table.dropColumn("resolved_ip");
    });
};
