import { inspectMaestroFlow } from '@agent-device/maestro';
import type { ReplayScriptSourceBundle } from '@agent-device/contracts/replay';
import { readReplayScriptMetadata, resolveReplayFormat } from '@agent-device/ad-script';
import { readReplayScriptSourceFile } from '../../replay/script-source-bundle.ts';
import type {
  ReplayTestDiscoverSources,
  ReplayTestManifest,
  ReplayTestSource,
} from '@agent-device/replay-test';

/**
 * The daemon adapter's source-inspection capability (#1478 P3b).
 *
 * Format routing and per-engine inspection live here; the scheduler receives neutral manifests
 * and keeps discovery policy.
 *
 * #1802: path expansion and file reading are no longer part of this. `test <path-or-glob>` names
 * files on the CALLER's filesystem, so the caller expands its inputs and ships one replay script
 * source bundle per discovered source; this capability inspects those bundles in the order they
 * arrived and opens nothing.
 *
 * This is the one place that knows a source can be `.ad` or Maestro. That knowledge converts
 * into the manifest's platform tag and then disappears: `caller-bound` is what Maestro looks
 * like from the scheduler's side, and nothing downstream can recover the format from it.
 */
export function buildReplayTestSourceDiscovery(
  sources: readonly ReplayScriptSourceBundle[],
  replayBackend: string | undefined,
): ReplayTestDiscoverSources {
  return () => sources.map((bundle) => inspectReplayTestSource(bundle, replayBackend));
}

function inspectReplayTestSource(
  bundle: ReplayScriptSourceBundle,
  replayBackend: string | undefined,
): ReplayTestSource {
  const filePath = bundle.entry;
  const script = readReplayScriptSourceFile(bundle, filePath);
  const isMaestro = resolveReplayFormat(filePath, replayBackend) === 'maestro';
  const metadata = readReplayScriptMetadata(script);
  const manifest: ReplayTestManifest = {
    ...(isMaestro ? { title: inspectMaestroFlow(script, filePath).name } : {}),
    device: {
      // A declared platform wins for either format. Without one, Maestro takes its platform
      // from the invocation (`caller-bound`) while a native source has simply declared none
      // (`unspecified`) — which is exactly the distinction the old
      // `resolveReplayFormat(...) === 'maestro'` branch was making inside the filter.
      platform: metadata.platform
        ? { kind: 'declared', value: metadata.platform }
        : isMaestro
          ? { kind: 'caller-bound' }
          : { kind: 'unspecified' },
      ...(metadata.target !== undefined ? { target: metadata.target } : {}),
    },
    ...(metadata.timeoutMs !== undefined || metadata.retries !== undefined
      ? {
          attemptDefaults: {
            ...(metadata.timeoutMs !== undefined ? { timeoutMs: metadata.timeoutMs } : {}),
            ...(metadata.retries !== undefined ? { retries: metadata.retries } : {}),
          },
        }
      : {}),
  };
  return { path: filePath, manifest };
}
