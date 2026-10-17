const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeGroupName, validateStatusPageGroupsPayload } = require("../../server/routers/status-page-api-utils");

test("status-page API validates bounded group assignments and normalizes group names", () => {
    assert.equal(normalizeGroupName("  APIs Instituciónales  "), "apis institucionales");
    assert.deepEqual(
        validateStatusPageGroupsPayload({
            groups: [
                { name: "Servicios", monitorIDs: [10, 11] },
                { name: "APIs", monitorIDs: [12] },
            ],
        }),
        {
            groups: [
                { name: "Servicios", normalizedName: "servicios", monitorIDs: [10, 11] },
                { name: "APIs", normalizedName: "apis", monitorIDs: [12] },
            ],
            monitorIDs: [10, 11, 12],
        }
    );
});

test("status-page API rejects unknown properties, unsafe group names, and duplicate assignments", () => {
    assert.throws(() => validateStatusPageGroupsPayload({ groups: [{ name: "", monitorIDs: [1] }] }));
    assert.throws(() => validateStatusPageGroupsPayload({ groups: [{ name: "bad/<name>", monitorIDs: [1] }] }));
    assert.throws(() => validateStatusPageGroupsPayload({ groups: [{ name: "A", monitorIDs: [1, 1] }] }));
    assert.throws(() =>
        validateStatusPageGroupsPayload({ groups: [{ name: "API", monitorIDs: [1] }, { name: "api", monitorIDs: [2] }] })
    );
    assert.throws(() => validateStatusPageGroupsPayload({ groups: [{ name: "A", monitorIDs: [0] }] }));
    assert.throws(() => validateStatusPageGroupsPayload({ groups: [{ name: "A", monitorIDs: [] }] }));
    assert.throws(() => validateStatusPageGroupsPayload({ groups: [{ name: "A", monitorIDs: [1], public: true }] }));
    assert.throws(() => validateStatusPageGroupsPayload({ groups: [{ name: "A", monitorIDs: [1] }], title: "changed" }));
});

test("status-page API bounds requests to ten groups and one hundred monitors", () => {
    assert.throws(() =>
        validateStatusPageGroupsPayload({
            groups: Array.from({ length: 11 }, (_, index) => ({ name: "Group " + index, monitorIDs: [index + 1] })),
        })
    );
    assert.throws(() =>
        validateStatusPageGroupsPayload({
            groups: [{ name: "Group", monitorIDs: Array.from({ length: 101 }, (_, index) => index + 1) }],
        })
    );
});
