# Errorcore Harness Pipeline

Local harness for sending encrypted Errorcore captures through the ingestion backend and checking admission, worker output, storage, projections, and scorecards.

Expected layout:

```text
../ec-master
../ingestion-backend
../harness-pipeline
```

Requires Node.js 20+, Docker Compose, a built SDK at `../ec-master/dist`, and the backend repo at `../ingestion-backend`.

Start the backend stack:

```powershell
docker compose -f docker-compose.backend.yml up -d postgres minio createbucket api worker
```

Run the harness:

```powershell
node seed.mjs
node forwarder.mjs --once captures
node tools/decrypt-captures.mjs
node tools/verify-event.mjs
node tools/scorecard.mjs
```

Generated evidence goes under `artifacts`. Captures go under `captures`. Both are ignored by Git.

Stop the stack:

```powershell
docker compose -f docker-compose.backend.yml down
```
