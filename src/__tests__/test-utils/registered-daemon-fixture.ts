import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import type { runCmdDetachedMonitored, ExecDetachedExit } from '@agent-device/host-kit/command';
import { readDaemonInfo, type DaemonInfo } from '../../daemon-client/daemon-client-metadata.ts';
import { readProcessStartTime } from '@agent-device/host-kit/process';
import { stopDaemonProcess } from '@agent-device/daemon-contracts/daemon-process';
import type { DaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import type { DaemonRegistrationFields } from '@agent-device/daemon-contracts/daemon-registration-owner';

const actualCommand = await vi.importActual<typeof import('@agent-device/host-kit/command')>(
  '@agent-device/host-kit/command',
);
const children = new Map<
  string,
  Array<{ launch: ReturnType<typeof runCmdDetachedMonitored>; startTime: string | null }>
>();

/** Per-child behavior switches, bound into this child's entry script at write time. */
export type RegisteredDaemonFixtureOptions = Readonly<{
  /** Record `lock-acquired` after acquisition, as the daemon runtime does, for this child only. */
  emitStartupMarker?: boolean;
  /** Record `modules-loaded` before acquisition, as the daemon entry does, for this child only. */
  emitStartupMarkerBeforeAcquisition?: boolean;
}>;

/** A real registration owner, advertising the caller's HTTP fixture and joining before deletion. */
export function registeredDaemonFixtureArgs(
  paths: DaemonPaths,
  fields: DaemonRegistrationFields,
  acquisitionBarrier?: string,
  fixtureOptions?: RegisteredDaemonFixtureOptions,
): string[] {
  // One directory per launch so a later build cannot overwrite a script an earlier child has
  // not loaded; the path still ends in the real daemon entry name for the identity checks.
  const launchDir = path.join(paths.baseDir, 'fixture-entries', crypto.randomUUID());
  const entry = path.join(launchDir, 'dist', 'src', 'internal', 'daemon.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(path.join(launchDir, 'package.json'), '{"type":"module"}');
  const registrationUrl = new URL(
    '../../../packages/daemon-contracts/src/daemon-registration-owner.ts',
    import.meta.url,
  ).href;
  const phasesUrl = new URL(
    '../../../packages/daemon-contracts/src/daemon-startup-phases.ts',
    import.meta.url,
  ).href;
  fs.writeFileSync(
    entry,
    `import fs from 'node:fs';
import path from 'node:path';
import { DAEMON_STARTUP_EXIT_CODES, tryAcquireDaemonRegistration } from ${JSON.stringify(registrationUrl)};
import { removeDaemonStartupPhasesFile, recordDaemonStartupMarker, resolveDaemonStartupPhasesPath } from ${JSON.stringify(phasesUrl)};
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

export function launchRegisteredDaemonFixtureArgs(
  paths: DaemonPaths,
  args: string[],
  options: Parameters<typeof runCmdDetachedMonitored>[2],
): ReturnType<typeof runCmdDetachedMonitored> {
  const child = actualCommand.runCmdDetachedMonitored(process.execPath, args, options);
  const owned = children.get(paths.baseDir) ?? [];
  owned.push({ launch: child, startTime: readProcessStartTime(child.pid) });
  children.set(paths.baseDir, owned);
  return child;
}

export function spawnRegisteredDaemonFixture(
  paths: DaemonPaths,
  fields: DaemonRegistrationFields,
  options: Parameters<typeof runCmdDetachedMonitored>[2],
  acquisitionBarrier?: string,
  fixtureOptions?: RegisteredDaemonFixtureOptions,
): ReturnType<typeof runCmdDetachedMonitored> {
  return launchRegisteredDaemonFixtureArgs(
    paths,
    registeredDaemonFixtureArgs(paths, fields, acquisitionBarrier, fixtureOptions),
    options,
  );
}

/** Waits up to 4 s for a fixture child to publish `file`; one shared wait for every probe. */
export async function waitForFixtureFile(file: string): Promise<void> {
  for (let attempt = 0; !fs.existsSync(file); attempt += 1) {
    assert.ok(attempt < 400, `fixture did not publish ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function waitForRegisteredDaemonFixture(
  paths: DaemonPaths,
  child: ReturnType<typeof runCmdDetachedMonitored>,
): Promise<DaemonInfo> {
  let exit: ExecDetachedExit | undefined;
  void child.exited.then((result) => {
    exit = result;
  });
  await Promise.resolve();
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (exit)
      throw new Error(`Registered child exited before publication: ${JSON.stringify(exit)}`);
    const info = readDaemonInfo(paths.infoPath);
    if (info?.pid === child.pid) return info;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Registered child ${child.pid} did not publish ${paths.infoPath} within 4s`);
}

export async function finishRegisteredDaemonFixture(stateDir: string): Promise<void> {
  for (const owned of children.get(stateDir) ?? []) {
    const child = owned.launch;
    const termination = await stopDaemonProcess(
      { pid: child.pid, startTime: owned.startTime },
      { mode: 'force', termTimeoutMs: 0, killTimeoutMs: 2_000 },
    );
    assert.notEqual(termination.status, 'retained', JSON.stringify(termination));
    await child.exited;
  }
  children.delete(stateDir);
  fs.rmSync(stateDir, { recursive: true, force: true });
}

export async function finishRegisteredDaemonFixtures(): Promise<void> {
  for (const stateDir of children.keys()) await finishRegisteredDaemonFixture(stateDir);
}
