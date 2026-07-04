import type { CommandRequestResult } from '../../client/client-types.ts';
import type { CliOutput } from '../command-contract.ts';
import { readCommandMessage } from '../../utils/success-text.ts';
import { messageCliOutput, resultOutput, type CliOutputFormatter } from '../output-common.ts';

function getCliOutput(params: { result: CommandRequestResult; format?: string }): CliOutput {
  const data = params.result as Record<string, unknown>;
  if (params.format === 'text') {
    return { data, text: typeof data.text === 'string' ? data.text : '' };
  }
  if (params.format === 'attrs') {
    return { data, text: JSON.stringify(data.node ?? {}, null, 2) };
  }
  return defaultCommandCliOutput(data);
}

function findCliOutput(result: CommandRequestResult): CliOutput {
  const data = result as Record<string, unknown>;
  // Interactive find actions (click/fill/focus/type) carry the same success message as
  // their direct counterparts; prefer it over the raw text field fill responses include.
  const message = readCommandMessage(data);
  if (message) return { data, text: message };
  if (typeof data.text === 'string') return { data, text: data.text };
  if (typeof data.found === 'boolean') return { data, text: `Found: ${data.found}` };
  if (data.node) return { data, text: JSON.stringify(data.node, null, 2) };
  return defaultCommandCliOutput(data);
}

function isCliOutput(result: CommandRequestResult): CliOutput {
  const data = result as Record<string, unknown>;
  return { data, text: `Passed: is ${data.predicate ?? 'assertion'}` };
}

function tapCliOutput(result: CommandRequestResult): CliOutput {
  const data = result as Record<string, unknown>;
  const ref = data.ref ?? '';
  const x = data.x;
  const y = data.y;
  if (!ref || typeof x !== 'number' || typeof y !== 'number') {
    return defaultCommandCliOutput(data);
  }
  return { data, text: `Tapped @${ref} (${x}, ${y})` };
}

export const interactionCliOutputFormatters = {
  click: resultOutput(tapCliOutput),
  press: resultOutput(tapCliOutput),
  get: ({ input, result }) =>
    getCliOutput({
      result: result as CommandRequestResult,
      format: input.format as Parameters<typeof getCliOutput>[0]['format'],
    }),
  is: resultOutput(isCliOutput),
  find: resultOutput(findCliOutput),
} as const satisfies Record<string, CliOutputFormatter>;

function defaultCommandCliOutput(result: CommandRequestResult): CliOutput {
  return messageCliOutput(result as Record<string, unknown>);
}
