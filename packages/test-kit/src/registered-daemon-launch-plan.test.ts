import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expectTypeOf, test, vi } from 'vitest';
import {
  createRegisteredDaemonFixtures,
  type RegisteredDaemonChild,
} from './registered-daemon-fixture.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

afterEach(() => vi.useRealTimers());

function diagnostic(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return [
    error.message,
    diagnostic(error.cause),
    ...(error instanceof AggregateError ? error.errors.map(diagnostic) : []),
  ].join('\n');
}

function rejectsContract(pending: Promise<void>, pattern: RegExp): Promise<void> {
  return assert.rejects(pending, (error: unknown) => {
    assert.match(diagnostic(error), pattern);
    return true;
  });
}

function fixture(exited = Promise.resolve({ pid: process.pid, exitCode: 0 })) {
  const baseDir = mkdtempForTestSync('daemon-launch-plan-');
  const paths = {
    baseDir,
    sessionsDir: path.join(baseDir, 'sessions'),
    infoPath: path.join(baseDir, 'daemon.json'),
  };
  const child: RegisteredDaemonChild = { pid: process.pid, exited };
  let launches = 0;
  let stops = 0;
  const fixtures = createRegisteredDaemonFixtures({
    registrationOwnerUrl: 'file:///unused-registration.ts',
    startupPhasesUrl: 'file:///unused-phases.ts',
    launch: () => {
      launches++;
      return child;
    },
    stopDaemonProcess: async () => {
      stops++;
      return { status: 'exited' };
    },
    readDaemonInfo: () => null,
  });
  return { fixtures, paths, child, launches: () => launches, stops: () => stops };
}

test('refusal and an unexpected second launch start no extra writer even when their errors are caught', async () => {
  const f = fixture();
  const refusal = new Error('launch refused');
  const refuse = f.fixtures.planRegisteredDaemonLaunches([{ kind: 'refuse', error: refusal }]);
  assert.throws(
    () => refuse('node', []),
    (error) => error === refusal,
  );
  assert.equal(fs.existsSync(path.join(f.paths.baseDir, 'fixture-entries')), false);
  const launch = f.fixtures.planRegisteredDaemonLaunches([
    { kind: 'registered', paths: f.paths, fields: {} },
  ]);
  assert.equal(launch('node', []), f.child);
  assert.throws(() => launch('node', []), /unexpected launch 2/);
  assert.equal(f.launches(), 1);
  await rejectsContract(f.fixtures.finishRegisteredDaemonFixtures(), /unexpected launch 2/);
});

test('a refusal builder cannot secretly launch a child before returning its refusal', async () => {
  const f = fixture();
  const launch = f.fixtures.planRegisteredDaemonLaunches([
    () => {
      f.fixtures.spawnRegisteredDaemonFixture(f.paths, {}, undefined);
      return { kind: 'refuse', error: new Error('refused after spawning') };
    },
  ]);
  assert.throws(() => launch('node', []), /plan callback attempted to start a child/);
  assert.equal(f.launches(), 0);
  assert.equal(fs.existsSync(path.join(f.paths.baseDir, 'fixture-entries')), false);
  await rejectsContract(
    f.fixtures.finishRegisteredDaemonFixtures(),
    /plan callback attempted to start a child/,
  );
});

test('an observer cannot replace the returned child handle and its violation survives caught errors', async () => {
  const f = fixture();
  const launch = f.fixtures.planRegisteredDaemonLaunches([
    {
      kind: 'registered',
      paths: f.paths,
      fields: {},
      observe: () => ({ pid: 1234, exited: Promise.resolve({ pid: 1234, exitCode: 0 }) }),
    },
  ]);
  assert.equal(launch('node', []), f.child);
  await assert.rejects(f.fixtures.finishRegisteredDaemonFixtures(), (error: unknown) => {
    function leafErrors(value: unknown): Error[] {
      return value instanceof AggregateError
        ? value.errors.flatMap(leafErrors)
        : value instanceof Error
          ? [value]
          : [];
    }
    const errors = leafErrors(error);
    assert.equal(errors.length, 1, 'one replacement handle must produce exactly one violation');
    assert.match(errors[0]!.message, /observer returned a replacement handle/);
    return true;
  });
});

test('teardown fails when termination reports success but the exact child exit never joins', async () => {
  vi.useFakeTimers();
  const f = fixture(new Promise(() => {}));
  f.fixtures.spawnRegisteredDaemonFixture(f.paths, {}, undefined);
  const rejected = rejectsContract(
    f.fixtures.finishRegisteredDaemonFixtures(),
    /was not joined after termination/,
  );
  await vi.advanceTimersByTimeAsync(1_000);
  await rejected;
});

test('a declared launch returns its exact child and teardown joins it before deleting state', async () => {
  const f = fixture();
  const launch = f.fixtures.planRegisteredDaemonLaunches([
    { kind: 'registered', paths: f.paths, fields: {} },
  ]);
  const child = launch('node', []);
  assert.equal(child.pid, process.pid);
  assert.equal(child.exited, f.child.exited);
  await f.fixtures.finishRegisteredDaemonFixtures();
  assert.equal(fs.existsSync(f.paths.baseDir), false);
});

test('a failed child join does not prevent teardown from stopping the remaining children', async () => {
  vi.useFakeTimers();
  const f = fixture(new Promise(() => {}));
  f.fixtures.spawnRegisteredDaemonFixture(f.paths, {}, undefined);
  f.fixtures.spawnRegisteredDaemonFixture(f.paths, {}, undefined);
  const rejected = rejectsContract(
    f.fixtures.finishRegisteredDaemonFixtures(),
    /was not joined after termination/,
  );
  await vi.runAllTimersAsync();
  await rejected;
  assert.equal(f.stops(), 2);
  assert.equal(
    fs.existsSync(f.paths.baseDir),
    true,
    'failed cleanup must retain state for diagnosis',
  );
});

test('exit gates delay the returned launch but are not accepted on companions', async () => {
  const f = fixture();
  let release!: () => void;
  const exitGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const step = { kind: 'registered' as const, paths: f.paths, fields: {} };
  type RegisteredLaunch = Extract<
    Parameters<typeof f.fixtures.planRegisteredDaemonLaunches>[0][number],
    { kind: 'registered' }
  >;
  type Companion = NonNullable<RegisteredLaunch['companions']>[number];
  expectTypeOf<typeof step & { exitGate: Promise<void> }>().not.toExtend<Companion>();
  const launch = f.fixtures.planRegisteredDaemonLaunches([
    { ...step, exitGate, companions: [step] },
  ]);
  const child = launch('node', []);
  let exited = false;
  void child.exited.then(() => {
    exited = true;
  });
  await Promise.resolve();
  assert.equal(f.launches(), 2);
  assert.equal(exited, false, 'the returned child must wait for its exit gate');
  release();
  assert.equal(await child.exited, await f.child.exited);
  await f.fixtures.finishRegisteredDaemonFixtures();
  assert.equal(f.stops(), 2);
});
