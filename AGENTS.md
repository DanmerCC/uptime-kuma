# Agent Instructions — DanmerCC Uptime Kuma Fork

## Purpose and target

This is a user-owned fork of Uptime Kuma for implementing and testing changes requested by its owner. The GitHub repository is public: never commit secrets, live tokens, customer data, or production database dumps.

WSP01 currently runs Uptime Kuma 2.5.5. Changes intended for WSP01 should be based on tag 2.5.5 and remain compatible with it unless the owner explicitly requests a version upgrade.

## Allowed work

- Implement user-requested features and bug fixes, including changes across multiple files.
- Explain relevant design decisions and call out security, compatibility, and migration impacts.
- Add and run appropriate tests, lint, and builds; report what ran and any limitations.
- Keep changes focused, preserve unrelated work, and use feature branches named codex/....
- Do not commit, push, publish releases/images, open upstream pull requests, or deploy to WSP01 unless the owner explicitly asks.
- Never access or modify production data or configuration without explicit authorization and a backup/rollback plan.

## API token and authentication requirements

- Prefer least-privilege scopes such as monitors:read and monitors:write.
- Generate high-entropy tokens, store only a cryptographic password hash, and reveal the raw token only once at issuance. Never log or commit tokens.
- Support expiration and revocation; bind each token to a user and enforce ownership for every monitor operation.
- Use the standard Authorization: Bearer header, rate-limit authentication failures, and return safe errors that do not reveal secrets.
- Token issuance must require an authenticated administrator or an explicitly invoked, interactive administrative CLI. Do not add an unauthenticated bootstrap endpoint.
- Preserve existing authentication; do not disable auth as a workaround. Prefer existing models/migrations over runtime direct SQL edits.

## Validation and deployment

Test successful authorization, invalid/expired/revoked tokens, insufficient scopes, cross-user access, and malformed requests. Run the relevant backend tests and build checks before considering a change ready.

Test on a staging instance first. Production deployment to WSP01 requires a separate explicit authorization, a database backup, and a rollback/maintenance plan.

## Monitor provisioning scope for WSP01

The immediate use case is to add only the missing service/assets as monitors on WSP01, without operating Uptime Kuma through its UI. Treat the added management API as a custom feature of this fork, not as an official upstream Uptime Kuma API.

- Base implementation and compatibility work on Uptime Kuma 2.5.5, the version currently deployed on WSP01.
- Keep the first API surface narrow: `GET /api/v1/monitors` with `monitors:read`, and `POST /api/v1/monitors` with `monitors:write`; initially accept HTTP/HTTPS monitors only. Do not add update/delete/bulk routes unless the owner asks.
- Before creating monitors, compare the requested assets with the current monitor list and create only missing entries; avoid duplicates. Do not silently change existing monitors.
- Prefer the fork API or a purpose-built script for monitor management. Do not treat direct production database edits as a normal management interface.
- Add schema changes through Knex migrations, never by editing the initial schema file. Keep token secrets out of responses, logs, source control, and chat.
- Document that the fork's API must be deployed before it can be used against WSP01; code changes alone do not modify the running instance.
