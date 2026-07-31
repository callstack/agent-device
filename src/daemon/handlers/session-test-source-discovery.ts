import fs from 'node:fs';
import { inspectMaestroFlow } from '@agent-device/maestro';
import { resolveReplayFormat } from '../../replay/format.ts';
import { readReplayScriptMetadata } from '../../replay/script.ts';
import { discoverReplaySourcePaths } from '../replay-source-discovery.ts';
import type {
  ReplayTestDiscoverSources,
  ReplayTestManifest,
  ReplayTestSource,
} from '@agent-device/replay-test';

/**
 * The daemon adapter's source-inspection capability (#1478 P3b).
 *
 * Path expansion, file reading, format routing, and per-engine inspection live here; the
 * scheduler receives neutral manifests and keeps discovery policy.
 *
 * This is the one place that knows a source can be `.ad` or Maestro. That knowledge converts
 * into the manifest's platform tag and then disappears: `caller-bound` is what Maestro looks
 * like from the scheduler's side, and nothing downstream can recover the format from it.
 */
export function buildReplayTestSourceDiscovery(
  replayBackend: string | undefined,
): ReplayTestDiscoverSources {
  return ({ inputs, cwd }) => {
    const resolvedCwd = cwd ?? process.cwd();
    const filePaths = discoverReplaySourcePaths({ inputs, cwd: resolvedCwd, replayBackend });
    return filePaths.map((filePath) => inspectReplayTestSource(filePath, replayBackend));
  };
}

function inspectReplayTestSource(
  filePath: string,
  replayBackend: string | undefined,
): ReplayTestSource {
  const script = fs.readFileSync(filePath, 'utf8');
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
