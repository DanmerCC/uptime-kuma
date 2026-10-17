# Scoped management APIs (fork features)

This is a custom API in the DanmerCC fork, not an official Uptime Kuma API; stock Uptime Kuma does not provide these Bearer-token routes.

## Routes

- GET /api/v1/monitors — requires monitors:read; returns only monitors owned by the token's Uptime Kuma user.
- POST /api/v1/monitors — requires monitors:write; creates one HTTP monitor with optional tags.
- PATCH /api/v1/monitors/:id — requires monitors:write; updates the URL and/or replaces tags on an owned HTTP monitor. It restarts the monitor only if its URL changes and it is active. Delete, bulk, and other monitor types are not exposed.
- PATCH /api/v1/status-pages/:slug/groups — requires status-pages:write; adds owned monitors to named public groups on an existing status page.

Send Authorization: Bearer <token>. Existing API keys have an empty scope list and cannot use these routes unless a separately provisioned token has a required scope.

Create body accepts only name, url, optional interval (30–86400 seconds, default 60), description, acceptedStatusCodes, active, ignoreTls, and tags. Tags are an optional array of up to 10 names. The API creates missing global Uptime Kuma tags with safe default colors and reuses existing tags case- and accent-insensitively.

Update body accepts `url`, `tags`, or both. Tags replace the monitor's full tag set; use an empty array to remove all tags. Tag names are limited to 64 Unicode letters/numbers plus spaces, dots, underscores, and hyphens. Responses and monitor listings include an allowlisted tag name/value/color representation. IDs are scoped to the token owner; missing or other users' monitors return 404. URL changes are rolled back if the active monitor cannot be restarted. Tag names are global in Uptime Kuma, so issuing a monitors:write token also permits creating global tag names through an owned monitor.

Status-page group assignment body accepts only `groups`, with 1–10 named groups and up to 100 total monitor IDs, for example `{ "groups": [{ "name": "APIs", "monitorIDs": [10, 11] }] }`. Names match existing public groups case- and accent-insensitively; missing groups are created. Only listed monitors are moved between public groups on that status page; all unlisted groups, memberships, and status-page settings remain unchanged. IDs are scoped to the token owner, duplicate IDs/names and unknown fields are rejected, and the new public memberships keep monitor URLs hidden (`send_url=false`). The operation is idempotent. This endpoint does not create or publish status pages, change settings, or remove monitors from the page.

The monitor endpoints reject unknown fields, URL credentials, secret query parameters, fragments, and non-HTTP(S) URLs. Monitor URLs in responses are allowlisted and redact credentials and secret query parameters. A monitors:write token can cause Kuma to make outbound HTTP(S) requests and create global tag names; issue it only to trusted automation after reviewing targets.

## Issue/revoke a token

The explicitly invoked interactive issuer stores only a bcrypt hash and displays the random token once. It supports `monitors:read`, `monitors:write`, and `status-pages:write`. It requires the exact existing SQLite data directory; it refuses implicit paths and missing databases. Run it only in an authorized local/container administration session after the fork has been started once and its schema migration has completed:

    node extra/create-api-token.js --data-dir /app/data

Replace /app/data with the verified path for the instance's existing data directory. The command prompts for confirmation, an active Uptime Kuma username, scopes, name, and expiration (default 90 days, maximum 10 years). It does not enable or alter global API-key settings. Revoke the token later using the existing API-key controls in Uptime Kuma.

## Safe test/deployment boundary

Run the backend tests and build locally first. Tests use temporary SQLite databases and loopback ephemeral ports; they must never point to WSP01 data.

Before any separately authorized WSP01 deployment:
1. Verify the actual compose/service configuration and persistent data mount; do not assume a path or volume name.
2. Back up the complete existing data volume (database plus uploads/configuration) and verify the backup.
3. Keep the current image/version available for rollback.
4. Replace only the application image/code while reusing the same persistent data volume; do not delete/recreate it and never run docker compose down -v.
5. Verify monitor/user/API-key counts after startup and confirm rollback steps before proceeding.

A Knex migration adds scopes_json with a default of []; existing API-key rows remain intact and receive no new privileges.
