import type { Mock } from 'vitest';
import { resolveLocalDaemonCodeIdentity } from '@agent-device/daemon-client';
import {
  resolveDaemonPaths,
  type DaemonPaths,
} from '@agent-device/daemon-contracts/daemon-resolution';
import type { DaemonRegistrationFields } from '@agent-device/daemon-contracts/daemon-registration-owner';
import type { runCmdDetachedMonitored } from '@agent-device/host-kit/command';
import { readVersion } from '@agent-device/host-kit/version';
import {
  closeLoopbackServer,
  mkdtempForTestSync,
  startHttpDaemonFixture,
  type HttpDaemonFixture,
} from '@agent-device/test-kit';
import {
  finishRegisteredDaemonFixture,
  spawnRegisteredDaemonFixture,
  waitForRegisteredDaemonFixture,
} from './registered-daemon-fixture.ts';

// A real child that owns a daemon registration and advertises a loopback HTTP stand-in, for root
// tests that drive the client, the CLI or MCP through their real daemon resolution.

export type RegisteredHttpDaemon = {
  stateDir: string;
  paths: DaemonPaths;
  /** The stand-in the registration advertises; it records every request it answers. */
  stub: HttpDaemonFixture;
  /** The commands of the requests the stand-in answered, in order. */
  commands: () => string[];
  close: () => Promise<void>;
};

async function registrationFor(httpPort: number): Promise<DaemonRegistrationFields> {
  const identity = await resolveLocalDaemonCodeIdentity();
  return {
    httpPort,
    token: 'local-secret',
    version: readVersion(),
    ...(identity.origin === 'checkout'
      ? { codeOrigin: 'checkout' as const, codeSignature: identity.codeSignature }
      : { codeOrigin: 'installed' as const }),
    capabilities: ['quiesce'],
  };
}

export function stateDirAndPaths(): { stateDir: string; paths: DaemonPaths } {
  const stateDir = mkdtempForTestSync('agent-device-registered-http-daemon-');
  return { stateDir, paths: resolveDaemonPaths(stateDir) };
}

/** A daemon already running on its own state directory. */
export async function startRegisteredHttpDaemon(): Promise<RegisteredHttpDaemon> {
  const { stateDir, paths } = stateDirAndPaths();
  const stub = await startHttpDaemonFixture({ devices: [] });
  try {
    const child = spawnRegisteredDaemonFixture(paths, await registrationFor(stub.port), undefined);
    await waitForRegisteredDaemonFixture(paths, child);
  } catch (error) {
    // Both teardown steps run, and neither failure replaces the startup error.
    await Promise.allSettled([
      finishRegisteredDaemonFixture(stateDir),
      closeLoopbackServer(stub.server),
    ]);
    throw error;
  }
  return {
    stateDir,
    paths,
    stub,
    commands: () => stub.rpcRequests.map((rpc) => String(rpc.params?.command)),
    close: async () => {
      await finishRegisteredDaemonFixture(stateDir);
      await closeLoopbackServer(stub.server);
    },
  };
}

/**
 * Answers the daemon launch seam with a child that registers and advertises a stand-in, so a start
 * the client performs yields a daemon it can reach.
 */
export async function launchesFreshHttpDaemon(
  spawn: Mock<typeof runCmdDetachedMonitored>,
  paths: DaemonPaths,
): Promise<{ stub: HttpDaemonFixture; commands: () => string[]; close: () => Promise<void> }> {
  const stub = await startHttpDaemonFixture({ devices: [] });
  let fields: DaemonRegistrationFields;
  try {
    fields = await registrationFor(stub.port);
  } catch (error) {
    await Promise.allSettled([closeLoopbackServer(stub.server)]);
    throw error;
  }
  spawn.mockImplementation((_command, _args, options) =>
    spawnRegisteredDaemonFixture(paths, fields, options),
  );
  return {
    stub,
    commands: () => stub.rpcRequests.map((rpc) => String(rpc.params?.command)),
    close: async () => {
      await finishRegisteredDaemonFixture(paths.baseDir);
      await closeLoopbackServer(stub.server);
    },
  };
}
