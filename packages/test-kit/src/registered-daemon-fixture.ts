import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { runCmdDetachedMonitored, ExecDetachedExit } from '@agent-device/host-kit/command';
import { readProcessStartTime } from '@agent-device/host-kit/process';

/** The state-dir layout the fixture child reads: where its registration and sessions live. */
type RegisteredDaemonPaths = Readonly<{ baseDir: string; sessionsDir: string; infoPath: string }>;

/** Per-child behavior switches, bound into this child's entry script at write time. */
type RegisteredDaemonFixtureOptions = Readonly<{
  /** Record `lock-acquired` after acquisition, as the daemon runtime does, for this child only. */
  emitStartupMarker?: boolean;
  /** Record `modules-loaded` before acquisition, as the daemon entry does, for this child only. */
  emitStartupMarkerBeforeAcquisition?: boolean;
}>;

/**
 * What the fixture borrows from the daemon-owning packages. Test-kit sits below them, so the
 * caller supplies the registration owner the child runs, how a child ends, how a published record
 * reads, and the real process launch that a test's module mocks leave alone.
 */
export type RegisteredDaemonComposition<TInfo extends { pid: number }> = Readonly<{
  /** Module URL exporting `DAEMON_STARTUP_EXIT_CODES` and `tryAcquireDaemonRegistration`. */
  registrationOwnerUrl: string;
  /** Module URL exporting the daemon startup-phase marker functions. */
  startupPhasesUrl: string;
  /** Launches a child process without any mock the test installed on process launching. */
  launch: typeof runCmdDetachedMonitored;
  stopDaemonProcess: (
    identity: { pid: number; startTime: string | null },
    options: { mode: 'force'; termTimeoutMs: number; killTimeoutMs: number },
  ) => Promise<{ status: string }>;
  readDaemonInfo: (infoPath: string) => TInfo | null;
}>;

/** A launched fixture child: its pid and the exit it will report. */
export type RegisteredDaemonChild = ReturnType<typeof runCmdDetachedMonitored>;

export type RegisteredDaemonFixtures<
  TInfo extends { pid: number },
  TPaths extends RegisteredDaemonPaths,
  TFields extends object,
> = Readonly<{
  /** A real registration owner, advertising the caller's fields and joining before deletion. */
  registeredDaemonFixtureArgs: (
    paths: TPaths,
    fields: TFields,
    acquisitionBarrier?: string,
    fixtureOptions?: RegisteredDaemonFixtureOptions,
  ) => string[];
  launchRegisteredDaemonFixtureArgs: (
    paths: TPaths,
    args: string[],
    options: Parameters<typeof runCmdDetachedMonitored>[2],
  ) => RegisteredDaemonChild;
  spawnRegisteredDaemonFixture: (
    paths: TPaths,
    fields: TFields,
    options: Parameters<typeof runCmdDetachedMonitored>[2],
    acquisitionBarrier?: string,
    fixtureOptions?: RegisteredDaemonFixtureOptions,
  ) => RegisteredDaemonChild;
  /** Waits up to 4 s for a fixture child to publish `file`; one shared wait for every probe. */
  waitForFixtureFile: (file: string) => Promise<void>;
  waitForRegisteredDaemonFixture: (paths: TPaths, child: RegisteredDaemonChild) => Promise<TInfo>;
  finishRegisteredDaemonFixture: (stateDir: string) => Promise<void>;
  finishRegisteredDaemonFixtures: () => Promise<void>;
}>;

export function createRegisteredDaemonFixtures<
  TInfo extends { pid: number },
  TPaths extends RegisteredDaemonPaths,
  TFields extends object,
>(
  composition: RegisteredDaemonComposition<TInfo>,
): RegisteredDaemonFixtures<TInfo, TPaths, TFields> {
  const children = new Map<
    string,
    Array<{ launch: RegisteredDaemonChild; startTime: string | null }>
  >();

  function registeredDaemonFixtureArgs(
    paths: TPaths,
    fields: TFields,
    acquisitionBarrier?: string,
    fixtureOptions?: RegisteredDaemonFixtureOptions,
  ): string[] {
    // One directory per launch so a later build cannot overwrite a script an earlier child has
    // not loaded; the path still ends in the real daemon entry name for the identity checks.
    const launchDir = path.join(paths.baseDir, 'fixture-entries', crypto.randomUUID());
    const entry = path.join(launchDir, 'dist', 'src', 'internal', 'daemon.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(path.join(launchDir, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(
      entry,
      `import fs from 'node:fs';
import path from 'node:path';
import { DAEMON_STARTUP_EXIT_CODES, tryAcquireDaemonRegistration } from ${JSON.stringify(composition.registrationOwnerUrl)};
import { removeDaemonStartupPhasesFile, recordDaemonStartupMarker, resolveDaemonStartupPhasesPath } from ${JSON.stringify(composition.startupPhasesUrl)};
const paths = ${JSON.stringify(paths)};
const barrier = ${JSON.stringify(acquisitionBarrier)};
const emitBefore = ${fixtureOptions?.emitStartupMarkerBeforeAcquisition ? 'true' : 'false'};
const emitAfter = ${fixtureOptions?.emitStartupMarker ? 'true' : 'false'};
if (barrier) {
  fs.writeFileSync(barrier + '.ready-' + process.pid, 'ready');
  while (!fs.existsSync(barrier)) await new Promise(resolve => setTimeout(resolve, 10));
}
if (emitBefore) { const own = resolveDaemonStartupPhasesPath(paths.baseDir, process.pid); removeDaemonStartupPhasesFile(own); recordDaemonStartupMarker(own, 'modules-loaded'); }
const acquired = await tryAcquireDaemonRegistration(paths);
if (acquired.status !== 'acquired') process.exit(DAEMON_STARTUP_EXIT_CODES[acquired.status]);
if (emitAfter)
  recordDaemonStartupMarker(resolveDaemonStartupPhasesPath(paths.baseDir, process.pid), 'lock-acquired');
process.on('SIGTERM', async () => {
  if (fs.existsSync(path.join(paths.baseDir, 'ignore-sigterm'))) return;
  const deferred = path.join(paths.baseDir, 'repair-on-shutdown.json');
  if (fs.existsSync(deferred)) {
    const dir = path.join(paths.sessionsDir, 'default');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(deferred, path.join(dir, 'repair-tombstone.json'));
  }
  await acquired.owner.finish();
  process.exit(0);
});
fs.writeFileSync(path.join(paths.baseDir, 'registration-held'), 'ready');
fs.writeFileSync(path.join(paths.baseDir, 'registration-held-' + process.pid), 'ready');
while (fs.existsSync(path.join(paths.baseDir, 'defer-publication'))) await new Promise(resolve => setTimeout(resolve, 10));
acquired.owner.publish(${JSON.stringify(fields)});
setInterval(() => {}, 1000);
`,
    );
    return ['--experimental-strip-types', entry];
  }

  function launchRegisteredDaemonFixtureArgs(
    paths: TPaths,
    args: string[],
    options: Parameters<typeof runCmdDetachedMonitored>[2],
  ): RegisteredDaemonChild {
    const child = composition.launch(process.execPath, args, options);
    const owned = children.get(paths.baseDir) ?? [];
    owned.push({ launch: child, startTime: readProcessStartTime(child.pid) });
    children.set(paths.baseDir, owned);
    return child;
  }

  function spawnRegisteredDaemonFixture(
    paths: TPaths,
    fields: TFields,
    options: Parameters<typeof runCmdDetachedMonitored>[2],
    acquisitionBarrier?: string,
    fixtureOptions?: RegisteredDaemonFixtureOptions,
  ): RegisteredDaemonChild {
    return launchRegisteredDaemonFixtureArgs(
      paths,
      registeredDaemonFixtureArgs(paths, fields, acquisitionBarrier, fixtureOptions),
      options,
    );
  }

  async function waitForFixtureFile(file: string): Promise<void> {
    for (let attempt = 0; !fs.existsSync(file); attempt += 1) {
      assert.ok(attempt < 400, `fixture did not publish ${file}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function waitForRegisteredDaemonFixture(
    paths: TPaths,
    child: RegisteredDaemonChild,
  ): Promise<TInfo> {
    let exit: ExecDetachedExit | undefined;
    void child.exited.then((result) => {
      exit = result;
    });
    await Promise.resolve();
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (exit)
        throw new Error(`Registered child exited before publication: ${JSON.stringify(exit)}`);
      const info = composition.readDaemonInfo(paths.infoPath);
      if (info?.pid === child.pid) return info;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Registered child ${child.pid} did not publish ${paths.infoPath} within 4s`);
  }

  async function finishRegisteredDaemonFixture(stateDir: string): Promise<void> {
    for (const owned of children.get(stateDir) ?? []) {
      const child = owned.launch;
      const termination = await composition.stopDaemonProcess(
        { pid: child.pid, startTime: owned.startTime },
        { mode: 'force', termTimeoutMs: 0, killTimeoutMs: 2_000 },
      );
      assert.notEqual(termination.status, 'retained', JSON.stringify(termination));
      await child.exited;
    }
    children.delete(stateDir);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }

  async function finishRegisteredDaemonFixtures(): Promise<void> {
    for (const stateDir of children.keys()) await finishRegisteredDaemonFixture(stateDir);
  }

  return {
    registeredDaemonFixtureArgs,
    launchRegisteredDaemonFixtureArgs,
    spawnRegisteredDaemonFixture,
    waitForFixtureFile,
    waitForRegisteredDaemonFixture,
    finishRegisteredDaemonFixture,
    finishRegisteredDaemonFixtures,
  };
}
