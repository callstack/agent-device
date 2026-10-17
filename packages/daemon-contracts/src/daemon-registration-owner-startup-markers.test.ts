import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readDaemonStartupPhaseMarkers,
  recordDaemonStartupMarker,
  removeDaemonStartupPhasesFile,
  resolveDaemonStartupPhasesPath,
  tryAcquireDaemonRegistration,
} from '@agent-device/daemon-contracts/daemon-registration-owner';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { mkdtempForTest } from '@agent-device/test-kit';

describe('per-launch startup marker files', () => {
  it('scopes marker files to the writing pid so a fresh launch never reads an older launch phases', async () => {
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

  it('keeps the earliest record when a replayed phase is appended after a later one', () => {
    const text = [
      '{"data":{"startupPhase":"listening","timestampMs":500}}',
      '{"data":{"startupPhase":"lock-acquired","timestampMs":20}}',
      '{"data":{"startupPhase":"lock-acquired","timestampMs":35}}',
    ].join('\n');
    const phases = readDaemonStartupPhaseMarkers(text);
    expect(phases['lock-acquired']).toBe(20);
    expect(phases.listening).toBe(500);
  });

  it('ignores unknown phases and unparsable lines so the protocol stays additive', () => {
    const text = [
      '{"data":{"startupPhase":"heartbeat","timestampMs":10}}',
      '{"data":{"startupPhase":"registered","timestampMs":"7"}}',
      'not json',
      '{"data":{"startupPhase":"listening","timestampMs":30}}',
    ].join('\n');
    expect(readDaemonStartupPhaseMarkers(text)).toEqual({ listening: 30 });
  });
});

describe('registration-time sweep', () => {
  it('retires marker files of provably-dead pids and keeps files of live pids', async () => {
    const paths = resolveDaemonPaths(await mkdtempForTest('agent-device-markers-'));
    const deadPid = spawnDeadPid();
    const own = resolveDaemonStartupPhasesPath(paths.baseDir, process.pid);
    const dead = resolveDaemonStartupPhasesPath(paths.baseDir, deadPid);
    const legacy = path.join(paths.baseDir, 'daemon-startup-phases.jsonl');
    await Promise.all([
      writeFile(own, 'x\n', 'utf8'),
      writeFile(dead, 'x\n', 'utf8'),
      writeFile(legacy, 'x\n', 'utf8'),
    ]);

    const attempt = await tryAcquireDaemonRegistration(paths);
    expect(attempt.status).toBe('acquired');
    if (attempt.status !== 'acquired') throw new Error('registration refused');

    expect(existsSync(dead)).toBe(false);
    expect(existsSync(own)).toBe(true);
    // The sweep retires only its own kind: an unknown entry stays as evidence.
    expect(existsSync(legacy)).toBe(true);
    await attempt.owner.finish();
  });

  it('retires files whose pid is unparseable', async () => {
    const paths = resolveDaemonPaths(await mkdtempForTest('agent-device-markers-'));
    const stale = path.join(paths.baseDir, 'daemon-startup-phases-.jsonl');
    await writeFile(stale, 'x\n', 'utf8');

    const attempt = await tryAcquireDaemonRegistration(paths);
    expect(attempt.status).toBe('acquired');
    if (attempt.status !== 'acquired') throw new Error('registration refused');

    expect(existsSync(stale)).toBe(false);
    await attempt.owner.finish();
  });
});

describe('removeDaemonStartupPhasesFile', () => {
  it('removes a marker file and tolerates a file already gone', async () => {
    const stateDir = await mkdtempForTest('agent-device-markers-');
    const file = resolveDaemonStartupPhasesPath(stateDir, 4242);
    await writeFile(file, 'x\n', 'utf8');

    removeDaemonStartupPhasesFile(file);
    expect(existsSync(file)).toBe(false);

    expect(() => removeDaemonStartupPhasesFile(file)).not.toThrow();
  });
});

describe('recordDaemonStartupMarker failure seam', () => {
  it('reports a write failure through the callback instead of throwing, keeping startup running', async () => {
    const stateDir = await mkdtempForTest('agent-device-markers-');
    // A directory in place of the marker file makes every append fail.
    const markerPath = resolveDaemonStartupPhasesPath(stateDir, 777);
    mkdirSync(markerPath, { recursive: true });

    const reported: unknown[] = [];
    expect(() =>
      recordDaemonStartupMarker(markerPath, 'modules-loaded', (error) => {
        reported.push(error);
      }),
    ).not.toThrow();

    expect(reported).toHaveLength(1);
    expect(reported[0]).toHaveProperty('message');
  });

  it('keeps appending valid JSONL when an incomplete line precedes a crash-replay append', async () => {
    const stateDir = await mkdtempForTest('agent-device-markers-');
    const markerPath = resolveDaemonStartupPhasesPath(stateDir, 999);
    await appendFile(markerPath, '{"data":{"startupPhase":"modules-lo', 'utf8');

    recordDaemonStartupMarker(markerPath, 'composition-loaded');

    const tail = await readFile(markerPath, 'utf8');
    expect(Object.keys(readDaemonStartupPhaseMarkers(tail))).toEqual(['composition-loaded']);
  });
});

function spawnDeadPid(): number {
  // A process that has already exited proves the liveness check rejects it,
  // the same way the daemon-process takeover guards prove it.
  const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  if (child.error) throw child.error;
  const pid = child.pid;
  if (pid === undefined) throw new Error('spawnSync returned no pid');
  return pid;
}
