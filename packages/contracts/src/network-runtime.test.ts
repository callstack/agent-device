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
  // @ts-expect-error Raw simctl argv cannot cross the Apple tool port; scope it in platform-apple.
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

async function compileTimeProviderDumpCompositionProof(dump: NetworkProviderDump): Promise<void> {
  const result: NetworkDumpResult = {
    source: 'provider',
    ...(await dump({ maxEntries: 25, include: 'summary' })),
  };
  void result;
}
void compileTimeProviderDumpCompositionProof;

test('the network runtime contract is enforced at compile time', () => {
  // `network-runtime.ts` exports no runtime code, so there is nothing here to execute. The
  // three proofs above are the file: each is a `tsc -b packages/contracts` claim. This test
  // exists because Vitest needs the file to contain one — the body it replaces was not an
  // assertion either, since it spread a fixture this file wrote and deep-equaled the result
  // against a re-spelling of the same literal.
  void compileTimeNetworkProjectionProof;
  void compileTimeCanonicalHostProof;
  void compileTimeProviderDumpCompositionProof;
});
