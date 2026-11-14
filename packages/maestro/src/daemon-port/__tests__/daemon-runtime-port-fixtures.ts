import { runCmd, withCommandHost } from '@agent-device/host-kit/command';
import { createTestHostEnvironment } from '@agent-device/test-kit';
import {
  emitDiagnostic,
  registerDiagnosticSensitiveValue,
} from '@agent-device/host-kit/diagnostics';
import type { CommandFlags } from '@agent-device/contracts/command';
import { formatRole } from '@agent-device/kernel/snapshot';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import type { SnapshotState } from '@agent-device/contracts/snapshot-model';
import type { MaestroSourceReader } from '@agent-device/maestro';
import type { CreateDaemonMaestroRuntimeOperationsOptions } from '../daemon-runtime-port.ts';

export function makeSnapshot(
  nodes: Array<Omit<SnapshotNode, 'ref' | 'kind'> & { ref?: string; kind?: string }>,
): SnapshotState {
  return {
    createdAt: 0,
    nodes: nodes.map((node) => ({
      ref: `e${node.index + 1}`,
      kind: formatRole(node.type ?? 'Element'),
      ...node,
    })),
  };
}

/** The daemon-owned half of the port options: the runtime envelope flags and the network origin. */
export function makeRuntimeEnvelope(
  overrides: { flags?: CommandFlags; publicNetworkOnly?: boolean } = {},
): Pick<
  CreateDaemonMaestroRuntimeOperationsOptions,
  | 'flags'
  | 'publicNetworkOnly'
  | 'host'
  | 'registerSensitiveValue'
  | 'emitDiagnostic'
  | 'runCommand'
> {
  return {
    host: createTestHostEnvironment(),
    emitDiagnostic,
    runCommand: ({ executable, args, host, ...options }, signal) =>
      withCommandHost({ host, requestEnv: undefined }, () =>
        runCmd(executable, args, { ...options, ...host, signal }),
      ),
    registerSensitiveValue: registerDiagnosticSensitiveValue,
    publicNetworkOnly: false,
    ...overrides,
  };
}

export function makeDependencies(
  now: { value: number } = { value: 0 },
): CreateDaemonMaestroRuntimeOperationsOptions['dependencies'] {
  return {
    now: () => now.value,
    sleep: async (milliseconds) => {
      now.value += milliseconds;
    },
  };
}

/**
 * `readSource` for a flow that declares no `runFlow` includes: the engine must
 * never reach for one, so a call here means the fixture drifted rather than a
 * missing file.
 */
export const noMaestroIncludeSources: MaestroSourceReader = (resolvedPath) => {
  throw new Error(`unexpected Maestro include read: ${resolvedPath}`);
};
