import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const harnessDir = path.resolve(toolDir, '..');
const workspaceRoot = path.resolve(harnessDir, '..');
const backendDir = path.join(workspaceRoot, 'ingestion-backend');
const backendRequire = createRequire(path.join(backendDir, 'package.json'));
const { Pool } = backendRequire('pg');
const { S3Client, HeadObjectCommand, GetObjectCommand } = backendRequire('@aws-sdk/client-s3');

function parseArgs(argv) {
  const args = {
    outDir: path.join(harnessDir, 'artifacts'),
    eventIds: []
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      args.outDir = argv[++i];
    } else {
      args.eventIds.push(arg);
    }
  }
  return args;
}

function defaultEnv(name, fallback) {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? fallback : value;
}

function replacer(_key, value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Buffer.isBuffer(value)) {
    return { type: 'Buffer', length: value.length };
  }
  return value;
}

async function bodyToBuffer(body) {
  if (body === undefined || body === null) {
    return Buffer.alloc(0);
  }
  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function readEventIdsFromArtifacts(outDir) {
  const decodedIndex = path.join(outDir, 'decoded', 'index.json');
  if (!fs.existsSync(decodedIndex)) {
    return [];
  }
  const rows = JSON.parse(fs.readFileSync(decodedIndex, 'utf8'));
  return [...new Set(rows.map((row) => row.eventId).filter(Boolean))];
}

async function queryJson(pool, sql, params) {
  const result = await pool.query(sql, params);
  return result.rows;
}

function createS3Client(env) {
  return new S3Client({
    endpoint: env.S3_ENDPOINT ?? 'http://localhost:9000',
    region: env.S3_REGION ?? 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID ?? 'minioadmin',
      secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? 'minioadmin'
    }
  });
}

async function fetchObject(client, bucket, key) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await bodyToBuffer(object.Body);
    return {
      key,
      exists: true,
      size: body.length,
      contentType: object.ContentType,
      json: object.ContentType === 'application/json' || key.endsWith('.json')
        ? JSON.parse(body.toString('utf8'))
        : undefined
    };
  } catch (error) {
    return {
      key,
      exists: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function verifyEvent(eventId, env = process.env) {
  const databaseUrl = defaultEnv('DATABASE_URL', 'postgres://postgres:postgres@localhost:55432/errorcore_ingest');
  const bucket = env.S3_BUCKET ?? 'errorcore-pipeline';
  const pool = new Pool({ connectionString: databaseUrl });
  const s3 = createS3Client(env);
  try {
    const admissions = await queryJson(pool, `
      SELECT tenant_id::text, event_id, status, created_at
      FROM ingest_admissions
      WHERE event_id = $1
      ORDER BY created_at
    `, [eventId]);
    const jobs = await queryJson(pool, `
      SELECT id::text, tenant_id::text, project_id, event_id, stage, attempts,
        locked_at, next_attempt_at, created_at, envelope IS NOT NULL AS envelope_present
      FROM ingest_jobs
      WHERE event_id = $1
      ORDER BY id
    `, [eventId]);
    const snapshots = await queryJson(pool, `
      SELECT id::text, tenant_id::text, event_id, case_id::text, status, error_meta,
        trace, service, raw_object_key, privacy_summary, created_at
      FROM snapshots
      WHERE event_id = $1
      ORDER BY created_at
    `, [eventId]);
    const snapshotIds = snapshots.map((row) => row.id);
    const projections = snapshotIds.length === 0 ? [] : await queryJson(pool, `
      SELECT snapshot_id::text, tenant_id::text, case_id::text, searchable_fields,
        mcp_shape, occurred_at, trace_id
      FROM read_projections
      WHERE snapshot_id = ANY($1::uuid[])
      ORDER BY occurred_at
    `, [snapshotIds]);
    const failures = await queryJson(pool, `
      SELECT id::text, tenant_id::text, event_id, stage, reason, raw_object_key, created_at
      FROM ingest_failures
      WHERE event_id = $1
      ORDER BY created_at
    `, [eventId]);
    const payloadBlobs = snapshotIds.length === 0 ? [] : await queryJson(pool, `
      SELECT id::text, snapshot_id::text, kind, object_key, size_bytes
      FROM payload_blobs
      WHERE snapshot_id = ANY($1::uuid[])
      ORDER BY id
    `, [snapshotIds]);

    const objectKeys = new Set();
    for (const snapshot of snapshots) {
      objectKeys.add(snapshot.raw_object_key);
      objectKeys.add(`snapshot/${snapshot.tenant_id}/${snapshot.event_id}.json`);
    }
    for (const failure of failures) {
      if (failure.raw_object_key) {
        objectKeys.add(failure.raw_object_key);
      }
    }
    for (const blob of payloadBlobs) {
      objectKeys.add(blob.object_key);
    }
    const objects = [];
    for (const key of [...objectKeys].filter(Boolean)) {
      objects.push(await fetchObject(s3, bucket, key));
    }

    return {
      eventId,
      admissions,
      jobs,
      snapshots,
      projections,
      failures,
      payloadBlobs,
      objects,
      classification: projections.length > 0
        ? 'readable@S4'
        : failures.length > 0
          ? `failed@${failures[0].stage}`
          : admissions.length > 0 || jobs.length > 0 || snapshots.length > 0
            ? 'silent-loss'
            : 'not-admitted'
    };
  } finally {
    await pool.end();
  }
}

export async function runVerify(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const eventIds = args.eventIds.length > 0 ? args.eventIds : readEventIdsFromArtifacts(args.outDir);
  if (eventIds.length === 0) {
    throw new Error('no event IDs supplied and artifacts/decoded/index.json is missing or empty');
  }
  const sqlDir = path.join(args.outDir, 'sql');
  const projectionsDir = path.join(args.outDir, 'projections');
  const minioDir = path.join(args.outDir, 'minio');
  const snapshotsDir = path.join(args.outDir, 'snapshots');
  fs.mkdirSync(sqlDir, { recursive: true });
  fs.mkdirSync(projectionsDir, { recursive: true });
  fs.mkdirSync(minioDir, { recursive: true });
  fs.mkdirSync(snapshotsDir, { recursive: true });

  const results = [];
  for (const eventId of eventIds) {
    const result = await verifyEvent(eventId);
    results.push(result);
    fs.writeFileSync(path.join(sqlDir, `${eventId}.json`), `${JSON.stringify({
      eventId,
      admissions: result.admissions,
      jobs: result.jobs,
      snapshots: result.snapshots,
      failures: result.failures,
      payloadBlobs: result.payloadBlobs,
      classification: result.classification
    }, replacer, 2)}\n`);
    fs.writeFileSync(path.join(projectionsDir, `${eventId}.json`), `${JSON.stringify(result.projections, replacer, 2)}\n`);
    fs.writeFileSync(path.join(minioDir, `${eventId}.json`), `${JSON.stringify(result.objects, replacer, 2)}\n`);
    for (const object of result.objects) {
      if (object.key?.startsWith('snapshot/') && object.json !== undefined) {
        fs.writeFileSync(path.join(snapshotsDir, `${eventId}.json`), `${JSON.stringify(object.json, null, 2)}\n`);
      }
    }
  }
  fs.writeFileSync(path.join(args.outDir, 'verify-events.json'), `${JSON.stringify(results, replacer, 2)}\n`);
  console.log(JSON.stringify({
    ok: true,
    events: results.length,
    classifications: Object.fromEntries(results.map((row) => [row.eventId, row.classification]))
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runVerify().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
