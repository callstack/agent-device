import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import type { runCmdDetachedMonitored, ExecDetachedExit } from '@agent-device/host-kit/command';
import { readDaemonInfo, type DaemonInfo } from '../../daemon-client/daemon-client-metadata.ts';
import { readProcessStartTime } from '@agent-device/host-kit/process';
import { stopDaemonProcess } from '../../daemon-process.ts';
import type { DaemonPaths } from '../../daemon-resolution.ts';
import type { DaemonRegistrationFields } from '../../daemon-registration-owner.ts';

const actualCommand = await vi.importActual<typeof import('@agent-device/host-kit/command')>(
  '@agent-device/host-kit/command',
);
const children = new Map<
  string,
  Array<{ launch: ReturnType<typeof runCmdDetachedMonitored>; startTime: string | null }>
>();

/** A real registration owner, advertising the caller's HTTP fixture and joining before deletion. */
export function registeredDaemonFixtureArgs(
  paths: DaemonPaths,
  fields: DaemonRegistrationFields,
  acquisitionBarrier?: string,
): string[] {
  const entry = path.join(paths.baseDir, 'dist', 'src', 'internal', 'daemon.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(path.join(paths.baseDir, 'package.json'), '{"type":"module"}');
  const registrationUrl = new URL('../../daemon-registration-owner.ts', import.meta.url).href;
  fs.writeFileSync(
    entry,
    `import fs from 'node:fs';
import path from 'node:path';
import { DAEMON_STARTUP_EXIT_CODES, tryAcquireDaemonRegistration } from ${JSON.stringify(registrationUrl)};
const paths = ${JSON.stringify(paths)};
const barrier = ${JSON.stringify(acquisitionBarrier)};
if (barrier) {
  fs.writeFileSync(barrier + '.ready-' + process.pid, 'ready');
  while (!fs.existsSync(barrier)) await new Promise(resolve => setTimeout(resolve, 10));
}
const acquired = await tryAcquireDaemonRegistration(paths);
if (acquired.status !== 'acquired') process.exit(DAEMON_STARTUP_EXIT_CODES[acquired.status]);
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
while (fs.existsSync(path.join(paths.baseDir, 'defer-publication'))) await new Promise(resolve => setTimeout(resolve, 10));
acquired.owner.publish(${JSON.stringify(fields)});
setInterval(() => {}, 1000);
`,
  );
  return ['--experimental-strip-types', entry];
}

export function spawnRegisteredDaemonFixture(
  paths: DaemonPaths,
  fields: DaemonRegistrationFields,
  options: Parameters<typeof runCmdDetachedMonitored>[2],
  acquisitionBarrier?: string,
): ReturnType<typeof runCmdDetachedMonitored> {
  const child = actualCommand.runCmdDetachedMonitored(
    process.execPath,
    registeredDaemonFixtureArgs(paths, fields, acquisitionBarrier),
    options,
  );
  const owned = children.get(paths.baseDir) ?? [];
  owned.push({ launch: child, startTime: readProcessStartTime(child.pid) });
  children.set(paths.baseDir, owned);
  return child;
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
