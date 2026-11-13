#!/usr/bin/env node
// Asserts that the installed Maestro CLI reports the version this oracle pins, and keeps the
// probe's exit status, stdout and stderr as the failure evidence (#4455).
//
// The workflow step this replaced parsed the version inside a shell pipeline that sent the CLI's
// stderr to /dev/null and masked the pipeline's exit with `|| true`. Its whole failure record was
// `expected=<pin> actual=`, which cannot tell apart the causes that need different fixes: the CLI
// never started, it started and printed nothing parseable, or a genuinely different Maestro is
// installed. The invariant stays strict — anything other than the pinned version fails the step —
// because a differential against an unproven CLI proves nothing about pinned behavior. What was
// missing is the cause, which is what this reports.
//
// A script rather than `run:` shell because retained evidence has to be bounded: a JVM startup
// failure prints a stack trace, and a step log is not the place to dump one unbounded. Each stream
// keeps its last MAX_DIAGNOSTIC_BYTES. Version matching consumes the full stream separately, so
// truncating diagnostics cannot change which version is checked.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Per stream: how much of the probe's output the run retains and prints. */
export const MAX_DIAGNOSTIC_BYTES = 8192;

/** Every verdict the probe can reach. Only `match` lets the differential proceed. */
const PROBE_OUTCOMES = Object.freeze({
  match: 'match',
  commandFailed: 'command-failed',
  missingVersion: 'missing-version',
  unparseableVersion: 'unparseable-version',
  versionMismatch: 'version-mismatch',
});

/** Reads the pin layers 1-2 use, so the two cannot drift apart. */
export function readPinnedVersion() {
  const { version } = JSON.parse(fs.readFileSync(path.join(HERE, 'pinned-upstream.json'), 'utf8'));
  if (typeof version !== 'string' || version === '') {
    throw new Error(`pinned-upstream.json declares no version to check the Maestro CLI against`);
  }
  return version;
}

/** The last semver in `output`, with oversized versions represented by a bounded failure marker. */
export function parseVersion(output) {
  const capture = createVersionCapture();
  capture.append(output);
  return capture.read();
}

const VERSION_STATES = {
  search: { digit: 'major' },
  major: { digit: 'major', dot: 'major-dot' },
  'major-dot': { digit: 'minor' },
  minor: { digit: 'minor', dot: 'minor-dot' },
  'minor-dot': { digit: 'patch' },
  patch: { digit: 'patch' },
};

function versionCharacterKind(byte) {
  if (byte >= 48 && byte <= 57) return 'digit';
  if (byte === 46) return 'dot';
  return 'other';
}

function createVersionCapture() {
  let state = 'search';
  let candidate = '';
  let oversized = false;
  let lastVersion = null;
  const currentVersion = () =>
    oversized ? `(version exceeds ${MAX_DIAGNOSTIC_BYTES} bytes)` : candidate;
  const retain = (character) => {
    if (candidate.length < MAX_DIAGNOSTIC_BYTES) candidate += character;
    else oversized = true;
  };
  return {
    append(output) {
      for (const byte of Buffer.isBuffer(output) ? output : Buffer.from(output)) {
        const nextState = VERSION_STATES[state][versionCharacterKind(byte)];
        if (nextState !== undefined) {
          state = nextState;
          retain(String.fromCharCode(byte));
          continue;
        }
        if (state === 'patch') lastVersion = currentVersion();
        state = 'search';
        candidate = '';
        oversized = false;
      }
    },
    read() {
      return state === 'patch' ? currentVersion() : lastVersion;
    },
  };
}

/**
 * Runs the version probe and records what it did rather than what a pipeline survived: exit status,
 * terminating signal, a spawn failure's code, and both output streams.
 */
function probeVersion({ command, args = ['--version'], env = process.env }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = boundedCapture();
    const stderr = boundedCapture();
    const version = createVersionCapture();
    child.stdout.on('data', (chunk) => {
      stdout.append(chunk);
      version.append(chunk);
    });
    child.stderr.on('data', (chunk) => stderr.append(chunk));

    let settled = false;
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      resolve({
        command,
        args,
        spawnErrorCode: undefined,
        exitCode,
        signal,
        version: version.read(),
        stdout: stdout.read(),
        stderr: stderr.read(),
      });
    });
    // A failed spawn (an absent or non-executable `maestro`) reports here and never closes.
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      resolve({
        command,
        args,
        spawnErrorCode: error?.code,
        exitCode: null,
        signal: null,
        version: version.read(),
        stdout: stdout.read(),
        stderr: stderr.read(),
      });
    });
  });
}

/**
 * Decides the step's verdict. A probe that did not complete cleanly is never accepted on the
 * strength of its stdout: a CLI that prints the pinned version and still exits nonzero is a CLI
 * whose behavior the differential cannot trust.
 */
export function evaluateVersionProbe(probe, expected) {
  const version = probe.version;
  const outcome = probeOutcome(probe, version, expected);
  return { outcome, version, report: reportFor(probe, { outcome, version, expected }) };
}

function probeOutcome(probe, version, expected) {
  if (probe.spawnErrorCode !== undefined || probe.signal !== null || probe.exitCode !== 0) {
    return PROBE_OUTCOMES.commandFailed;
  }
  if (version !== null) {
    return version === expected ? PROBE_OUTCOMES.match : PROBE_OUTCOMES.versionMismatch;
  }
  return probe.stdout.value === ''
    ? PROBE_OUTCOMES.missingVersion
    : PROBE_OUTCOMES.unparseableVersion;
}

const OUTCOME_EXPLANATION = {
  [PROBE_OUTCOMES.commandFailed]: 'did not complete successfully',
  [PROBE_OUTCOMES.missingVersion]: 'printed no stdout at all',
  [PROBE_OUTCOMES.unparseableVersion]: 'printed no version-shaped text',
  [PROBE_OUTCOMES.versionMismatch]: 'reports a different Maestro version',
  [PROBE_OUTCOMES.match]: 'reports the pinned version',
};

function reportFor(probe, { outcome, version, expected }) {
  const facts = [
    `expected=${expected} actual=${version ?? ''}`,
    `probe=${probe.command} ${probe.args.join(' ')}` +
      ` exit=${probe.exitCode ?? '-'} signal=${probe.signal ?? '-'}` +
      ` spawnError=${probe.spawnErrorCode ?? '-'}`,
    `verdict=${outcome} (${OUTCOME_EXPLANATION[outcome]})`,
  ];
  if (outcome === PROBE_OUTCOMES.match) {
    return { stdout: facts, stderr: [] };
  }
  const error =
    `::error::Layer-3 Maestro CLI check failed with verdict ${outcome}: the installed ` +
    `maestro ${OUTCOME_EXPLANATION[outcome]}. The oracle pins ${expected}; a differential ` +
    'against a different or unhealthy Maestro proves nothing about the pinned behavior.';
  return {
    stdout: [...facts, error, describeStream(probe.stdout, 'stdout')],
    stderr: [describeStream(probe.stderr, 'stderr')],
  };
}

function describeStream(stream, name) {
  const bound =
    `(retained the last ${stream.bytes} of ${stream.totalBytes} bytes` +
    (stream.droppedBytes > 0 ? `, dropped ${stream.droppedBytes}` : '') +
    ')';
  return [`--- maestro --version ${name} ${bound} ---`, stream.value.trim() || '(empty)'].join(
    '\n',
  );
}

/** Retains at most `MAX_DIAGNOSTIC_BYTES` of a stream, newest first, and counts what it dropped. */
function boundedCapture() {
  let totalBytes = 0;
  let retainedBytes = 0;
  const chunks = [];
  return {
    append(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      totalBytes += buffer.length;
      retainedBytes += buffer.length;
      chunks.push(buffer);
      // One failing JVM can report its whole stack in a single write, so the newest chunk is
      // trimmed too: bounding only whole chunks would keep whatever one write carried.
      while (retainedBytes > MAX_DIAGNOSTIC_BYTES) {
        const oldest = chunks[0];
        const excess = retainedBytes - MAX_DIAGNOSTIC_BYTES;
        if (oldest.length <= excess) {
          chunks.shift();
          retainedBytes -= oldest.length;
        } else {
          chunks[0] = oldest.subarray(excess);
          retainedBytes -= excess;
        }
      }
    },
    read() {
      const value = Buffer.concat(chunks).toString('utf8');
      return { value, bytes: retainedBytes, totalBytes, droppedBytes: totalBytes - retainedBytes };
    },
  };
}

async function main({ command = 'maestro', env = process.env } = {}) {
  const expected = readPinnedVersion();
  const { outcome, report } = evaluateVersionProbe(await probeVersion({ command, env }), expected);
  for (const line of report.stdout) process.stdout.write(`${line}\n`);
  for (const line of report.stderr) process.stderr.write(`${line}\n`);
  return outcome === PROBE_OUTCOMES.match ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
