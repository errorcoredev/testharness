import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_INGEST_URL = 'http://localhost:4318/v1/ingest';

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
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
    follow: false,
    intervalMs: 1000,
    statusPath: process.env.EC_FORWARDER_STATUS_PATH ||
      path.resolve('harness-pipeline', 'artifacts', 'forwarder', 'status.ndjson'),
    paths: []
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--follow') {
      args.follow = true;
    } else if (arg === '--once') {
      args.follow = false;
    } else if (arg === '--interval-ms') {
      args.intervalMs = Number(argv[++i]);
    } else if (arg === '--status') {
      args.statusPath = argv[++i];
    } else {
      args.paths.push(arg);
    }
  }
  if (args.paths.length === 0) {
    args.paths.push(path.resolve('harness-pipeline', 'captures'));
  }
  return args;
}

function appendStatus(statusPath, record) {
  ensureDir(statusPath);
  fs.appendFileSync(statusPath, `${JSON.stringify(record)}\n`);
}

function envelopeSummary(line) {
  const envelope = JSON.parse(line);
  return {
    eventId: envelope.eventId,
    keyId: envelope.keyId,
    sdkVersion: envelope.sdk?.version
  };
}

export async function postEnvelope(line, options) {
  const summary = envelopeSummary(line);
  const response = await fetch(options.ingestUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      'content-type': 'application/errorcore+json',
      'x-errorcore-project-id': options.projectId
    },
    body: line
  });
  const responseBody = await response.text();
  return {
    ...summary,
    ok: response.ok,
    status: response.status,
    responseBody
  };
}

function readNewLines(file, state) {
  const previousOffset = state.get(file) ?? 0;
  if (!fs.existsSync(file)) {
    return [];
  }
  const stat = fs.statSync(file);
  const offset = stat.size < previousOffset ? 0 : previousOffset;
  if (stat.size === offset) {
    return [];
  }
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - offset);
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    state.set(file, stat.size);
    return buffer.toString('utf8').split(/\r?\n/).filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

async function forwardOnce(args, offsets, options) {
  const files = args.paths.flatMap(listCaptureFiles);
  let count = 0;
  for (const file of files) {
    const lines = readNewLines(file, offsets);
    for (const line of lines) {
      count += 1;
      const startedAt = new Date().toISOString();
      try {
        const result = await postEnvelope(line, options);
        appendStatus(args.statusPath, { file, startedAt, completedAt: new Date().toISOString(), ...result });
      } catch (error) {
        let summary = {};
        try {
          summary = envelopeSummary(line);
        } catch {
        }
        appendStatus(args.statusPath, {
          file,
          startedAt,
          completedAt: new Date().toISOString(),
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          ...summary
        });
      }
    }
  }
  return count;
}

export async function runForwarder(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const apiKey = env.EC_API_KEY ?? 'ec_live_pipeline_20260604_deadbeef';
  const projectId = env.EC_PROJECT_ID ?? 'pipeline-project';
  const ingestUrl = env.EC_INGEST_URL ?? DEFAULT_INGEST_URL;
  const offsets = new Map();
  let stopping = false;
  process.once('SIGINT', () => {
    stopping = true;
  });
  process.once('SIGTERM', () => {
    stopping = true;
  });

  do {
    await forwardOnce(args, offsets, { apiKey, projectId, ingestUrl });
    if (!args.follow || stopping) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, args.intervalMs));
  } while (!stopping);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runForwarder().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
