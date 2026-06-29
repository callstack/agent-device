import { formatScreenshotDiffText, formatSnapshotDiffText } from '../../utils/output.ts';
import { AppError } from '../../kernel/errors.ts';
import { resolveUserPath } from '../../utils/path-resolution.ts';
import type { AgentDeviceBackend } from '../../backend.ts';
import type { AgentDeviceClient, CaptureScreenshotResult } from '../../client.ts';
import { createLocalArtifactAdapter } from '../../io.ts';
import { createAgentDevice, localCommandPolicy } from '../../runtime.ts';
import { runCliCommand } from '../../commands/cli-runner.ts';
import type { CliFlags } from '../../utils/cli-flags.ts';
import { writeCommandOutput } from './shared.ts';
import type { ClientCommandHandler } from './router-types.ts';

export const screenshotCommand: ClientCommandHandler = async ({ positionals, flags, client }) => {
  const result = (await runCliCommand({
    client,
    command: 'screenshot',
    positionals,
    flags,
  })) as CaptureScreenshotResult;
  const data = {
    path: result.path,
    ...(result.overlayRefs ? { overlayRefs: result.overlayRefs } : {}),
  };
  writeCommandOutput(flags, data, () =>
    result.overlayRefs
      ? `Annotated ${result.overlayRefs.length} refs onto ${result.path}`
      : result.path,
  );
  return true;
};

export const diffCommand: ClientCommandHandler = async ({ positionals, flags, client }) => {
  if (positionals[0] === 'snapshot') {
    const result = await runCliCommand({ client, command: 'diff', positionals, flags });
    writeCommandOutput(flags, result, () => formatSnapshotDiffText(result));
    return true;
  }

  if (positionals[0] !== 'screenshot') return false;

  const baselineRaw = flags.baseline;
  if (!baselineRaw || typeof baselineRaw !== 'string') {
    throw new AppError('INVALID_ARGS', 'diff screenshot requires --baseline <path>');
  }

  const baselinePath = resolveUserPath(baselineRaw);
  const outputPath = typeof flags.out === 'string' ? resolveUserPath(flags.out) : undefined;
  const currentRaw = positionals[1];
  if (positionals.length > 2) {
    throw new AppError(
      'INVALID_ARGS',
      'diff screenshot accepts at most one current screenshot path',
    );
  }

  const runtime = createAgentDevice({
    backend: createClientScreenshotBackend(client, flags),
    artifacts: createLocalArtifactAdapter(),
    sessions: {
      get: (name) => ({ name }),
      set: () => {},
    },
    policy: localCommandPolicy(),
  });

  const result = await runtime.capture.diffScreenshot({
    session: flags.session,
    baseline: { kind: 'path', path: baselinePath },
    current: currentRaw ? { kind: 'path', path: resolveUserPath(currentRaw) } : { kind: 'live' },
    ...(outputPath ? { out: { kind: 'path', path: outputPath } } : {}),
    threshold: parseCliThreshold(flags.threshold),
    overlayRefs: flags.overlayRefs,
    normalizeStatusBar: flags.screenshotNormalizeStatusBar,
    surface: flags.surface,
  });

  writeCommandOutput(flags, result, () => formatScreenshotDiffText(result));
  return true;
};

function createClientScreenshotBackend(
  client: AgentDeviceClient,
  flags: CliFlags,
): AgentDeviceBackend {
  return {
    platform: resolveClientBackendPlatform(flags),
    captureScreenshot: async (context, outPath, options) => {
      const result = await client.capture.screenshot({
        path: outPath,
        session: context.session,
        overlayRefs: options?.overlayRefs,
        fullscreen: options?.fullscreen,
        normalizeStatusBar: options?.normalizeStatusBar,
        stabilize: options?.stabilize,
        surface: options?.surface,
      });
      return {
        path: result.path,
        ...(result.overlayRefs ? { overlayRefs: result.overlayRefs } : {}),
      };
    },
  };
}

function resolveClientBackendPlatform(flags: CliFlags): AgentDeviceBackend['platform'] {
  switch (flags.platform) {
    case 'android':
    case 'linux':
    case 'macos':
      return flags.platform;
    case 'ios':
    case 'apple':
    default:
      return 'ios';
  }
}

function parseCliThreshold(threshold: string | undefined): number | undefined {
  if (threshold == null || threshold === '') return undefined;
  return Number(threshold);
}
