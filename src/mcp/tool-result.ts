import { formatCliOutput } from '../commands/cli-output.ts';
import type { CommandName } from '../commands/command-metadata.ts';

export function projectStructuredContent(
  name: CommandName,
  input: unknown,
  result: unknown,
): Record<string, unknown> {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  const projected = formatCliOutput({ name, input, result })?.data;
  if (projected && typeof projected === 'object' && !Array.isArray(projected)) {
    return projected as Record<string, unknown>;
  }
  return { result };
}
