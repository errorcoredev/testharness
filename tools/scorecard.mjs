import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const harnessDir = path.resolve(toolDir, '..');

const DIMENSIONS = [
  { id: 'D1', name: 'error identity', s1: ['error.type', 'error.message'], s3: ['error.type', 'error.message'], s4: ['error.type', 'error.message'] },
  { id: 'D2', name: 'stack trace', s1: ['error.stack'], s3: ['error.stack'], s4: ['error.stack'] },
  { id: 'D3', name: 'request metadata', s1: ['request.method', 'request.url'], s3: ['request.method', 'request.url'], s4: ['request.method', 'request.url'] },
  { id: 'D4', name: 'request body', s1: ['request.body'], s3: ['request.body'], s4: ['request.body'] },
  { id: 'D5', name: 'I/O timeline', s1: ['ioTimeline'], s3: ['ioTimeline'], s4: ['ioTimeline'] },
  { id: 'D6', name: 'database details', s1: ['ioTimeline[].dbMeta'], s3: ['ioTimeline[].dbMeta'], s4: ['ioTimeline[].dbMeta'] },
  { id: 'D7', name: 'state reads/writes', s1: ['stateReads', 'stateWrites'], s3: ['stateReads', 'stateWrites'], s4: ['stateReads', 'stateWrites'] },
  { id: 'D8', name: 'local variables', s1: ['localVariables'], s3: ['localVariables'], s4: ['localVariables'] },
  { id: 'D9', name: 'trace context', s1: ['trace.traceId'], s3: ['trace.traceId'], s4: ['trace.traceId'] },
  { id: 'D10', name: 'process/source metadata', s1: ['processMetadata'], s3: ['processMetadata'], s4: ['processMetadata'] },
  { id: 'D11', name: 'privacy redaction summary', s1: ['completeness.piiScrubbed'], s3: ['privacySummary'], s4: ['privacy.redactedFieldCount'] }
];

function readJson(file, fallback) {
  if (!fs.existsSync(file)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function getPath(value, dotted) {
  const parts = dotted.split('.');
  let current = value;
  for (const part of parts) {
    if (current === undefined || current === null) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function hasArrayDbMeta(value) {
  return Array.isArray(value?.ioTimeline) && value.ioTimeline.some((item) => item?.dbMeta !== undefined);
}

function present(value, probes) {
  for (const probe of probes) {
    if (probe === 'ioTimeline[].dbMeta') {
      if (hasArrayDbMeta(value)) {
        return true;
      }
      continue;
    }
    const found = getPath(value, probe);
    if (Array.isArray(found) && found.length > 0) {
      return true;
    }
    if (found !== undefined && found !== null && found !== '') {
      return true;
    }
  }
  return false;
}

function expectedDimensions(targets, eventId) {
  const target = targets.targets?.find((item) => item.eventId === eventId);
  if (Array.isArray(target?.expectedDimensions) && target.expectedDimensions.length > 0) {
    return new Set(target.expectedDimensions);
  }
  return new Set(DIMENSIONS.map((dimension) => dimension.id));
}

function readDecoded(decodedDir) {
  const index = readJson(path.join(decodedDir, 'index.json'), []);
  return index.map((row) => {
    const file = path.join(decodedDir, `${row.eventId}.json`);
    return {
      summary: row,
      decoded: readJson(file, null)
    };
  }).filter((row) => row.decoded !== null);
}

function projectionFor(artifactsDir, eventId) {
  const rows = readJson(path.join(artifactsDir, 'projections', `${eventId}.json`), []);
  return rows[0]?.mcp_shape ?? {};
}

function snapshotFor(artifactsDir, eventId) {
  return readJson(path.join(artifactsDir, 'snapshots', `${eventId}.json`), {});
}

function sqlFor(artifactsDir, eventId) {
  return readJson(path.join(artifactsDir, 'sql', `${eventId}.json`), {});
}

export function scoreEvent(input) {
  const expected = expectedDimensions(input.targets, input.eventId);
  const rows = [];
  for (const dimension of DIMENSIONS) {
    if (!expected.has(dimension.id)) {
      rows.push({
        id: dimension.id,
        name: dimension.name,
        expected: false,
        s1: 'not_expected',
        s3: 'not_expected',
        s4: 'not_expected',
        verdict: 'not_expected'
      });
      continue;
    }
    const s1 = present(input.s1, dimension.s1);
    const s3 = present(input.s3, dimension.s3);
    const s4 = present(input.s4, dimension.s4);
    rows.push({
      id: dimension.id,
      name: dimension.name,
      expected: true,
      s1: s1 ? 'present' : 'missing',
      s3: s3 ? 'present' : s1 ? 'lost_after_S1' : 'missing',
      s4: s4 ? 'present' : s3 ? 'projection_gap' : s1 ? 'lost_before_projection' : 'missing',
      verdict: s4 ? 'pass' : s1 ? 'exposure_or_pipeline_gap' : 'capture_gap'
    });
  }
  return rows;
}

export function buildScorecard(artifactsDir = path.join(harnessDir, 'artifacts')) {
  const targets = readJson(path.join(harnessDir, 'targets.json'), { targets: [] });
  const decoded = readDecoded(path.join(artifactsDir, 'decoded'));
  return {
    generatedAt: new Date().toISOString(),
    dimensions: DIMENSIONS.map(({ id, name }) => ({ id, name })),
    events: decoded.map((row) => {
      const eventId = row.summary.eventId;
      const sql = sqlFor(artifactsDir, eventId);
      const s1 = row.decoded.package;
      const s3 = snapshotFor(artifactsDir, eventId);
      const s4 = projectionFor(artifactsDir, eventId);
      return {
        eventId,
        service: row.summary.service,
        errorType: row.summary.errorType,
        errorMessage: row.summary.errorMessage,
        classification: sql.classification ?? 'unknown',
        dimensions: scoreEvent({ eventId, targets, s1, s3, s4 })
      };
    })
  };
}

export function runScorecard(argv = process.argv.slice(2)) {
  let artifactsDir = path.join(harnessDir, 'artifacts');
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--artifacts') {
      artifactsDir = argv[++i];
    }
  }
  const card = buildScorecard(artifactsDir);
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.writeFileSync(path.join(artifactsDir, 'scorecard.json'), `${JSON.stringify(card, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, events: card.events.length, out: path.join(artifactsDir, 'scorecard.json') }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runScorecard();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
