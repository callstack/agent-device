import type { SessionRuntimeHints } from '../kernel/contracts.ts';

export type CommandRuntimeHintInput = Pick<
  SessionRuntimeHints,
  'metroHost' | 'metroPort' | 'bundleUrl' | 'launchUrl'
>;
type CommandRuntimeHintKey = keyof CommandRuntimeHintInput;

function buildCommandRuntimeHints(hints: CommandRuntimeHintInput): SessionRuntimeHints | undefined {
  const { metroHost, metroPort, bundleUrl, launchUrl } = hints;
  if (
    metroHost === undefined &&
    metroPort === undefined &&
    bundleUrl === undefined &&
    launchUrl === undefined
  ) {
    return undefined;
  }
  return { metroHost, metroPort, bundleUrl, launchUrl };
}

export function withCommandRuntimeHints<TInput extends CommandRuntimeHintInput>(
  input: TInput,
): Omit<TInput, CommandRuntimeHintKey> & { runtime?: SessionRuntimeHints } {
  const { metroHost, metroPort, bundleUrl, launchUrl, ...rest } = input;
  const runtime = buildCommandRuntimeHints({ metroHost, metroPort, bundleUrl, launchUrl });
  return runtime ? { ...rest, runtime } : rest;
}
