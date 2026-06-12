import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const harnessDir = path.resolve(toolDir, '..');
const workspaceRoot = path.resolve(harnessDir, '..');

export function normalizeDek(value) {
  if (/^[0-9a-f]{64}$/i.test(value)) {
    return value.toLowerCase();
  }
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function loadEncryption() {
  const modulePath = path.join(workspaceRoot, 'ec-master', 'dist', 'security', 'encryption.js');
  const mod = await import(pathToFileURL(modulePath).href);
  return mod.Encryption ?? mod.default?.Encryption;
}

function listCaptureFiles(inputPath) {
  if (!fs.existsSync(inputPath)) {
    return [];
  }
  const stat = fs.statSync(inputPath);
  if (stat.isFile()) {
    return inputPath.endsWith('.ndjson') ? [inputPath] : [];
  }
  const files = [];
  for (const entry of fs.readdirSync(inputPath, { withFileTypes: true })) {
    const full = path.join(inputPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listCaptureFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ndjson')) {
      files.push(full);
    }
  }
  return files.sort();
}

function parseArgs(argv) {
  const args = {
    outDir: path.join(harnessDir, 'artifacts', 'decoded'),
    paths: [],
    selfTest: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      args.outDir = argv[++i];
    } else if (arg === '--self-test') {
      args.selfTest = true;
    } else {
      args.paths.push(arg);
    }
  }
  if (args.paths.length === 0) {
    args.paths.push(path.join(harnessDir, 'captures'));
  }
  return args;
}

function safeFileName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
}

export async function decryptEnvelope(envelope, encryptionKey) {
  const Encryption = await loadEncryption();
  if (typeof Encryption !== 'function') {
    throw new Error('SDK Encryption helper could not be loaded');
  }
  const sdkVersion = envelope.sdk?.version ?? 'unknown';
  const encryption = new Encryption(encryptionKey, { sdkVersion });
  const result = encryption.decryptEnvelope(envelope);
  if (!result.ok) {
    throw new Error('decryptEnvelope returned ok=false');
  }
  return {
    plaintext: result.plaintext,
    keyIndex: result.keyIndex,
    sdkVersion,
    keyId: envelope.keyId,
    eventId: envelope.eventId
  };
}

export async function decryptCaptureFile(file, options) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const decoded = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const envelope = JSON.parse(line);
    const result = await decryptEnvelope(envelope, options.encryptionKey);
    const packageObject = JSON.parse(result.plaintext);
    decoded.push({
      file,
      line: index + 1,
      envelope: {
        eventId: result.eventId,
        keyId: result.keyId,
        sdkVersion: result.sdkVersion,
        producedAt: envelope.producedAt,
        compressed: envelope.compressed
      },
      keyIndex: result.keyIndex,
      package: packageObject
    });
  }
  return decoded;
}

export async function decryptCaptures(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.selfTest) {
    await selfTest();
    return [];
  }
  const originalDek = env.EC_DEK ?? 'pipeline-data-encryption-key-32-bytes-minimum-20260604';
  const encryptionKey = normalizeDek(originalDek);
  const files = args.paths.flatMap(listCaptureFiles);
  fs.mkdirSync(args.outDir, { recursive: true });

  const all = [];
  for (const file of files) {
    all.push(...await decryptCaptureFile(file, { encryptionKey }));
  }
  for (const item of all) {
    const eventId = item.envelope.eventId ?? item.package.eventId ?? `${safeFileName(path.basename(item.file))}-${item.line}`;
    fs.writeFileSync(
      path.join(args.outDir, `${safeFileName(eventId)}.json`),
      `${JSON.stringify(item, null, 2)}\n`
    );
  }
  const summary = all.map((item) => ({
    file: item.file,
    line: item.line,
    eventId: item.envelope.eventId,
    keyId: item.envelope.keyId,
    sdkVersion: item.envelope.sdkVersion,
    service: item.package.service,
    errorType: item.package.error?.type,
    errorMessage: item.package.error?.message
  }));
  fs.writeFileSync(path.join(args.outDir, 'index.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, files: files.length, decoded: all.length, outDir: args.outDir }, null, 2));
  return all;
}

async function selfTest() {
  const Encryption = await loadEncryption();
  const key = normalizeDek('pipeline-data-encryption-key-32-bytes-minimum-20260604');
  const eventId = `evt-${randomUUID()}`;
  const encryption = new Encryption(key, { sdkVersion: '0.2.0' });
  const payload = {
    schemaVersion: '1.2.0',
    eventId,
    service: 'decrypt-self-test',
    capturedAt: new Date().toISOString(),
    error: { type: 'Error', message: 'self-test', stack: 'Error: self-test' },
    ioTimeline: [],
    stateReads: [],
    stateWrites: []
  };
  const envelope = encryption.encryptToEnvelope(Buffer.from(JSON.stringify(payload)), { eventId });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-decrypt-'));
  const file = path.join(tmp, 'capture.ndjson');
  fs.writeFileSync(file, `${JSON.stringify(envelope)}\n`);
  const decoded = await decryptCaptureFile(file, { encryptionKey: key });
  if (decoded[0]?.package?.eventId !== eventId) {
    throw new Error('self-test failed to round-trip eventId');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(JSON.stringify({ ok: true, eventId, keyId: envelope.keyId }));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  decryptCaptures().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
