process.env.UPTIME_KUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const TestDB = require("../mock-testdb");
const Database = require("../../server/database");
const { R } = require("redbean-node");
const passwordHash = require("../../server/password-hash");
const { Settings } = require("../../server/settings");

/**
 * Drive the interactive issuer by replying only after each prompt is emitted.
 * @param {string} dataDir Temporary Uptime Kuma data directory
 * @returns {Promise<object>} Child process status and output
 */
function runIssuer(dataDir) {
    return new Promise((resolve, reject) => {
        const answers = [
            "yes",
            "token-issuer-test",
            "monitors:read,monitors:write,status-pages:write",
            "CLI integration token",
            "1",
            "yes",
        ];
        const prompts = ["Type yes: ", "username: ", "comma-separated): ", "Token name: ", "default 90): "];
        const child = spawn(process.execPath, ["extra/create-api-token.js", "--data-dir", dataDir], {
            cwd: path.resolve(__dirname, "../.."),
            env: { ...process.env, DATA_DIR: "" },
            stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let promptIndex = 0;
        let searchFrom = 0;
        const timeout = setTimeout(() => {
            child.kill();
            reject(new Error("Token issuer did not finish within 30 seconds."));
        }, 30000);

        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
            while (promptIndex < prompts.length) {
                const promptAt = stdout.indexOf(prompts[promptIndex], searchFrom);
                if (promptAt < 0) {
                    break;
                }
                searchFrom = promptAt + prompts[promptIndex].length;
                child.stdin.write(answers[promptIndex] + "\n");
                promptIndex++;
            }

            if (promptIndex === prompts.length && stdout.includes("Type yes: ", searchFrom)) {
                child.stdin.write(answers[promptIndex] + "\n");
                promptIndex++;
                child.stdin.end();
            }
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.on("error", (error) => {
            clearTimeout(timeout);
            reject(error);
        });
        child.on("close", (status) => {
            clearTimeout(timeout);
            resolve({ status, stdout, stderr });
        });
    });
}

test("interactive token issuer stores only a scoped hash in an explicit temp data directory", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kuma-token-issuer-"));
    const testDb = new TestDB(dataDir);
    let connected = false;

    try {
        await testDb.create();
        const user = R.dispense("user");
        user.username = "token-issuer-test";
        user.password = "test-hash";
        user.active = true;
        await R.store(user);
        await Database.close();
        Settings.stopCacheCleaner();

        const result = await runIssuer(dataDir);
        assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);

        const matches = [...result.stdout.matchAll(/uk([1-9]\d*)_([A-Za-z0-9_-]{43})/g)];
        assert.equal(matches.length, 1);
        const clearToken = matches[0][0];

        Database.initDataDir({ "data-dir": dataDir });
        await Database.connect(true);
        connected = true;
        const key = await R.findOne("api_key", " name = ? ", ["CLI integration token"]);
        assert.ok(key);
        assert.notEqual(key.key, clearToken);
        assert.equal(passwordHash.verify(clearToken.slice(clearToken.indexOf("_") + 1), key.key), true);
        assert.deepEqual(JSON.parse(key.scopes_json), ["monitors:read", "monitors:write", "status-pages:write"]);
    } finally {
        if (connected) {
            await Database.close();
        }
        Settings.stopCacheCleaner();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});
