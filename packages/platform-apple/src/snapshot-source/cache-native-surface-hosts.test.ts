import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { runCmd } from '@agent-device/host-kit/command';
import { mkdtempForTest } from '../__tests__/tmp-dir.ts';
import { BUILD_TIMEOUT_MS } from './cache.ts';

// The bridge guest refuses a capture while a registered system surface host runs for the Simulator,
// because the bridge serves the occluded app tree under a sheet (#2438). The scan reads the process
// table in place (#2751), so these cases run it against real decoy processes: a host binary is
// matched by its executable path, and only SIMULATOR_UDID places it on a device.
const COMPILE_HOOK_TIMEOUT_MS = BUILD_TIMEOUT_MS + 30_000;
const SIMULATOR = 'FIXTURE-SIMULATOR-A';

/**
 * A host binary that stays up, or, as `zombie-parent <host>`, starts `<host>`, lets it exit, and
 * keeps it unreaped: `WNOWAIT` observes the exit and leaves the zombie in the process table.
 */
const DECOY_SOURCE = `#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;
int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "exit") == 0) return 0;
  if (argc == 3 && strcmp(argv[1], "zombie-parent") == 0) {
    char *args[] = {argv[2], "exit", NULL};
    pid_t child;
    if (posix_spawn(&child, argv[2], NULL, NULL, args, environ) != 0) return 1;
    siginfo_t info;
    if (waitid(P_PID, (id_t)child, &info, WEXITED | WNOWAIT) != 0) return 1;
    printf("zombie\\n");
    fflush(stdout);
  }
  pause();
  return 0;
}
`;

describe.skipIf(process.platform !== 'darwin')('surface host scan', () => {
  let root: string;
  let scanner: string;
  let decoyBinary: string;
  const decoys: ChildProcess[] = [];

  beforeAll(async () => {
    root = await mkdtempForTest('snapshot-surface-hosts-');
    scanner = path.join(root, 'surface-hosts');
    const nativeRoot = path.resolve(import.meta.dirname, '../../../../apple/snapshot-bridge');
    const compiled = await runCmd(
      'xcrun',
      [
        '--sdk',
        'macosx',
        'clang',
        '-fobjc-arc',
        '-Wall',
        '-Wextra',
        '-framework',
        'Foundation',
        '-I',
        nativeRoot,
        path.join(nativeRoot, 'SnapshotBridgeSurfaceHosts.m'),
        path.join(import.meta.dirname, 'fixtures/surface-hosts.m'),
        '-o',
        scanner,
      ],
      { allowFailure: true, timeoutMs: BUILD_TIMEOUT_MS },
    );
    assert.equal(compiled.exitCode, 0, compiled.stderr);
    // A copied system binary is killed at launch, so the decoy host is a binary of our own.
    const decoySource = path.join(root, 'decoy.c');
    await writeFile(decoySource, DECOY_SOURCE);
    decoyBinary = path.join(root, 'decoy');
    const decoy = await runCmd(
      'xcrun',
      ['--sdk', 'macosx', 'clang', decoySource, '-o', decoyBinary],
      { allowFailure: true, timeoutMs: BUILD_TIMEOUT_MS },
    );
    assert.equal(decoy.exitCode, 0, decoy.stderr);
  }, COMPILE_HOOK_TIMEOUT_MS);

  afterAll(() => {
    for (const decoy of decoys) decoy.kill('SIGKILL');
  });

  /**
   * Starts a host binary named longer than the kernel's 16-character process name, as
   * `SafariViewService` is, and returns the executable fragment the registry would name. An
   * `exited` host is left as a zombie under a parent that stays up. `binary` places the started
   * binary elsewhere than the fragment names.
   */
  async function startDecoy(
    env: NodeJS.ProcessEnv | ((name: string) => NodeJS.ProcessEnv),
    state: 'live' | 'exited' = 'live',
    binary: (name: string) => string = (name) => `${name}.app/${name}`,
  ) {
    const name = `SurfaceHost${randomBytes(4).toString('hex')}`;
    const executable = path.join(root, binary(name));
    await mkdir(path.dirname(executable), { recursive: true });
    const decoyEnv = typeof env === 'function' ? env(name) : env;
    await copyFile(decoyBinary, executable);
    const decoy =
      state === 'live'
        ? spawn(executable, ['decoy-argument'], { env: decoyEnv, stdio: 'ignore' })
        : spawn(decoyBinary, ['zombie-parent', executable], {
            env: decoyEnv,
            stdio: ['ignore', 'pipe', 'ignore'],
          });
    decoys.push(decoy);
    await new Promise<void>((resolve, reject) => {
      if (state === 'live') decoy.once('spawn', resolve);
      else decoy.stdout!.once('data', () => resolve());
      decoy.once('error', reject);
      decoy.once('exit', () => reject(new Error('decoy exited before the scan')));
    });
    return `${name}.app/${name}`;
  }

  async function scan(executable: string, simulator: string): Promise<string> {
    const result = await runCmd(scanner, [executable, simulator], { timeoutMs: 10_000 });
    // A decoy that died reads as exited, which would pass a case for the wrong reason.
    for (const decoy of decoys) assert.equal(decoy.exitCode ?? decoy.signalCode, null);
    return result.stdout.trim();
  }

  test('a host process scoped to the Simulator is present, and absent for another one', async () => {
    const executable = await startDecoy({ SIMULATOR_UDID: SIMULATOR });

    assert.equal(await scan(executable, SIMULATOR), 'present');
    assert.equal(await scan(executable, 'FIXTURE-SIMULATOR-B'), 'absent');
  });

  test('a host process without a Simulator scope is unverified, never absent', async () => {
    const executable = await startDecoy({});

    assert.equal(await scan(executable, SIMULATOR), 'unverified');
  });

  // A process is unplaceable for good only while it lives; an exited host keeps no arguments. Reading
  // one as unverified would send every warm capture on the Mac to XCTest for as long as its zombie
  // lingered. `processExited` reads the failed argument read of a zombie as absent; the same guard
  // covers a host that vanished from the table between the scan and that read.
  test('processExited reads a zombie host for another Simulator as absent, not unverified', async () => {
    const executable = await startDecoy({ SIMULATOR_UDID: 'FIXTURE-SIMULATOR-B' }, 'exited');

    assert.equal(await scan(executable, SIMULATOR), 'absent');
  });

  // The fragment must end the executable path at a component: a sibling binary in the host's bundle
  // shares the kernel's 16-character process name and contains the fragment, but it is not the host.
  test('a sibling binary in the host bundle is not the host', async () => {
    const executable = await startDecoy({ SIMULATOR_UDID: SIMULATOR }, 'live', (name) =>
      path.join(`${name}.app`, `${name}Helper`),
    );

    assert.equal(await scan(executable, SIMULATOR), 'absent');
  });

  // Only the executable path names the binary: the fragment in an environment value is not a match,
  // even for a process whose kernel process name matches the host's.
  test('the host fragment in an environment value is not the executable path', async () => {
    const executable = await startDecoy(
      (name) => ({ SIMULATOR_UDID: SIMULATOR, DECOY_PATH: `/${name}.app/${name}` }),
      'live',
      (name) => path.join('Other.app', `${name}Helper`),
    );

    assert.equal(await scan(executable, SIMULATOR), 'absent');
  });

  test('no process of the host executable is absent', async () => {
    assert.equal(await scan('SurfaceHostMissing.app/SurfaceHostMissing', SIMULATOR), 'absent');
  });
});
