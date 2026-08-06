import type { CommandRequestResult } from '@agent-device/contracts/client';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import type { CliOutput } from '../command-contract.ts';
import { displayLabel, formatRole } from '../../snapshot/snapshot-lines.ts';
import { readCommandMessage } from '../../utils/success-text.ts';
import {
  messageCliOutput,
  pinnedRefText,
  resultOutput,
  type CliOutputFormatter,
} from '../output-common.ts';
import { appendResponseNotes, messageWithSettleOutput } from '../settle-output.ts';

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
  if (Array.isArray(data.matches)) {
    return { data, text: formatFindMatchLines(data.matches, data.refsGeneration) };
  }
  // A read-only find that returns a reusable ref renders it pinned (ADR 0014).
  const pinned = pinnedRefText(data.ref, data.refsGeneration);
  if (pinned) return { data, text: `Found: ${pinned}` };
  if (typeof data.found === 'boolean') return { data, text: `Found: ${data.found}` };
  if (data.node) return { data, text: JSON.stringify(data.node, null, 2) };
  return defaultCommandCliOutput(data);
}

type FindMatchView = { ref?: string; node?: SnapshotNode };

// `find … list` (#1625): every match on its own line with a pinned, paste-ready
// ref (ADR 0014) — the whole point of list is that ANY listed ref can drive the
// next command, so no line may render a bare `@eN` the daemon would reject.
// Role/label display goes through the snapshot-line normalizers so a list line
// reads exactly like the snapshot line for the same node on every platform.
function formatFindMatchLines(matches: unknown[], refsGeneration: unknown): string {
  const heading = `${matches.length} match${matches.length === 1 ? '' : 'es'}:`;
  const lines = matches.map((entry) => formatFindMatchLine(entry as FindMatchView, refsGeneration));
  return [heading, ...lines].join('\n');
}

function formatFindMatchLine(view: FindMatchView, refsGeneration: unknown): string {
  const plain = view.ref ?? '';
  const body = plain.startsWith('@') ? plain.slice(1) : plain;
  const ref = pinnedRefText(plain, refsGeneration) ?? `@${body}`;
  const role = formatRole(view.node?.type ?? 'Element');
  const label = view.node ? displayLabel(view.node, role) : '';
  return `= ${ref} [${role}]${label ? ` "${label}"` : ''}`;
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
    const output = defaultCommandCliOutput(data);
    return { data: output.data, text: appendResponseNotes(output.text, data) };
  }
  return { data, text: appendResponseNotes(`Tapped @${ref} (${x}, ${y})`, data) };
}

export const interactionCliOutputFormatters = {
  click: resultOutput(tapCliOutput),
  press: resultOutput(tapCliOutput),
  fill: messageWithSettleOutput,
  longpress: messageWithSettleOutput,
  scroll: messageWithSettleOutput,
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
