# Errorcore Harness Pipeline

This harness drives encrypted Errorcore SDK captures through the local ingestion backend and verifies how far each event gets through admission, worker processing, object storage, projections, and scorecard output.

It tests:

- SDK capture output
- Encrypted NDJSON transport envelopes
- Forwarding to the backend ingest API
- Backend admission
- Worker processing
- MinIO/S3 object storage writes
- Read projection creation
- Scorecard generation

## Requirements

- Node.js 20 or newer
- Docker with Compose
- The backend repository beside this folder at `../ingestion-backend`
- The SDK repository beside this folder at `../ec-master`
- A built SDK at `../ec-master/dist` for current helper loading

## Configuration

Common environment variables:

- `EC_API_KEY`: bearer key used by the forwarder and seeded into the backend
- `EC_PROJECT_ID`: project ID associated with the seeded API key
- `EC_INGEST_URL`: ingest endpoint, usually `http://localhost:4318/v1/ingest`
- `EC_DEK`: SDK data encryption key, normalized by helper scripts when needed
- `DATABASE_URL`: Postgres connection string for seeding and verification
- `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`: S3 or MinIO verification settings
- `KEY_ENCRYPTION_SECRET`: backend project-key encryption secret
- `SUPPORTED_SDK_VERSIONS`: SDK versions accepted by the backend

The compose file includes local defaults for Postgres, MinIO, backend services, and the forwarder.

## Backend Services

Start the local backend stack:

```powershell
docker compose -f docker-compose.backend.yml up -d postgres minio createbucket api worker
```

Stop it:

```powershell
docker compose -f docker-compose.backend.yml down
```

## Pipeline Commands

Seed backend test data:

```powershell
node seed.mjs
```

Forward captured envelopes once:

```powershell
node forwarder.mjs --once captures
```

Decrypt captures:

```powershell
node tools/decrypt-captures.mjs
```

Verify admitted events, worker output, storage objects, and projections:

```powershell
node tools/verify-event.mjs
```

Create the scorecard:

```powershell
node tools/scorecard.mjs
```

## Output

Generated evidence is written under `artifacts`, including decoded captures, SQL snapshots, MinIO object checks, projection dumps, verification summaries, and `scorecard.json`.

## Common Issues

- Backend services need `dist` output. The compose API and worker commands build the backend before running `node dist/...`.
- Migrations must run before seeding or forwarding events.
- `EC_PROJECT_ID` and `EC_API_KEY` must match the seeded backend rows.
- The worker must be running for admitted events to become readable projections.
- `../ec-master/dist` must exist because the harness loads SDK encryption helpers from the built SDK.
