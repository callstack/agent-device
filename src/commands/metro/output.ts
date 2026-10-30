import type { CommandName } from '@agent-device/command-surface';
import type { CliOutputFormatter, CliOutput } from '../output-common.ts';

function metroCliOutput(params: { result: unknown; action?: string }): CliOutput {
  return {
    data: params.result,
    text:
      params.action === 'reload'
        ? `Reloaded React Native apps via ${(params.result as { reloadUrl?: unknown }).reloadUrl}`
        : JSON.stringify(params.result, null, 2),
  };
}

export const metroCliOutputFormatters = {
  metro: ({ input, result }) =>
    metroCliOutput({ result, action: input.action as string | undefined }),
} as const satisfies Partial<Record<CommandName, CliOutputFormatter>>;
