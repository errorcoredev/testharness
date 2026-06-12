import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const harnessDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(harnessDir, '..');
const backendDir = path.join(workspaceRoot, 'ingestion-backend');
const sdkDir = path.join(workspaceRoot, 'ec-master');
const backendRequire = createRequire(path.join(backendDir, 'package.json'));
const { Pool } = backendRequire('pg');

function requiredEnv(env, name) {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function normalizeDek(value) {
  if (/^[0-9a-f]{64}$/i.test(value)) {
    return value.toLowerCase();
  }
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function importModule(file) {
  return import(pathToFileURL(file).href);
}

async function loadBackendSecurity() {
  const modulePath = path.join(backendDir, 'dist', 'src', 'security.js');
  const mod = await importModule(modulePath);
  return {
    hashBearerKey: mod.hashBearerKey ?? mod.default?.hashBearerKey,
    encryptProjectSecret: mod.encryptProjectSecret ?? mod.default?.encryptProjectSecret
  };
}

async function loadSdkEncryption() {
  const modulePath = path.join(sdkDir, 'dist', 'security', 'encryption.js');
  const mod = await importModule(modulePath);
  return mod.Encryption ?? mod.default?.Encryption;
}

export async function seedPipeline(input = process.env) {
  const databaseUrl = requiredEnv(input, 'DATABASE_URL');
  const apiKey = input.EC_API_KEY ?? 'ec_live_pipeline_20260604_deadbeef';
  const projectId = input.EC_PROJECT_ID ?? 'pipeline-project';
  const clerkOrgId = input.EC_CLERK_ORG ?? 'org_pipeline';
  const masterSecret = input.KEY_ENCRYPTION_SECRET ?? 'pipeline-master-secret-at-least-32-bytes!!';
  const sdkVersion = (input.SUPPORTED_SDK_VERSIONS ?? '0.2.0').split(',')[0].trim() || '0.2.0';
  const originalDek = input.EC_DEK ?? 'pipeline-data-encryption-key-32-bytes-minimum-20260604';
  const encryptionKey = normalizeDek(originalDek);
  const { hashBearerKey, encryptProjectSecret } = await loadBackendSecurity();
  const Encryption = await loadSdkEncryption();
  if (typeof hashBearerKey !== 'function' || typeof encryptProjectSecret !== 'function') {
    throw new Error('backend security helpers could not be loaded from dist/src/security.js');
  }
  if (typeof Encryption !== 'function') {
    throw new Error('SDK Encryption helper could not be loaded from ec-master/dist/security/encryption.js');
  }

  const keyId = new Encryption(encryptionKey, { sdkVersion }).primaryKeyId;
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const tenant = await pool.query(`
      INSERT INTO tenants (clerk_org_id, polar_customer_id, plan, usage_limit, throttled)
      VALUES ($1, $2, 'pipeline', 1000000, false)
      ON CONFLICT (clerk_org_id)
      DO UPDATE SET
        polar_customer_id = EXCLUDED.polar_customer_id,
        plan = EXCLUDED.plan,
        usage_limit = EXCLUDED.usage_limit,
        throttled = false
      RETURNING id::text
    `, [clerkOrgId, 'cus_pipeline']);
    const tenantId = tenant.rows[0].id;

    await pool.query(`
      INSERT INTO api_keys (key_hash, tenant_id, project_id, status, scopes, expires_at)
      VALUES ($1, $2, $3, 'active', '["ingest:write"]'::jsonb, NULL)
      ON CONFLICT (key_hash)
      DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id,
        project_id = EXCLUDED.project_id,
        status = 'active',
        scopes = EXCLUDED.scopes,
        expires_at = NULL
    `, [hashBearerKey(apiKey), tenantId, projectId]);

    await pool.query(`
      INSERT INTO project_keys (
        tenant_id, project_id, key_id, encrypted_encryption_key, encrypted_mac_key,
        encrypted_previous_keys, status
      )
      VALUES ($1, $2, $3, $4, NULL, '[]'::jsonb, 'active')
      ON CONFLICT (tenant_id, project_id, key_id)
      DO UPDATE SET
        encrypted_encryption_key = EXCLUDED.encrypted_encryption_key,
        encrypted_mac_key = NULL,
        encrypted_previous_keys = '[]'::jsonb,
        status = 'active'
    `, [
      tenantId,
      projectId,
      keyId,
      encryptProjectSecret(encryptionKey, masterSecret)
    ]);

    return {
      ok: true,
      tenantId,
      projectId,
      clerkOrgId,
      apiKeyHash: hashBearerKey(apiKey),
      keyId,
      sdkVersion,
      ecDekWasHex: encryptionKey === originalDek,
      normalizedDekSha256: encryptionKey
    };
  } finally {
    await pool.end();
  }
}

function loadEnv(name, fallback) {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? fallback : value;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.env.DATABASE_URL = loadEnv(
    'DATABASE_URL',
    'postgres://postgres:postgres@localhost:55432/errorcore_ingest'
  );
  seedPipeline()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
