import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { BoundDeviceRuntime } from './platform-runtime.ts';
import { networkDumpUse } from './network-runtime-plan.ts';
import type {
  NetworkDumpResult,
  NetworkProviderDump,
  NetworkRuntimeHost,
} from './network-runtime.ts';

function compileTimeNetworkProjectionProof(
  runtime: BoundDeviceRuntime<typeof networkDumpUse>,
): void {
  const dump = runtime.operations.networkDump;
  void dump;
  // @ts-expect-error A sibling app-log operation cannot cross the network projection.
  void runtime.operations.appLogInspect;
  // @ts-expect-error The selected handler projection does not own the binding lifetime.
  void runtime[Symbol.asyncDispose];
}
void compileTimeNetworkProjectionProof;

function compileTimeCanonicalHostProof(host: NetworkRuntimeHost): void {
  void host.appleTools.run({ tool: 'simctl', args: ['spawn', 'sim-1', 'log', 'show'] });
  void host.appleTools.run({
    tool: 'simctl',
    // @ts-expect-error The focused Apple port cannot execute an arbitrary binary.
    executable: 'xcrun',
    args: ['simctl', 'list'],
  });
  void host.appLogs.readRecent('session-id', 4000);
  void host.appLogs.readProcessMarker('session-id');
  // @ts-expect-error Callers cannot supply an arbitrary app-log path.
  void host.appLogs.readRecent('/tmp/untrusted.log', 4000, '/tmp/marker');
}
void compileTimeCanonicalHostProof;

test('provider transport treats an empty dump as supported success', async () => {
  const dump: NetworkProviderDump = async () => ({
    backend: 'browserstack',
    entries: [],
    notes: ['No matching provider traffic was recorded.'],
  });
  const result: NetworkDumpResult = {
    source: 'provider',
    ...(await dump({ maxEntries: 25, include: 'summary' })),
  };

  assert.deepEqual(result, {
    source: 'provider',
    backend: 'browserstack',
    entries: [],
    notes: ['No matching provider traffic was recorded.'],
  });
});
