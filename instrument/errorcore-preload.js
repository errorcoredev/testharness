const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const INIT_FLAG = Symbol.for('errorcore.pipelinePreload.initialized');

function normalizeDek(value) {
  if (/^[0-9a-f]{64}$/i.test(value)) {
    return value.toLowerCase();
  }
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function appRequire() {
  const packageJson = path.join(process.cwd(), 'package.json');
  return Module.createRequire(fs.existsSync(packageJson) ? packageJson : __filename);
}

function optionalRequire(requireFromApp, specifier) {
  try {
    return requireFromApp(specifier);
  } catch {
    return undefined;
  }
}

function loadErrorcore(requireFromApp) {
  try {
    return requireFromApp('errorcore');
  } catch {
    const workspace = process.env.EC_WORKSPACE_ROOT || '/workspace';
    const fallback = path.join(workspace, 'ec-master', 'dist', 'index.js');
    return require(fallback);
  }
}

function packageServiceName() {
  try {
    const pkg = require(path.join(process.cwd(), 'package.json'));
    if (typeof pkg.name === 'string' && pkg.name.length > 0) {
      return pkg.name.replace(/^@[^/]+\//, '');
    }
  } catch {
  }
  return path.basename(process.cwd()) || 'pipeline-service';
}

function capturePath(service) {
  const configured = process.env.EC_CAPTURE_PATH || process.env.ERRORCORE_CAPTURE_PATH;
  if (configured && configured.length > 0) {
    return configured;
  }
  return path.join('/captures', `${service}.ndjson`);
}

function init() {
  if (globalThis[INIT_FLAG] === true || process.env.EC_DISABLED === 'true') {
    return;
  }
  globalThis[INIT_FLAG] = true;

  const requireFromApp = appRequire();
  const errorcore = loadErrorcore(requireFromApp);
  const service = process.env.EC_SERVICE || process.env.OTEL_SERVICE_NAME || packageServiceName();
  const filePath = capturePath(service);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const dek = normalizeDek(
    process.env.EC_DEK ||
    process.env.ERRORCORE_DEK ||
    'pipeline-data-encryption-key-32-bytes-minimum-20260604'
  );

  errorcore.init({
    service,
    deploymentEnv: process.env.ERRORCORE_ENVIRONMENT || 'pipeline-validation',
    transport: {
      type: 'file',
      path: filePath,
      maxBackups: 20
    },
    encryptionKey: dek,
    allowUnencrypted: false,
    captureLocalVariables: true,
    maxCachedLocals: 1000,
    maxLocalsCollectionsPerSecond: 200,
    captureDbBindParams: true,
    captureRequestBodies: true,
    captureResponseBodies: true,
    captureBody: true,
    captureBodyDigest: true,
    captureMiddlewareStatusCodes: 'all',
    uncaughtExceptionExitDelayMs: Number(process.env.EC_UNCAUGHT_EXIT_DELAY_MS || 3000),
    resolveSourceMaps: true,
    sourceMapSyncThresholdBytes: 104857600,
    useWorkerAssembly: false,
    serverless: process.env.EC_PRELOAD_SERVERLESS === 'true',
    traceContext: {
      vendorKey: process.env.ERRORCORE_TRACE_VENDOR_KEY || 'ec'
    },
    stateTracking: {
      captureWrites: true,
      maxWritesPerContext: 200
    },
    drivers: {
      pg: optionalRequire(requireFromApp, 'pg'),
      mysql2: optionalRequire(requireFromApp, 'mysql2'),
      mongodb: optionalRequire(requireFromApp, 'mongodb'),
      ioredis: optionalRequire(requireFromApp, 'ioredis')
    },
    logLevel: process.env.ERRORCORE_LOG_LEVEL || 'warn',
    onInternalWarning(warning) {
      if (process.env.EC_PRELOAD_DEBUG === 'true') {
        console.error('[errorcore preload warning]', warning);
      }
    }
  });

  if (process.env.EC_PRELOAD_DEBUG === 'true') {
    console.error(`[errorcore preload] service=${service} capture=${filePath}`);
  }
}

try {
  init();
} catch (error) {
  console.error('[errorcore preload] failed to initialize');
  console.error(error && error.stack ? error.stack : String(error));
  if (process.env.EC_PRELOAD_STRICT === 'true') {
    throw error;
  }
}
