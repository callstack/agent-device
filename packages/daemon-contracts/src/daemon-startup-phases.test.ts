import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { tryAcquireDaemonRegistration } from '@agent-device/daemon-contracts/daemon-registration-owner';
import {
  readDaemonStartupPhaseMarkers,
  recordDaemonStartupMarker,
  removeDaemonStartupPhasesFile,
  resolveDaemonStartupPhasesPath,
} from '@agent-device/daemon-contracts/daemon-startup-phases';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { mkdtempForTest } from '@agent-device/test-kit';

test('per-launch marker files: a fresh launch never reads an older launch phases', async () => {
  const stateDir = await mkdtempForTest('agent-device-markers-');
  const first = resolveDaemonStartupPhasesPath(stateDir, 1111);
  const second = resolveDaemonStartupPhasesPath(stateDir, 2222);
  recordDaemonStartupMarker(first, 'lock-acquired');
  expect(second).not.toBe(first);
  expect(existsSync(second)).toBe(false);
  recordDaemonStartupMarker(second, 'modules-loaded');
  const firstPhases = readDaemonStartupPhaseMarkers(readFileSync(first, 'utf8'));
  const secondPhases = readDaemonStartupPhaseMarkers(readFileSync(second, 'utf8'));
  expect(Object.keys(firstPhases)).toEqual(['lock-acquired']);
  expect(Object.keys(secondPhases)).toEqual(['modules-loaded']);
});

test('marker reading keeps the earliest record when a phase replays after a later one', () => {
  const text = [
    '{"data":{"startupPhase":"listening","timestampMs":500}}',
    '{"data":{"startupPhase":"lock-acquired","timestampMs":20}}',
    '{"data":{"startupPhase":"lock-acquired","timestampMs":35}}',
  ].join('\n');
  const phases = readDaemonStartupPhaseMarkers(text);
  expect(phases['lock-acquired']).toBe(20);
  expect(phases.listening).toBe(500);
});

test('marker reading ignores unknown phases and unparsable lines', () => {
  const text = [
    '{"data":{"startupPhase":"heartbeat","timestampMs":10}}',
    '{"data":{"startupPhase":"registered","timestampMs":"7"}}',
    'not json',
    '{"data":{"startupPhase":"listening","timestampMs":30}}',
  ].join('\n');
  expect(readDaemonStartupPhaseMarkers(text)).toEqual({ listening: 30 });
});

test('the producer lifetime claim empties a same-pid leftover', async () => {
  // Pid reuse after both the old client and daemon died before either cleanup: the entry removes
  // its record before its first marker; this child repeats that producer sequence itself.
  const stateDir = await mkdtempForTest('agent-device-markers-');
  writeFileSync(path.join(stateDir, 'package.json'), '{"type":"module"}');
  const entry = path.join(stateDir, 'claim-producer.js');
  const registrationUrl = new URL('./daemon-startup-phases.ts', import.meta.url).href;
  writeFileSync(
    entry,
    `import { removeDaemonStartupPhasesFile, recordDaemonStartupMarker, resolveDaemonStartupPhasesPath } from ${JSON.stringify(registrationUrl)};
const file = resolveDaemonStartupPhasesPath(${JSON.stringify(stateDir)}, process.pid);
recordDaemonStartupMarker(file, 'listening');
recordDaemonStartupMarker(file, 'registered');
removeDaemonStartupPhasesFile(file);
recordDaemonStartupMarker(file, 'modules-loaded');
`,
  );
  const child = spawnSync(process.execPath, ['--experimental-strip-types', entry], {
    encoding: 'utf8',
  });
  if (child.status !== 0) throw new Error(child.stderr);
  const phases = readDaemonStartupPhaseMarkers(
    readFileSync(resolveDaemonStartupPhasesPath(stateDir, child.pid!), 'utf8'),
  );
  expect(phases).toEqual({ 'modules-loaded': expect.any(Number) });
});

test.each([
  ['remove', (p: string, cb: (e: unknown) => void) => removeDaemonStartupPhasesFile(p, cb)],
  [
    'record',
    (p: string, cb: (e: unknown) => void) => recordDaemonStartupMarker(p, 'modules-loaded', cb),
  ],
] as const)('a refused %s reports through the callback instead of throwing', async (_name, run) => {
  const stateDir = await mkdtempForTest('agent-device-markers-');
  const markerPath = resolveDaemonStartupPhasesPath(stateDir, 777);
  mkdirSync(markerPath, { recursive: true });
  const reported: unknown[] = [];
  expect(() =>
    run(markerPath, (error) => {
      reported.push(error);
    }),
  ).not.toThrow();
  expect(reported).toHaveLength(1);
  expect(reported[0]).toHaveProperty('message');
});

test('acquiring the registration retires files of dead or unowned pids only', async () => {
  const paths = resolveDaemonPaths(await mkdtempForTest('agent-device-markers-'));
  const dead = resolveDaemonStartupPhasesPath(paths.baseDir, spawnDeadPid());
  const own = resolveDaemonStartupPhasesPath(paths.baseDir, process.pid);
  const unparseable = path.join(paths.baseDir, 'daemon-startup-phases-.jsonl');
  const legacy = path.join(paths.baseDir, 'daemon-startup-phases.jsonl');
  await Promise.all([
    writeFile(own, 'x\n', 'utf8'),
    writeFile(dead, 'x\n', 'utf8'),
    writeFile(unparseable, 'x\n', 'utf8'),
    writeFile(legacy, 'x\n', 'utf8'),
  ]);
  const attempt = await tryAcquireDaemonRegistration(paths);
  expect(attempt.status).toBe('acquired');
  if (attempt.status !== 'acquired') throw new Error('registration refused');
  expect(existsSync(dead)).toBe(false);
  expect(existsSync(unparseable)).toBe(false);
  expect(existsSync(own)).toBe(true);
  expect(existsSync(legacy)).toBe(true);
  await attempt.owner.finish();
});

test('removeDaemonStartupPhasesFile removes a file and tolerates one already gone', async () => {
  const stateDir = await mkdtempForTest('agent-device-markers-');
  const file = resolveDaemonStartupPhasesPath(stateDir, 4242);
  await writeFile(file, 'x\n', 'utf8');
  removeDaemonStartupPhasesFile(file);
  expect(existsSync(file)).toBe(false);
  expect(() => removeDaemonStartupPhasesFile(file)).not.toThrow();
});

test('a crash-replay append keeps the file valid JSONL', async () => {
  const stateDir = await mkdtempForTest('agent-device-markers-');
  const markerPath = resolveDaemonStartupPhasesPath(stateDir, 999);
  await appendFile(markerPath, '{"data":{"startupPhase":"modules-lo', 'utf8');
  recordDaemonStartupMarker(markerPath, 'composition-loaded');
  const tail = await readFile(markerPath, 'utf8');
  expect(Object.keys(readDaemonStartupPhaseMarkers(tail))).toEqual(['composition-loaded']);
});

function spawnDeadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  if (child.error) throw child.error;
  const pid = child.pid;
  if (pid === undefined) throw new Error('spawnSync returned no pid');
  return pid;
}
