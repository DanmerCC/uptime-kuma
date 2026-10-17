const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    validateMonitorPayload,
    validateMonitorUpdatePayload,
    redactMonitorURL,
    toPublicMonitor,
} = require("../../server/routers/monitor-api-utils");

test("monitor API accepts a narrow HTTP monitor payload and applies safe defaults", () => {
    const monitor = validateMonitorPayload({ name: " Web ", url: "https://example.org/status" });
    assert.deepEqual(monitor, {
        name: "Web",
        url: "https://example.org/status",
        interval: 60,
        description: "",
        acceptedStatusCodes: ["200-299"],
        active: true,
        ignoreTls: false,
        tags: [],
    });
});

test("monitor API validates bounded Unicode tags and partial update fields", () => {
    const monitor = validateMonitorPayload({
        name: "Web",
        url: "https://example.org",
        tags: ["CAEN", "Producción"],
    });
    assert.deepEqual(monitor.tags, ["CAEN", "Producción"]);
    assert.deepEqual(validateMonitorUpdatePayload({ tags: [] }), { tags: [] });
    assert.deepEqual(validateMonitorUpdatePayload({ url: "https://example.org/new" }), {
        url: "https://example.org/new",
    });
    assert.throws(() => validateMonitorUpdatePayload({}));
    assert.throws(() => validateMonitorPayload({ name: "Web", url: "https://example.org", tags: ["bad/<tag>"] }));
    assert.throws(() => validateMonitorPayload({ name: "Web", url: "https://example.org", tags: ["CAEN", "caen"] }));
    assert.throws(() => validateMonitorPayload({ name: "Web", url: "https://example.org", tags: Array(11).fill("tag") }));
});

test("monitor API rejects mass assignment and non-HTTP URLs", () => {
    assert.throws(() => validateMonitorPayload({ name: "Web", url: "https://example.org", user_id: 1 }));
    assert.throws(() => validateMonitorPayload({ name: "Web", url: "file:///etc/passwd" }));
    assert.throws(() => validateMonitorPayload({ name: "Web", url: "https://user:pass@example.org" }));
    assert.throws(() => validateMonitorPayload({ name: "Web", url: "https://example.org/?token=secret" }));
});

test("monitor API bounds intervals and validates status code ranges", () => {
    assert.throws(() => validateMonitorPayload({ name: "Web", url: "https://example.org", interval: 1 }));
    assert.throws(() =>
        validateMonitorPayload({ name: "Web", url: "https://example.org", acceptedStatusCodes: ["299-200"] })
    );
});

test("monitor API strips URL credentials and secret query values from existing records", () => {
    assert.equal(
        redactMonitorURL("https://user:password@example.org/health?key=secret&region=west#frag"),
        "https://example.org/health?region=west"
    );
    const monitor = toPublicMonitor({
        id: 9,
        name: "Web",
        description: "",
        url: "https://example.org/?token=hide-me",
        interval: 60,
        active: 1,
    });
    assert.equal(monitor.url, "https://example.org/");
    assert.deepEqual(Object.keys(monitor).sort(), ["active", "description", "id", "interval", "name", "tags", "type", "url"]);
    assert.deepEqual(monitor.tags, []);
    assert.deepEqual(toPublicMonitor({ id: 1, name: "Tagged", url: "https://example.org", interval: 60, active: 1 }, [
        { name: "CAEN", value: "", color: "#005ea8" },
    ]).tags, [{ name: "CAEN", value: "", color: "#005ea8" }]);
});
