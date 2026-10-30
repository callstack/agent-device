import { AppError } from '@agent-device/kernel/errors';
import type { AgentDeviceRuntimeConfig } from '@agent-device/contracts/runtime-contract';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';
import type {
  RecordingContactSheetCommandOptions,
  RecordingContactSheetCommandResult,
} from '@agent-device/command-runtime';
import { resolveUserPath } from '@agent-device/host-kit/file';
import { writeCommandOutput } from './shared.ts';
import type { ClientCommandHandler } from './router-types.ts';

/** The `record` action that reads a finished file locally instead of asking a device for anything. */
const CONTACT_SHEET_ACTION = 'contact-sheet';

export const recordingCommand: ClientCommandHandler = async ({ positionals, flags, host }) => {
  if (positionals[0] !== CONTACT_SHEET_ACTION) return false;
  if (positionals.length > 2) {
    throw new AppError(
      'INVALID_ARGS',
      'record contact-sheet accepts one recording path: record contact-sheet <video.mp4> [--out <sheet.png>]',
    );
  }

  const recordingPath = resolveUserPath(readRequiredPositional(positionals[1]), {
    cwd: host.cwd,
  });
  const outputPath =
    typeof flags.out === 'string' ? resolveUserPath(flags.out, { cwd: host.cwd }) : undefined;

  // The package has one entry, so importing it evaluates the capture, selector and interaction
  // bindings; the contact-sheet wrapper then loads the full runtime on demand.
  const [{ executeRecordingContactSheet }, { createLocalArtifactAdapter }] = await Promise.all([
    import('@agent-device/command-runtime'),
    import('../../io.ts'),
  ]);
  const config: AgentDeviceRuntimeConfig = {
    backend: { platform: 'ios' },
    artifacts: createLocalArtifactAdapter({ cwd: host.cwd }),
    sessions: {
      get: (name) => ({ name }),
      set: () => {},
    },
    policy: localCommandPolicy(),
  };

  const options: RecordingContactSheetCommandOptions = {
    host,
    video: { kind: 'path', path: recordingPath },
    ...(outputPath ? { out: { kind: 'path', path: outputPath } } : {}),
  };
  const result = await executeRecordingContactSheet(config, options);

  await writeCommandOutput(flags, result, () => formatContactSheetSummary(result));
  return true;
};

function readRequiredPositional(value: string | undefined): string {
  if (value) return value;
  throw new AppError(
    'INVALID_ARGS',
    'record contact-sheet requires a recording path: record contact-sheet <video.mp4>',
  );
}

/**
 * Leads with the path so a caller can capture it the way it captures `record stop`, then says how
 * much of the recording the sheet actually covers — a full grid is not the same claim as a review.
 */
function formatContactSheetSummary(result: RecordingContactSheetCommandResult): string {
  const seconds = (result.durationMs / 1000).toFixed(result.durationMs % 1000 === 0 ? 0 : 1);
  const lines = [
    result.path,
    `${result.cells.length} cells over ${seconds}s ` +
      `(${result.sampledFrameCount} sample times, ${result.decodedFrameCount} frames decoded)`,
  ];
  return result.warning ? [...lines, result.warning].join('\n') : lines.join('\n');
}
