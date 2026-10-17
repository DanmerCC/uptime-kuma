const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");

/**
 * Resolve and validate an explicit existing SQLite data directory.
 * @param {string[]} args Command-line arguments
 * @returns {string} Absolute path to the data directory
 * @throws {Error} If the path is missing, invalid, or not SQLite
 */
function getDataDirectory(args) {
    const index = args.indexOf("--data-dir");
    let value = index >= 0 ? args[index + 1] : undefined;
    if (!value) {
        const equalsArg = args.find((arg) => arg.startsWith("--data-dir="));
        value = equalsArg ? equalsArg.slice("--data-dir=".length) : process.env.DATA_DIR;
    }
    if (!value) {
        throw new Error("Pass --data-dir <existing SQLite data directory> (or set DATA_DIR); no implicit data path is allowed.");
    }

    const dataDir = path.resolve(value);
    if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
        throw new Error("The selected data directory does not exist.");
    }
    if (!fs.existsSync(path.join(dataDir, "kuma.db"))) {
        throw new Error("No kuma.db exists in the selected data directory; refusing to create a database.");
    }

    const configPath = path.join(dataDir, "db-config.json");
    if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        if (config.type && config.type !== "sqlite") {
            throw new Error("This token issuer currently supports SQLite data directories only.");
        }
    }

    return dataDir;
}

/**
 * Interactively issue one scoped API token and display it exactly once.
 * @returns {Promise<void>} Completion promise
 */
async function main() {
    const dataDir = getDataDirectory(process.argv.slice(2));
    process.env.DATA_DIR = dataDir;

    const rl = readline.createInterface({ input: stdin, output: stdout });
    const ask = async (question) => (await rl.question(question)).trim();

    let connected = false;
    try {
        const confirmation = await ask(
            "This will add a scoped API key to the existing database at " + dataDir + ". Continue? Type yes: "
        );
        if (confirmation !== "yes") {
            console.log("Cancelled.");
            return;
        }

        const Database = require("../server/database");
        const { R } = require("redbean-node");
        const APIKey = require("../server/model/api_key");
        const passwordHash = require("../server/password-hash");

        Database.initDataDir({ "data-dir": dataDir });
        await Database.connect(false, true, true);
        connected = true;

        if (!(await R.knex.schema.hasColumn("api_key", "scopes_json"))) {
            throw new Error("The API key scopes migration is missing. Start the fork once to apply migrations, then retry.");
        }

        const username = await ask("Active Uptime Kuma username: ");
        const user = await R.findOne("user", " username = ? AND active = 1 ", [username]);
        if (!user) {
            throw new Error("No active user matches that username.");
        }

        const scopeInput = await ask("Scopes (monitors:read, monitors:write; comma-separated): ");
        const scopes = [...new Set(scopeInput.split(",").map((scope) => scope.trim()).filter(Boolean))];
        const validScopes = new Set(["monitors:read", "monitors:write"]);
        if (scopes.length === 0 || scopes.some((scope) => !validScopes.has(scope))) {
            throw new Error("Choose at least one supported scope: monitors:read or monitors:write.");
        }

        const name = (await ask("Token name: ")) || "Monitor automation";
        if (name.length > 255) {
            throw new Error("Token name must be 255 characters or fewer.");
        }
        const expirationInput = await ask("Expires in days (1-3650, default 90): ");
        const expirationDays = expirationInput === "" ? 90 : Number(expirationInput);
        if (!Number.isInteger(expirationDays) || expirationDays < 1 || expirationDays > 3650) {
            throw new Error("Expiration must be an integer from 1 to 3650 days.");
        }

        const finalConfirmation = await ask(
            "Create " + scopes.join(", ") + " token for " + username + " with " + expirationDays + "-day expiry? Type yes: "
        );
        if (finalConfirmation !== "yes") {
            console.log("Cancelled.");
            return;
        }

        const clearToken = crypto.randomBytes(32).toString("base64url");
        const hashedToken = await passwordHash.generate(clearToken);
        const expires = new Date(Date.now() + expirationDays * 24 * 60 * 60 * 1000).toISOString();
        const key = await APIKey.save({ key: hashedToken, name, active: true, expires }, user.id, scopes);

        console.log("\nToken created. Copy it now; it will not be shown again:\n");
        console.log("uk" + key.id + "_" + clearToken);
        console.log("\nScopes: " + scopes.join(", "));
        console.log("Expires: " + expires);
    } finally {
        rl.close();
        if (connected) {
            const Database = require("../server/database");
            await Database.close();
        }
    }
}

main().catch((error) => {
    console.error("Could not create API token: " + error.message);
    process.exitCode = 1;
});