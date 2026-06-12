# Codex Mission Prompt — errorcore End-to-End Natural-Error Pipeline Validation

> Paste everything in this file into the agent as its task. It is self-contained.
> Your single job: **run the errorcore SDK and the ingestion backend together, drive REAL bugs
> (sourced from real git fix commits) through the whole pipeline, measure how far the result is
> from what errorcore promises, and produce ONE report.**

---

## 0. Mission (read this twice)

errorcore is a Node SDK that captures the program state at the moment of failure (source-mapped
stack, V8 local variables at the throw frame, an ordered IO timeline, request context, DB query
text + bind params, state reads/writes, async/event-clock ordering, cross-service trace
correlation, process/release metadata) and ships an encrypted "error package" to an ingestion
backend. The backend admits the envelope, a worker decrypts and reconstructs it, scrubs it, writes
a snapshot to object storage, and exposes a readable projection (`mcp_shape`) — the thing a
consumer ultimately reads.

We have tested the SDK in isolation before. We have **never** run the SDK and the **real ingestion
backend together against real, naturally-occurring application bugs.** That is this mission.

You will:

1. Stand up the ingestion backend + Postgres + MinIO (R2 substitute) in containers, with Clerk and
   Polar stubbed/placeholdered.
2. Stand up real OSS Node applications in containers, each instrumented with errorcore **without
   editing the app's source**, checked out at a commit where a **real bug is live**.
3. Trigger each bug **naturally** (a real request / real call path that genuinely fails — never a
   hand-thrown or synthetic error), let errorcore capture it, and deliver the envelope to the
   backend.
4. Trace every event through the pipeline stages and score it against the errorcore promise.
5. Compile **one** report: a single, severity-ranked, deduplicated list of the gaps between what
   errorcore promises ("the plan") and what actually survives end to end.

The quality of this run is the quality of this report. Be exact, be evidence-driven, and when
something cannot be done within the rules, **that is a finding** — not a reason to break a rule.

---

## 1. The baseline ("the plan") you are measuring against

A **gap** is anything errorcore promises to deliver that does **not** arrive faithfully at the
consumer-readable end of the pipeline (the `read_projections.mcp_shape`), OR drops/degrades/leaks
anywhere along the way.

The promise is defined by these sources (already in the repo — read them, cite them in findings):

- `/workspace/ec-master/README.md` → "What errorcore captures".
- `/workspace/ec-master/spec/index.md` and `spec/01..22-*.md` → the locked module specifications
  (e.g., `13-error-capture-pipeline`, `12-v8-inspector`, `08-io-recording`, `09-database-patches`,
  `04-pii-scrubbing`, `14-transport`, `20-event-stamping`, `21-w3c-tracestate`, `22-state-write-tracking`).
- `/workspace/ec-master/spec/index.md` → "Performance Guarantees" and "Security Requirements".

The promised **capture dimensions** (your scorecard rows) are:

| # | Dimension | Promised by |
|---|-----------|-------------|
| D1 | Error identity: type, message, **source-mapped** stack, error properties | README, spec 13 |
| D2 | **V8 local variables & arguments** at the throwing frame(s) | README, spec 12/13 |
| D3 | **IO timeline**, ordered: inbound HTTP, outbound HTTP/fetch, DNS/TCP, DB queries | README, spec 03/08/10 |
| D4 | Request context: req/res headers + bodies, ALS correlation to the failing request | README, spec 06/07/15 |
| D5 | **DB query text + bind parameters** | README, spec 09 |
| D6 | State reads **and writes** from tracked containers | README, spec 11/22 |
| D7 | Async causality / **event-clock** ordering across the timeline | spec 19/20 |
| D8 | **Cross-service correlation** (W3C trace/tracestate across services) | spec 21 |
| D9 | Process / release / env / source-map context | README, spec 13 |
| D10 | **PII scrubbing**: no secrets/PII leak into the readable projection | README, spec 04 |
| D11 | Completeness flags are **honest** (claim captured ⇔ actually captured) | spec 13 |

The pipeline **stages** (your scorecard columns) are:

- **S0 — Ground truth.** What actually happened in the real bug (known from the git fix + repro).
- **S1 — SDK capture.** The error package errorcore actually produced (decrypt the NDJSON envelope locally with the DEK you control).
- **S2 — Admission.** Backend accepted the envelope (`POST /v1/ingest` → 202; `ingest_admissions` row).
- **S3 — Worker reconstruction.** `snapshots` row reaches `status='readable'`; raw + snapshot objects in MinIO.
- **S4 — Readable projection.** `read_projections.mcp_shape` — what a consumer reads.

For each (dimension × stage) cell, the status is one of:
`faithful` · `degraded/truncated` · `missing` · `leaked` (D10 only) · `pipeline-crashed` · `n/a`.

**The headline gap for each dimension = its status at S4** (plus the earliest stage where it broke).

---

## 2. Absolute rules (non-negotiable)

1. **NO EDITING CODE** in any of the three product trees:
   - `/workspace/ec-master` (the SDK)
   - `/workspace/ingestion-backend` (the backend)
   - any cloned OSS application repo
   "Editing code" = changing any tracked source file. You **MAY**: `npm ci`/install dependencies,
   compile/build (`npm run build`, `tsc`), run migrations, run tests, and **`git checkout` a
   different commit** of an OSS repo (that is the method, not an edit).
2. **All glue you create lives under `/workspace/harness-pipeline/`** (configs, compose files, the
   seed script, the errorcore preload bootstrap, the forwarder, decrypt/scoring scripts, per-app
   trigger scripts, stubs, artifacts, and the report). Nothing you author goes inside the product
   trees.
3. **Natural errors only.** Every captured error must come from a real failing code path in the
   app at a real buggy commit. **No** `throw new Error(...)` test injection, no fault injection, no
   synthetic toxics. The git fix tells you *what input breaks it*; you reproduce that for real.
4. **Evidence or it didn't happen.** Every finding cites concrete evidence: event ids, the
   forwarder's per-event HTTP status, SQL rows, decrypted package excerpts, projection JSON, object
   keys, container logs — and an exact repro command.
5. **A blocker is a finding.** If the SDK cannot reach the backend by configuration alone, if an
   envelope is rejected, if the worker crashes, if a promised dimension never makes it — record it
   with evidence and keep going. Do not work around it by editing product code.
6. **One report.** The single deliverable is `/workspace/harness-pipeline/REPORT.md`. Everything
   else is supporting evidence under `/workspace/harness-pipeline/artifacts/`.

---

## 3. Environment & topology

The host repo root is mounted at `/workspace`. Key paths:

- SDK: `/workspace/ec-master` (built output in `/workspace/ec-master/dist`)
- Backend: `/workspace/ingestion-backend` (Fastify API + worker; `npm` scripts: `migrate`,
  `dev`/`start` (API), `worker`/`start:worker`, `e2e`)
- Existing harness you may reuse for reference/decoding:
  `/workspace/ec-master/harness/collector/decode-captures.mjs` (working envelope decoder),
  `/workspace/ec-master/harness/apps/*/errorcore-bootstrap.js` (bootstrap examples).
- Backend audit (reference only, do not depend on): `/workspace/ingestion-backend-audit.md`,
  `/workspace/ingestion-backend-audit-copy/docker-compose.audit.yml`.

Target container topology (you author the compose under `harness-pipeline/`):

```
            ┌─────────────────────────── docker network: ec-pipeline ───────────────────────────┐
  app-1 ─┐  │  ┌──────────┐   ┌──────────┐   ┌──────────────┐   ┌──────────┐   ┌──────────────┐ │
  app-2 ─┼─▶│  │ forwarder│──▶│   api    │──▶│  postgres    │◀──│  worker  │──▶│   minio (R2) │ │
  app-3 ─┘  │  └──────────┘   │ :4318    │   │  :5432       │   └──────────┘   │  :9000       │ │
  (write    │      ▲          └──────────┘   └──────────────┘                  └──────────────┘ │
  encrypted │      │ tails                                                                       │
  NDJSON to │   shared `captures` volume (NDJSON envelopes + forwarder.log)                      │
  /captures)└──────┴──────────────────────────────────────────────────────────────────────────┘
```

- Apps write **encrypted envelopes** (one JSON object per line) to the shared `captures` volume via
  errorcore's `file` transport. They do **not** talk to the backend directly.
- The **forwarder** tails those NDJSON files and POSTs each envelope line to `api:4318/v1/ingest`.
  This is the wiring choice (see §4) — it needs no SDK code change and gives a clean SDK-vs-backend
  measurement boundary.
- Clerk and Polar are placeholders. Our depth target is **`read_projections` reaching `readable`**,
  which does not require real Clerk/Polar.

---

## 4. SDK → backend wiring (decided; do not improvise around the rules)

The backend's own `scripts/e2e.ts` is the canonical, known-good contract. Mirror it exactly.

- Each errorcore `file`-transport line is a complete `EncryptedEnvelope` JSON:
  `{ v:1, eventId, keyId, sdk:{ name:'errorcore', version }, ... ciphertext ... }`.
- The backend admits it at `POST /v1/ingest` with headers
  `authorization: Bearer <apiKey>` and `content-type: application/errorcore+json`, returning **202**.
- The worker decrypts using project key material seeded in `project_keys`, keyed by the envelope's
  `keyId`, where `encrypted_encryption_key = encryptProjectSecret(<DEK>, KEY_ENCRYPTION_SECRET)`.

**Primary path: file transport + forwarder** (use this). It sidesteps the SDK's
`"HTTP transport is not supported in local-only mode"` gate (`/workspace/ec-master/src/transport/transport.ts:236`)
**without editing the SDK**, and lets you diff "what the SDK wrote" against "what the backend exposed".

**Also run, as a recorded experiment (one finding either way): native HTTP transport.** Configure
the SDK bootstrap with `transport: { type:'http', url:'http://api:4318/v1/ingest' }`, an
`encryptionKey`, the `Bearer` authorization, and `allowPlainHttpTransport: true`, and observe
whether the SDK can deliver to `/v1/ingest` **by configuration alone**. Whether it succeeds, fails
the local-only gate, sends the wrong `content-type`, or omits auth — record it. "Can a user point
errorcore at this backend without code changes?" is itself a plan-conformance question.

---

## 5. Roles & goals

Execute as one orchestrator running these eight roles in order. Each role has a hard **done-gate**;
do not advance until it is met (or the failure is recorded as a finding with evidence).

### R1 — Infra Operator
**Goal:** backend + Postgres + MinIO + worker healthy.
- Author `/workspace/harness-pipeline/docker-compose.backend.yml` (template in §7).
- Ensure SDK is built: if `/workspace/ec-master/dist` is missing/stale, run
  `cd /workspace/ec-master && npm ci && npm run build` (compiling is allowed; editing is not).
- Bring up postgres, minio, create the bucket, then api (runs `npm ci && npm run build && npm run
  migrate` then starts), then worker.
- **Done-gate:** `GET http://api:4318/health` (or the actual health route — confirm in
  `/workspace/ingestion-backend/src`) returns OK; `npm run migrate` completed; worker process is
  running and polling.

### R2 — Identity / Seed Operator
**Goal:** a tenant + API key + project key provisioned so envelopes admit and decrypt.
- Choose fixed secrets for the run: `EC_API_KEY=ec_live_<hex>`, `EC_DEK=<32+ char data encryption
  key>`, `EC_PROJECT_ID=pipeline-project`, `EC_CLERK_ORG=org_pipeline`. The **same `EC_DEK`** is
  used by every app's errorcore bootstrap.
- Run the seed script (template in §7) which derives the `keyId` from `EC_DEK` via the SDK's
  `Encryption`, then upserts `tenants`, `api_keys` (`scopes:["ingest:write"]`), and `project_keys`.
- Reconcile `SUPPORTED_SDK_VERSIONS`: produce one real envelope (R5 first event, or a sample) and
  read its `.sdk.version`. Set the backend's `SUPPORTED_SDK_VERSIONS` to include that exact value.
  **If it differs from the `.env.example` default `0.2.0`, that is a contract-drift finding.**
- **Done-gate:** the backend's own `npm run e2e` (pointed at this stack) prints a readable
  projection — proving admission → worker → projection works before any real app is involved.

### R3 — App Curator & Bug Scout
**Goal:** a target matrix of **8–12 real bugs across 3–4 apps**, each reproducible at a buggy commit.
- Cover this matrix so the report can score every dimension (pick apps/bugs that exercise each):
  - At least one **HTTP framework app** crash on a specific request (exercises D1/D2/D4/D9).
  - At least one **DB-driven** failure (exercises D3/D5; pg/mysql2/mongoose/sequelize, or an app using them).
  - At least one **async / unhandled-rejection** bug (exercises D7).
  - At least one **cross-service** failure: service A calls service B and the hop fails (exercises D8). Two cooperating OSS services, or two instances of one service calling each other.
  - At least one input carrying **secrets/PII** that flows into the failing path (exercises D10).
- Candidate pool (verify reproducibility before committing; substitute freely):
  - Apps/services: `verdaccio`, `n8n`, `directus`, `strapi`, `payloadcms`, `bullmq`, `node-red`,
    or the RealWorld API under `/workspace/ec-master/harness/apps/conduit-api` as a known
    DB+cross-service scaffold.
  - Libraries wrapped in a tiny HTTP/CLI **driver** (the driver is glue, not an app edit):
    `axios`, `node-fetch`, `ws`, `pg`, `mysql2`, `ioredis`, `mongoose`, `sequelize`,
    `fast-xml-parser`, `qs`, `ajv`, `jsonwebtoken`, `sharp`, `csv-parse`, `xlsx`.
- **Git-fix selection algorithm** (this is what makes the errors *natural*):
  1. `git clone` the repo. Find a commit that **fixes a runtime bug and changes a test** (search
     log/PRs for: "fix crash", "throws", "TypeError/RangeError", "unhandled rejection", "null/undefined",
     "regression"). The changed test encodes the triggering input.
  2. `git checkout <fixcommit>^` (the parent — the bug is now live). Install/build at that commit.
  3. **Reproduce WITHOUT errorcore first** (run that regression test, or hit the path) and confirm
     it fails exactly as history says. Record this as **S0 ground truth** (the real stack/behavior).
  4. Keep only bugs that reproduce **deterministically**. Note the fix commit SHA, the parent SHA,
     the file:line of the bug, and the precise trigger.
- **Done-gate:** a committed `harness-pipeline/targets.json` listing each target: repo, fix SHA,
  parent SHA, category, trigger recipe, and confirmed S0 behavior.

### R4 — Instrumentation Operator
**Goal:** each app runs with errorcore attached, **without touching the app's source**.
- Attach via preload only: `NODE_OPTIONS="--require /workspace/harness-pipeline/instrument/errorcore-preload.js"`
  (template in §7). The bootstrap initializes errorcore with the `file` transport →
  `/captures/<service>.ndjson`, sets `encryptionKey=EC_DEK`, and hands the app's own DB drivers to
  errorcore (resolved from the app's `node_modules`, not imported into the app).
- Because you are **not** wiring framework middleware (that would edit the app), some request-context
  enrichment may be reduced. errorcore's `diagnostics_channel` HTTP-server recording still works
  without middleware. **When a dimension is degraded specifically because middleware wasn't wired,
  label it `instrumentation-mode limitation` in the scorecard — distinct from an SDK gap or a
  pipeline gap.** This measures the honest drop-in experience.
- **Done-gate:** each app boots with the preload active and errorcore initialized (confirm via the
  SDK's startup/health signal or `EC_DEBUG=1` internal-warning output); a trivial real request
  produces at least one envelope line in `/captures/<service>.ndjson`.

### R5 — Repro Driver
**Goal:** trigger each target bug as a genuine failure and confirm errorcore captured it.
- For HTTP apps: send the real request that triggers the bug so it surfaces as a 500 / process
  crash. For libraries: run a minimal driver script that calls the buggy API exactly as the
  regression test does and **lets the error propagate to the top** (uncaughtException /
  unhandledRejection — errorcore's core capture paths) rather than swallowing it.
- Prefer triggers that manifest as `uncaughtException`, `unhandledRejection`, or an HTTP 500 — these
  are what errorcore is built to capture. If a bug only manifests as a *caught* exception, either
  enable the SDK's caught-exception capture via config, or use a driver that rethrows to top.
- **Done-gate per event:** a new envelope line appears in `/captures/<service>.ndjson` whose
  decrypted package (use the decoder, §7) is non-empty and corresponds to this bug. Record the
  `eventId`. An event that the SDK failed to capture at all is itself a finding (D11/coverage).

### R6 — Pipeline Verifier
**Goal:** trace every captured event S2 → S3 → S4 (or capture why it stopped).
- The forwarder POSTs each envelope; read `/captures/forwarder.log` for the per-event HTTP status
  (202 ok; 401 auth; 413/422 contract; 429 throttle — each status is evidence).
- For each `eventId`, run the verification SQL (§7) against Postgres:
  - **S2** `ingest_admissions.status='accepted'`.
  - jobs: `ingest_jobs.stage` progression / `attempts`.
  - **S3** `snapshots.status='readable'` + `raw_object_key` exists in MinIO.
  - **S4** `read_projections.mcp_shape` present (joined to a readable snapshot).
  - failures: `ingest_failures` rows (reason/stage). **An event with neither a readable projection
    nor a failure row = silent loss** (record it — this is the F-002 class).
- **Done-gate:** every `eventId` is classified as `readable@S4`, `failed@<stage>` (with reason), or
  `silent-loss`, with the supporting rows captured to `artifacts/`.

### R7 — Fidelity Auditor
**Goal:** fill the scorecard — compare what the SDK captured vs what the consumer can read.
- For each event, decrypt the S1 package (the full error package the SDK produced) and load the S4
  `mcp_shape`. For each dimension D1–D11, compare S0 ↔ S1 ↔ (S3 snapshot) ↔ S4 and assign a status
  per stage.
- Specifically check the known high-risk areas (use the existing audit as a hypothesis list, but
  re-prove against this real traffic — do not copy its conclusions):
  - **D10 / PII (audit F-001):** put a known secret + email + card-like number + phone in the
    triggering input. Confirm whether they appear in plaintext anywhere in S4 `mcp_shape`,
    `searchable_fields`, or the stored snapshot object. Any appearance = `leaked` (High).
  - **Pipeline robustness (audit F-002/F-003):** does any real captured payload crash the worker,
    get left without a failure record, or expand past `MAX_INGEST_BYTES` after decompression?
  - **Event identity (audit F-004/F-005):** is the `eventId` admitted the same one stored in
    `snapshots`/projection? Any divergence = finding.
  - **Contract drift:** inner `schemaVersion` (`1.1.0`/`1.2.0`) and envelope `sdk.version` vs what
    the backend accepts (`SUPPORTED_SDK_VERSIONS`); the spec index says schema `1.1.0` while the
    builder emits `1.2.0` — note any mismatch surfaced by real traffic.
  - **D2 locals / D5 bind params / D3 timeline / D8 trace:** are they present and faithful at S1 but
    **dropped or flattened by S4**? The projection is the product surface — capturing it but not
    exposing it is still a gap against the plan.
- **Done-gate:** a complete per-event scorecard matrix saved to `artifacts/scorecard.json` (and a
  human-readable table), every cell justified by an evidence pointer.

### R8 — Report Compiler
**Goal:** produce the single report (§6). Deduplicate per-event observations into a ranked list of
distinct gaps. **One file. No appendices in separate files** (artifacts are linked, not pasted).

---

## 6. The single deliverable — `/workspace/harness-pipeline/REPORT.md`

Exactly one markdown file, structured like this (mirror the crisp, evidence-first style of the
existing `ingestion-backend-audit.md`):

1. **Verdict (one paragraph).** How far is the end-to-end reality from the errorcore promise? Lead
   with the bottom line.
2. **Plan Conformance Scorecard.** One row per dimension D1–D11 → overall verdict
   (`faithful` / `partial` / `missing` / `leaked`), the worst stage, and the count of events
   affected.
3. **Finding counts.** N High, N Medium, N Low. Then "Top 5 to fix first."
4. **Findings** — the single ranked list. Each finding:
   ```
   P-00X | <title> | <High|Medium|Low> | <capture-fidelity | pipeline-correctness | contract-drift | security-PII | operability>
   Breaks at: <S1|S2|S3|S4>   Dimension(s): <D#...>
   Expected (per plan): <what README/spec promises, with citation e.g. spec/04-pii-scrubbing.md:158>
   Observed: <what actually happened, with evidence: eventIds, forwarder status, SQL rows, decrypted/projection excerpts, object keys>
   Repro: <exact commands to reproduce from /workspace>
   Suspected location: <file:line in product tree, for diagnosis only — NOT edited>
   Fix direction: <one or two sentences>
   ```
5. **What I could not verify / assumptions.** (e.g., Clerk/Polar stubbed, MinIO vs real R2, any bug
   that wouldn't reproduce, native-HTTP-transport experiment result.)
6. **Appendix (inline, at the bottom of the same file):**
   - Per-event scorecard matrix (events × D1–D11).
   - Target table: app, repo URL, fix SHA, parent SHA, category, trigger, S0 behavior.
   - `SUPPORTED_SDK_VERSIONS` reconciliation result (actual envelope `sdk.version`).
   - Environment: image versions, Node version, SDK version, backend version, env vars used.
   - Exact command log to reproduce the whole run.
   - Links to evidence files under `artifacts/`.

Quality bar: direct, no filler, severity-ranked, deduplicated. Every claim carries evidence. If the
pipeline could not run at all, the report explains why with evidence and lists what blocked it.

---

## 7. Reference glue (author these under `harness-pipeline/`; adapt to actual APIs)

> These are starting templates. Confirm exact method names/signatures against the real code
> (`/workspace/ec-master/dist/security/encryption.js`, `/workspace/ingestion-backend/dist/security.js`,
> `/workspace/ec-master/src/ingest/index.ts`) and the existing decoder
> `/workspace/ec-master/harness/collector/decode-captures.mjs`. Do not edit those files — read them.

### 7.1 `docker-compose.backend.yml`
```yaml
name: ec-pipeline
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: errorcore_ingest
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d errorcore_ingest"]
      interval: 2s
      timeout: 2s
      retries: 30
  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
  createbucket:
    image: minio/mc:latest
    depends_on: { minio: { condition: service_started } }
    entrypoint: >
      /bin/sh -c "until mc alias set m http://minio:9000 minioadmin minioadmin; do sleep 1; done;
      mc mb -p m/errorcore-ingest || true; echo bucket-ready"
  api:
    image: node:20-bookworm
    working_dir: /workspace/ingestion-backend
    volumes:
      - ..:/workspace          # repo root (so /workspace/ec-master and /workspace/ingestion-backend resolve)
      - captures:/captures
    environment: &backendenv
      NODE_ENV: production
      HOST: 0.0.0.0            # MUST be 0.0.0.0 inside the container, not 127.0.0.1
      PORT: "4318"
      DATABASE_URL: postgres://postgres:postgres@postgres:5432/errorcore_ingest
      S3_ENDPOINT: http://minio:9000
      S3_REGION: us-east-1
      S3_BUCKET: errorcore-ingest
      S3_ACCESS_KEY_ID: minioadmin
      S3_SECRET_ACCESS_KEY: minioadmin
      CLERK_SECRET_KEY: sk_test_pipeline_placeholder
      CLERK_WEBHOOK_SIGNING_SECRET: whsec_pipeline_placeholder
      POLAR_ACCESS_TOKEN: polar_at_pipeline_placeholder
      POLAR_WEBHOOK_SECRET: whsec_pipeline_placeholder
      KEY_ENCRYPTION_SECRET: pipeline-master-secret-at-least-32-bytes!!
      SUPPORTED_SDK_VERSIONS: "0.2.0"      # reconcile to the real envelope sdk.version (R2)
      MAX_INGEST_BYTES: "1048576"          # leave at default to test F-003-class behavior honestly
      TENANT_RATE_LIMIT_PER_MINUTE: "100000"  # raised so capture fidelity isn't masked by throttling
      WORKER_BATCH_SIZE: "10"
      WORKER_POLL_MS: "500"
      USAGE_FLUSH_MS: "60000"
    command: bash -lc "npm ci && npm run build && npm run migrate && node dist/server.js"
    depends_on:
      postgres: { condition: service_healthy }
      createbucket: { condition: service_completed_successfully }
    ports: ["4318:4318"]
  worker:
    image: node:20-bookworm
    working_dir: /workspace/ingestion-backend
    volumes:
      - ..:/workspace
      - captures:/captures
    environment: *backendenv
    command: bash -lc "until [ -f dist/worker.js ]; do sleep 1; done; node dist/worker.js"
    depends_on: { api: { condition: service_started } }
volumes:
  captures: {}
```
> Note: `npm ci` here resolves `errorcore` from `file:../ec-master`. Ensure `ec-master/dist` exists
> (R1). The default `MAX_INGEST_BYTES` is intentionally left at 1 MiB so you can observe real
> oversize/decompression behavior; raise it only if you want a contrast run, and report both.

### 7.2 `seed.mjs` (run with plain node after `ingestion-backend` is built)
```js
import pg from 'pg';
import { encryptProjectSecret, hashBearerKey } from '/workspace/ingestion-backend/dist/security.js';
import { Encryption } from '/workspace/ec-master/dist/security/encryption.js';
const { Pool } = pg;

const { DATABASE_URL, KEY_ENCRYPTION_SECRET,
        EC_API_KEY, EC_DEK,
        EC_PROJECT_ID = 'pipeline-project', EC_CLERK_ORG = 'org_pipeline' } = process.env;

// keyId is derived from the DEK material; produce a throwaway envelope to read it.
const sample = new Encryption(EC_DEK, { sdkVersion: '0.2.0' })
  .encryptToEnvelope(Buffer.from('{}'), { eventId: 'seed-sample' });
const keyId = sample.keyId;

const pool = new Pool({ connectionString: DATABASE_URL });
const t = await pool.query(
  `INSERT INTO tenants (clerk_org_id, polar_customer_id, plan, usage_limit)
   VALUES ($1,$2,'pro',100000000)
   ON CONFLICT (clerk_org_id) DO UPDATE SET polar_customer_id=EXCLUDED.polar_customer_id
   RETURNING id::text`, [EC_CLERK_ORG, 'cus_' + EC_PROJECT_ID]);
const tenantId = t.rows[0].id;
await pool.query(
  `INSERT INTO api_keys (key_hash, tenant_id, project_id, status, scopes)
   VALUES ($1,$2,$3,'active','["ingest:write"]'::jsonb)
   ON CONFLICT (key_hash) DO UPDATE SET tenant_id=EXCLUDED.tenant_id, project_id=EXCLUDED.project_id, status='active'`,
  [hashBearerKey(EC_API_KEY), tenantId, EC_PROJECT_ID]);
await pool.query(
  `INSERT INTO project_keys (tenant_id, project_id, key_id, encrypted_encryption_key)
   VALUES ($1,$2,$3,$4)
   ON CONFLICT (tenant_id, project_id, key_id) DO UPDATE SET encrypted_encryption_key=EXCLUDED.encrypted_encryption_key`,
  [tenantId, EC_PROJECT_ID, keyId, encryptProjectSecret(EC_DEK, KEY_ENCRYPTION_SECRET)]);
console.log(JSON.stringify({ tenantId, projectId: EC_PROJECT_ID, keyId, apiKey: EC_API_KEY }));
await pool.end();
```
> After the first **real** app envelope exists, verify its `.keyId` equals the seeded `keyId`. If
> not, re-seed `project_keys` for the real `keyId` and note the discrepancy.

### 7.3 `instrument/errorcore-preload.js` (loaded via `NODE_OPTIONS=--require`; never edits the app)
```js
'use strict';
const path = require('path');
const errorcore = require('/workspace/ec-master'); // zero runtime deps; main → dist/index.js

const service = process.env.EC_SERVICE || 'app';
const capturePath = process.env.EC_CAPTURE_PATH || ('/captures/' + service + '.ndjson');
const appRoot = process.env.EC_APP_ROOT || process.cwd();

function resolveDriver(name) {
  try { return require(require.resolve(name, { paths: [path.join(appRoot, 'node_modules')] })); }
  catch { return undefined; }
}
const drivers = {};
for (const d of ['pg', 'mysql2', 'ioredis', 'mongodb']) {
  const m = resolveDriver(d); if (m) drivers[d] = m;
}

errorcore.init({
  service,
  deploymentEnv: 'pipeline-validation',
  transport: { type: 'file', path: capturePath, maxBackups: 50 },
  encryptionKey: process.env.EC_DEK,          // → emit EncryptedEnvelope lines (do NOT set allowUnencrypted)
  captureLocalVariables: true,
  maxCachedLocals: 1000,
  captureDbBindParams: true,
  captureRequestBodies: true,
  captureResponseBodies: true,
  captureBody: true,
  captureBodyDigest: true,
  resolveSourceMaps: true,
  captureMiddlewareStatusCodes: [500],
  traceContext: { vendorKey: 'ec' },
  drivers,
  logLevel: process.env.EC_LOG || 'warn',
  onInternalWarning(w) { if (process.env.EC_DEBUG) console.error('[errorcore warn]', w); }
});
module.exports = errorcore;
```

### 7.4 `forwarder.mjs` (tails NDJSON, POSTs envelopes, logs per-event status)
```js
import fs from 'node:fs';
import readline from 'node:readline';
const INGEST_URL = process.env.INGEST_URL || 'http://api:4318/v1/ingest';
const API_KEY = process.env.EC_API_KEY;
const files = (process.env.CAPTURE_FILES || '').split(',').map(s => s.trim()).filter(Boolean);
const logPath = process.env.FORWARDER_LOG || '/captures/forwarder.log';
const seen = new Set();

async function post(line) {
  let env; try { env = JSON.parse(line); } catch { return; }
  if (!env || env.v !== 1 || typeof env.eventId !== 'string') return;
  if (seen.has(env.eventId)) return;
  seen.add(env.eventId);
  let status = 0, bodyText = '';
  try {
    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + API_KEY, 'content-type': 'application/errorcore+json' },
      body: line
    });
    status = res.status; bodyText = await res.text();
  } catch (e) { bodyText = 'FETCH_ERR ' + e.message; }
  fs.appendFileSync(logPath, JSON.stringify({
    at: new Date().toISOString(), eventId: env.eventId, status,
    sdkVersion: env.sdk && env.sdk.version, keyId: env.keyId, body: bodyText.slice(0, 300)
  }) + '\n');
}
function drain(file) {
  if (!fs.existsSync(file)) return;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  rl.on('line', l => { if (l.trim()) post(l).catch(e => fs.appendFileSync(logPath, 'ERR ' + e.message + '\n')); });
}
setInterval(() => files.forEach(drain), 1500);
console.log('forwarder watching', files, '->', INGEST_URL);
```

### 7.5 App runner pattern (per target; no app source edited)
```bash
# Inside a node:20-bookworm container joined to the ec-pipeline network, with /workspace and the
# captures volume mounted. <repo>, <fixsha> chosen in R3.
git clone <repo-url> /app && cd /app
git checkout <fixsha>^                       # buggy parent commit (NOT an edit)
npm ci                                        # or the repo's documented install/build
# start the app with errorcore preloaded:
EC_SERVICE=<svc> EC_APP_ROOT=/app EC_DEK="$EC_DEK" \
NODE_OPTIONS="--require /workspace/harness-pipeline/instrument/errorcore-preload.js" \
  npm start &                                 # or: node <entrypoint>
# then R5 triggers the real bug (a real request, or a driver that lets the lib error reach top):
#   curl -X <M> http://localhost:<port>/<path-that-really-breaks> -d '<input incl. a known secret/PII>'
#   or: NODE_OPTIONS="--require .../errorcore-preload.js" node /workspace/harness-pipeline/drivers/<svc>.mjs
```

### 7.6 Verification SQL (run per `eventId`; `:t` = tenantId, `:e` = eventId)
```sql
-- S2 admission
SELECT status, created_at FROM ingest_admissions WHERE tenant_id = :t AND event_id = :e;
-- job progression
SELECT id, stage, attempts, next_attempt_at FROM ingest_jobs WHERE tenant_id = :t AND event_id = :e;
-- S3 snapshot
SELECT id, status, service, raw_object_key, privacy_summary FROM snapshots WHERE tenant_id = :t AND event_id = :e;
-- S4 readable projection (what a consumer reads)
SELECT rp.mcp_shape, rp.searchable_fields, rp.trace_id
  FROM read_projections rp JOIN snapshots s ON s.id = rp.snapshot_id
  WHERE s.tenant_id = :t AND s.event_id = :e AND s.status = 'readable';
-- failures (poison / decrypt / oversize)
SELECT stage, reason, created_at FROM ingest_failures WHERE tenant_id = :t AND event_id = :e;
-- silent loss = no readable projection AND no failure row for an admitted event.
```

### 7.7 S1 decode (decrypt the SDK's captured package for fidelity comparison)
Reuse `/workspace/ec-master/harness/collector/decode-captures.mjs` (it already decrypts envelopes).
Point it at `/captures/<service>.ndjson` with `EC_DEK`. If its CLI differs, write a thin
`decrypt.mjs` that imports `Encryption` from `/workspace/ec-master/dist/security/encryption.js`,
`JSON.parse` each line, and calls the SDK's decrypt method (confirm the exact method name in that
module / in `/workspace/ec-master/src/ingest/index.ts`). Output the plaintext error package JSON to
`artifacts/decoded/<service>.ndjson`.

---

## 8. Run order (checklist)

1. R1: build SDK if needed → `docker compose -f harness-pipeline/docker-compose.backend.yml up -d` → health green.
2. R2: choose `EC_API_KEY`/`EC_DEK` → `node harness-pipeline/seed.mjs` → run backend `npm run e2e` → readable projection. Reconcile `SUPPORTED_SDK_VERSIONS` and restart api/worker if changed.
3. R3: select apps + git-fix bugs → confirm S0 repros → write `targets.json`.
4. R4: per app, preload errorcore → boot → first envelope appears.
5. Start the forwarder (`CAPTURE_FILES=/captures/svc1.ndjson,/captures/svc2.ndjson node harness-pipeline/forwarder.mjs`).
6. R5: trigger each bug for real → confirm S1 capture (`eventId`s recorded).
7. R6: classify each `eventId` (readable@S4 / failed@stage / silent-loss) via forwarder.log + SQL.
8. R7: decode S1, load S4, fill the scorecard, probe PII/robustness/identity/contract.
9. Run the native-HTTP-transport experiment once; record the result.
10. R8: write `/workspace/harness-pipeline/REPORT.md`. Save all evidence under `harness-pipeline/artifacts/`.

## 9. Acceptance criteria for THIS run

- Backend `npm run e2e` produced a readable projection on this stack (pipeline proven before real apps).
- ≥ 8 real, git-sourced bugs were reproduced (S0), captured by errorcore (S1), and forwarded (status logged).
- Every captured `eventId` is classified through S2–S4 with evidence (or a recorded failure/silent-loss).
- Every dimension D1–D11 has a verdict in the Plan Conformance Scorecard, justified by evidence.
- Exactly one report exists at `/workspace/harness-pipeline/REPORT.md`, deduplicated and severity-ranked.
- No tracked source file in `ec-master`, `ingestion-backend`, or any OSS repo was modified
  (`git status` clean in each, except OSS repos sitting on the intended buggy commit).

Begin with R1. Work methodically, keep evidence as you go, and produce the one report.
