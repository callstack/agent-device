import type { HostEnvironment, EnvMap } from '@agent-device/kernel/source-value';
import type { ScreenshotDiffResult } from '@agent-device/capture-kit/screenshot-diff';
import type { ColorStream } from './output/color.ts';
import type { CliOutput } from './output-common.ts';
import type { FormatCliOutputParams } from './cli-output.ts';

export type { CliOutput, CommandProgressState } from './output-common.ts';
export {
  collapseWarningText,
  responseWarningRoute,
  routeResponseWarnings,
} from './output-common.ts';
export { colorize, supportsColor } from './output/color.ts';
export { formatErrorCandidateViews, formatHumanErrorLines } from './output/error.ts';
export { formatDeliveredArtifactLines, serializeDevice } from './output/result-serialization.ts';

/** Renders a command's result through the family formatters; the formatter tables load on first call. */
export async function formatCliOutput(
  params: FormatCliOutputParams,
): Promise<CliOutput | undefined> {
  const { dispatchCliOutput } = await import('./cli-output.ts');
  return dispatchCliOutput(params);
}

export async function formatSnapshotDiffText(
  data: Record<string, unknown>,
  env: EnvMap,
  stdout: ColorStream,
): Promise<string> {
  const { formatSnapshotDiffText: format } = await import('./output/diff.ts');
  return format(data, env, stdout);
}

export async function formatScreenshotDiffText(
  data: ScreenshotDiffResult,
  host: HostEnvironment,
  stdout: ColorStream,
): Promise<string> {
  const { formatScreenshotDiffText: format } = await import('./output/diff.ts');
  return format(data, host, stdout);
}
