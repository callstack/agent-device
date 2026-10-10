import type { ReplayScriptSourceBundle } from '@agent-device/contracts/replay';
import {
  isReplayBackendId,
  readReplayScriptMetadata,
  resolveReplayFormat,
} from '@agent-device/ad-script';
import { readReplayScriptSourceFile } from '@agent-device/replay-port/script-source';
import type {
  ReplayTestDiscoverSources,
  ReplayTestManifest,
  ReplayTestSource,
} from '@agent-device/replay-test';
import { getReplayBackend, type ReplayBackend } from './replay-backend-registry.ts';

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
 * #3377: a backend-formatted source is inspected through the backend registry, not by naming the
 * engine package. The backend resolves once for the whole suite — the flag is suite-wide, so a
 * run whose sources are all native never loads one.
 *
 * This is the one place that knows a source can be `.ad` or a backend format. That knowledge
 * converts into the manifest's platform tag and then disappears: `caller-bound` is what a backend
 * flow looks like from the scheduler's side, and nothing downstream can recover the format from it.
 */
export async function buildReplayTestSourceDiscovery(
  sources: readonly ReplayScriptSourceBundle[],
  replayBackend: string | undefined,
): Promise<ReplayTestDiscoverSources> {
  const backend: ReplayBackend | undefined = isReplayBackendId(replayBackend)
    ? await getReplayBackend(replayBackend)
    : undefined;
  return () => sources.map((bundle) => inspectReplayTestSource(bundle, replayBackend, backend));
}

function inspectReplayTestSource(
  bundle: ReplayScriptSourceBundle,
  replayBackend: string | undefined,
  backend: ReplayBackend | undefined,
): ReplayTestSource {
  const filePath = bundle.entry;
  const script = readReplayScriptSourceFile(bundle, filePath);
  const isBackendSource = resolveReplayFormat(filePath, replayBackend) !== 'ad';
  const metadata = readReplayScriptMetadata(script);
  const manifest: ReplayTestManifest = {
    ...(isBackendSource ? { title: backend?.inspectSource(script, filePath).title } : {}),
    device: {
      // A declared platform wins for either format. Without one, a backend flow takes its
      // platform from the invocation (`caller-bound`) while a native source has simply declared
      // none (`unspecified`) — which is exactly the distinction the old
      // `resolveReplayFormat(...) === 'maestro'` branch was making inside the filter.
      platform: metadata.platform
        ? { kind: 'declared', value: metadata.platform }
        : isBackendSource
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
