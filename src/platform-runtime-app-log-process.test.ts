import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, test, vi } from 'vitest';

const exec = vi.hoisted(() => ({ run: vi.fn() }));
const processIdentity = vi.hoisted(() => ({
  alive: true,
  command: 'adb -s emulator-5554 logcat --pid 123' as string | null,
  startTime: 'Sun Aug 9 22:00:00 2026' as string | null,
}));

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmdBackground: exec.run,
}));
vi.mock('@agent-device/host-kit/process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/process')>()),
  isProcessAlive: () => processIdentity.alive,
  readProcessCommand: () => processIdentity.command,
  readProcessStartTime: () => processIdentity.startTime,
  waitForProcessExit: async () => true,
}));

import {
  createManagedAppLogProcesses,
  recoverLegacyAppLogMarkersAfterDaemonLock,
} from './platform-runtime-app-log-process.ts';

const roots: string[] = [];

afterEach(() => {
  exec.run.mockReset();
  processIdentity.alive = true;
  processIdentity.command = 'adb -s emulator-5554 logcat --pid 123';
  processIdentity.startTime = 'Sun Aug 9 22:00:00 2026';
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('managed app-log process host', () => {
  test('publishes a complete marker atomically and preserves invalid evidence', async () => {
    const fixture = processFixture();
    const processes = createManagedAppLogProcesses(fixture.sessionsDir);
    const running = await processes.start(fixture.request);
    expect(await processes.readMarker(fixture.markerPath)).toEqual({
      status: 'decoded',
      marker: {
        pid: 99,
        startTime: processIdentity.startTime,
        command: processIdentity.command,
      },
    });
    expect(fs.readdirSync(path.dirname(fixture.markerPath))).toEqual(['app-log.pid']);

    fs.writeFileSync(fixture.markerPath, '{torn');
    expect(await processes.readMarker(fixture.markerPath)).toMatchObject({ status: 'invalid' });
    expect(fs.existsSync(fixture.markerPath)).toBe(true);
    expect(running.marker).toBeDefined();
  });

  test('authorizes cleanup by exact process identity instead of command vocabulary', async () => {
    processIdentity.command = '/opt/acme/bin/device-output --stream session-1';
    const fixture = processFixture({ settled: true });
    const processes = createManagedAppLogProcesses(fixture.sessionsDir);

    const running = await processes.start(fixture.request);

    expect(running.marker).toEqual({
      pid: 99,
      startTime: processIdentity.startTime,
      command: processIdentity.command,
    });
    await expect(processes.inspect(running.marker!)).resolves.toBe('owned-alive');
  });

  test('rolls back start when process identity is incomplete', async () => {
    processIdentity.startTime = null;
    const fixture = processFixture({ settled: true });
    await expect(
      createManagedAppLogProcesses(fixture.sessionsDir).start(fixture.request),
    ).rejects.toThrow('complete ownership marker');
    expect(fixture.child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(fs.existsSync(fixture.markerPath)).toBe(false);
  });

  test('rolls back a provider child that exposes no durable process identity', async () => {
    const fixture = processFixture({ settled: true });
    const child = Object.assign(new EventEmitter(), {
      exitCode: undefined,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    });
    await expect(
      createManagedAppLogProcesses(fixture.sessionsDir, {
        launch: async () => ({
          child,
          wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
        }),
      }).start(fixture.request),
    ).rejects.toThrow('complete ownership marker');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(fs.existsSync(fixture.markerPath)).toBe(false);
  });

  test('forwards setup cancellation to a custom process launcher', async () => {
    const fixture = processFixture({ settled: true });
    const controller = new AbortController();
    const reason = new Error('provider launch cancelled');
    const launch = vi.fn(async (_command, signal) => {
      expect(signal).toBe(controller.signal);
      throw reason;
    });

    await expect(
      createManagedAppLogProcesses(fixture.sessionsDir, { launch }).start(
        fixture.request,
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(launch).toHaveBeenCalledOnce();
  });

  test('refuses pre-existing marker evidence before spawning a replacement', async () => {
    const fixture = processFixture({ settled: true });
    fs.writeFileSync(fixture.markerPath, '{retained');
    await expect(
      createManagedAppLogProcesses(fixture.sessionsDir).start(fixture.request),
    ).rejects.toThrow('must be recovered before start');
    expect(exec.run).not.toHaveBeenCalled();
    expect(fs.readFileSync(fixture.markerPath, 'utf8')).toBe('{retained');
  });

  test('treats PID command reuse as ownership lost and never terminates it', async () => {
    const fixture = processFixture();
    const processes = createManagedAppLogProcesses(fixture.sessionsDir);
    const running = await processes.start(fixture.request);
    processIdentity.command = 'unrelated process';
    expect(await processes.inspect(running.marker!)).toBe('ownership-lost');
    expect(await processes.terminate(running.marker!)).toBe('ownership-lost');
    expect(fixture.child.kill).not.toHaveBeenCalled();
    expect(fs.existsSync(fixture.markerPath)).toBe(true);
  });

  test('handles output rejection immediately and fails the managed wait', async () => {
    const fixture = processFixture({ rejectOutput: true });
    const running = await createManagedAppLogProcesses(fixture.sessionsDir).start(fixture.request);
    fixture.child.stdout.write('line\n');
    await vi.waitFor(() => expect(fixture.child.kill).toHaveBeenCalledWith('SIGKILL'));
    fixture.resolveWait();
    await expect(running.wait).rejects.toThrow('sink failed');
  });

  test('terminates the owned child exactly once across terminate and async disposal', async () => {
    const fixture = processFixture();
    const running = await createManagedAppLogProcesses(fixture.sessionsDir).start(fixture.request);
    const terminating = running.terminate();
    fixture.resolveWait();
    await terminating;
    await running[Symbol.asyncDispose]();
    expect(fixture.child.kill).toHaveBeenCalledTimes(1);
    expect(fixture.child.kill).toHaveBeenCalledWith('SIGINT');
  });

  test('retains a marker that is corrupted before the managed child exits', async () => {
    const fixture = processFixture();
    const running = await createManagedAppLogProcesses(fixture.sessionsDir).start(fixture.request);
    fs.writeFileSync(fixture.markerPath, '{corrupt');
    fixture.resolveWait();
    await running.wait;
    expect(fs.readFileSync(fixture.markerPath, 'utf8')).toBe('{corrupt');
  });

  test('rejects marker paths outside the sessions root', async () => {
    const fixture = processFixture({ settled: true });
    await expect(
      createManagedAppLogProcesses(fixture.sessionsDir).start({
        ...fixture.request,
        markerPath: path.join(path.dirname(fixture.sessionsDir), 'app-log.pid'),
      }),
    ).rejects.toThrow('outside the daemon-owned sessions directory');
  });

  test('rejects a symlinked marker directory that escapes the sessions root', async () => {
    const fixture = processFixture({ settled: true });
    const outside = path.join(path.dirname(fixture.sessionsDir), 'outside');
    const linked = path.join(fixture.sessionsDir, 'linked');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, linked);
    await expect(
      createManagedAppLogProcesses(fixture.sessionsDir).start({
        ...fixture.request,
        markerPath: path.join(linked, 'app-log.pid'),
      }),
    ).rejects.toThrow('resolves outside');
    expect(exec.run).not.toHaveBeenCalled();
  });

  test('retains a final app-log.pid symlink as invalid evidence without following it', async () => {
    const fixture = processFixture({ settled: true });
    const outsidePath = path.join(path.dirname(fixture.sessionsDir), 'outside-marker.json');
    const outsideMarker = {
      pid: 99,
      startTime: processIdentity.startTime,
      command: processIdentity.command,
    };
    fs.writeFileSync(outsidePath, `${JSON.stringify(outsideMarker)}\n`);
    fs.symlinkSync(outsidePath, fixture.markerPath);
    const processes = createManagedAppLogProcesses(fixture.sessionsDir);

    await expect(processes.readMarker(fixture.markerPath)).resolves.toMatchObject({
      status: 'invalid',
    });
    const recovery = await recoverLegacyAppLogMarkersAfterDaemonLock(fixture.sessionsDir);
    expect(recovery.retained).toEqual([
      expect.objectContaining({ markerPath: fixture.markerPath, reason: 'invalid' }),
    ]);
    await expect(processes.start(fixture.request)).rejects.toThrow(
      'must be recovered before start',
    );
    expect(exec.run).not.toHaveBeenCalled();
    expect(fs.readFileSync(outsidePath, 'utf8')).toBe(`${JSON.stringify(outsideMarker)}\n`);
    expect(fs.lstatSync(fixture.markerPath).isSymbolicLink()).toBe(true);
  });

  test('recovers only complete owned legacy markers and retains untrusted evidence', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-app-log-legacy-'));
    roots.push(root);
    const sessionsDir = path.join(root, 'sessions');
    const recoveredPath = legacyMarker(sessionsDir, 'recovered', {
      pid: 99,
      startTime: processIdentity.startTime,
      command: processIdentity.command,
    });
    const invalidPath = legacyMarker(sessionsDir, 'invalid', 99);
    const corruptPath = legacyMarker(sessionsDir, 'corrupt', { pid: 99 });
    const skippedPath = legacyMarker(sessionsDir, 'manifest', {
      pid: 99,
      startTime: processIdentity.startTime,
      command: processIdentity.command,
    });
    fs.writeFileSync(path.join(path.dirname(skippedPath), 'app-log.resource.json'), '{}');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      processIdentity.alive = false;
      return true;
    });
    const result = await recoverLegacyAppLogMarkersAfterDaemonLock(sessionsDir);
    kill.mockRestore();

    expect(result.recovered).toEqual([recoveredPath]);
    expect(result.retained).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ markerPath: invalidPath, reason: 'invalid' }),
        expect.objectContaining({ markerPath: corruptPath, reason: 'invalid' }),
      ]),
    );
    expect(fs.existsSync(recoveredPath)).toBe(false);
    expect(fs.existsSync(invalidPath)).toBe(true);
    expect(fs.existsSync(corruptPath)).toBe(true);
    expect(fs.existsSync(skippedPath)).toBe(true);
  });

  test('scopes ownership-lost legacy markers to the device encoded by their command', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-app-log-legacy-identity-'));
    roots.push(root);
    const sessionsDir = path.join(root, 'sessions');
    const markerPath = legacyMarker(sessionsDir, 'android', {
      pid: 99,
      startTime: processIdentity.startTime,
      command: 'adb -s emulator-5554 logcat -v time',
    });
    processIdentity.command = 'unrelated process';

    const result = await recoverLegacyAppLogMarkersAfterDaemonLock(sessionsDir);

    expect(result.retained).toEqual([
      {
        markerPath,
        reason: 'ownership-lost',
        device: {
          id: 'emulator-5554',
          family: 'android',
          kind: 'emulator',
          target: 'mobile',
        },
      },
    ]);
    expect(fs.existsSync(markerPath)).toBe(true);
  });
});

function legacyMarker(sessionsDir: string, sessionId: string, marker: unknown): string {
  const sessionDir = path.join(sessionsDir, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const markerPath = path.join(sessionDir, 'app-log.pid');
  fs.writeFileSync(markerPath, `${JSON.stringify(marker)}\n`);
  return markerPath;
}

function processFixture(options: { settled?: boolean; rejectOutput?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-app-log-process-'));
  roots.push(root);
  const sessionsDir = path.join(root, 'sessions');
  const sessionDir = path.join(sessionsDir, 'one');
  fs.mkdirSync(sessionDir, { recursive: true });
  const markerPath = path.join(sessionDir, 'app-log.pid');
  const child = Object.assign(new EventEmitter(), {
    pid: 99,
    exitCode: null as number | null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  let resolveWait = () => {};
  const wait = options.settled
    ? Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
    : new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
        resolveWait = () => resolve({ stdout: '', stderr: '', exitCode: 0 });
      });
  exec.run.mockReturnValue({ child, wait });
  return {
    sessionsDir,
    markerPath,
    child,
    resolveWait,
    request: {
      command: {
        kind: 'host',
        request: { executable: 'adb', args: ['logcat', '--pid', '123'], allowFailure: true },
      },
      output: {
        write: async () => {
          if (options.rejectOutput) throw new Error('sink failed');
        },
        [Symbol.asyncDispose]: async () => {},
      },
      markerPath,
    } as const,
  };
}
