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

// ADR 0014: a reusable ref in a PARTIAL result renders in ready-to-copy
// `@eN~s<refsGeneration>` form so a human CLI caller can paste it into the next
// mutation without a separate pin step. A mutating result carries no
// `refsGeneration`, so its acted ref is never pinned.
function pinnedRefText(ref: unknown, refsGeneration: unknown): string | undefined {
  if (typeof ref !== 'string' || ref.length === 0) return undefined;
  if (typeof refsGeneration !== 'number') return undefined;
  const body = ref.startsWith('@') ? ref.slice(1) : ref;
  return `@${body}~s${refsGeneration}`;
}

function findCliOutput(result: CommandRequestResult): CliOutput {
  const data = result as Record<string, unknown>;
  // Interactive find actions (click/fill/focus/type) carry the same success message as
  // their direct counterparts; prefer it over the raw text field fill responses include.
  const message = readCommandMessage(data);
  if (message) return { data, text: message };
  if (typeof data.text === 'string') return { data, text: data.text };
  // A read-only find that returns a reusable ref renders it pinned (ADR 0014).
  const pinned = pinnedRefText(data.ref, data.refsGeneration);
  if (pinned) return { data, text: `Found: ${pinned}` };
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
    const output = defaultCommandCliOutput(data);
    return { data: output.data, text: appendSettleText(output.text, data.settle) };
  }
  return { data, text: appendSettleText(`Tapped @${ref} (${x}, ${y})`, data.settle) };
}

function messageWithSettleCliOutput(result: CommandRequestResult): CliOutput {
  const data = result as Record<string, unknown>;
  const output = defaultCommandCliOutput(data);
  return { data: output.data, text: appendSettleText(output.text, data.settle) };
}

function appendSettleText(text: string | null | undefined, settle: unknown): string {
  return `${text ?? ''}${formatSettleText(settle)}`;
}

type SettleTextView = {
  settled?: boolean;
  waitedMs?: number;
  hint?: string;
  diff?: {
    summary?: { additions?: number; removals?: number; unchanged?: number };
    lines?: Array<{ kind?: string; text?: string }>;
    truncated?: boolean;
  };
  tail?: Array<{ ref?: string; role?: string; label?: string }>;
  tailTruncated?: boolean;
  refsGeneration?: number;
};

/**
 * Compact `--settle` (#1101) rendering appended to the tap line: the verdict,
 * the changed-count summary, and the changed lines themselves (the payload the
 * agent acts on). Empty for non-settle responses.
 */
function formatSettleText(settle: unknown): string {
  if (!settle || typeof settle !== 'object') return '';
  const view = settle as SettleTextView;
  const parts = [
    formatSettleVerdict(view),
    ...formatSettleDiffLines(view.diff),
    ...formatSettleTailLines(view),
  ];
  if (view.hint) parts.push(`hint: ${view.hint}`);
  return `\n${parts.join('\n')}`;
}

function formatSettleDiffLines(diff: SettleTextView['diff']): string[] {
  const lines = (diff?.lines ?? []).map(
    (line) => `${line.kind === 'removed' ? '-' : '+'} ${line.text ?? ''}`,
  );
  if (diff?.truncated) lines.push('… changed lines truncated');
  return lines;
}

// Unchanged interactive tail: only present when the diff's added lines
// carried zero refs (modal-dismiss/toast-only diff), so the settled tree's
// remaining actionable elements would otherwise be invisible.
function formatSettleTailLines(view: SettleTextView): string[] {
  const tail = view.tail ?? [];
  if (tail.length === 0) return [];
  const lines = [`unchanged interactive (${tail.length}):`];
  for (const entry of tail) {
    const label = entry.label ? ` "${entry.label}"` : '';
    // ADR 0014: the settled tail refs are reusable, so render them pinned when
    // the settle response carried its generation.
    const ref = pinnedRefText(entry.ref, view.refsGeneration) ?? `@${entry.ref ?? ''}`;
    lines.push(`= ${ref} [${entry.role ?? ''}]${label}`);
  }
  if (view.tailTruncated) {
    lines.push('… more interactive elements not shown, use snapshot -i');
  }
  return lines;
}

function formatSettleVerdict(view: SettleTextView): string {
  const verdict = view.settled === true ? 'settled' : 'not settled';
  const summary = view.diff?.summary;
  if (!summary) return `${verdict} after ${view.waitedMs ?? 0}ms`;
  return `${verdict} after ${view.waitedMs ?? 0}ms: +${summary.additions ?? 0} -${summary.removals ?? 0} (~${summary.unchanged ?? 0} unchanged)`;
}

export const interactionCliOutputFormatters = {
  click: resultOutput(tapCliOutput),
  press: resultOutput(tapCliOutput),
  fill: resultOutput(messageWithSettleCliOutput),
  longpress: resultOutput(messageWithSettleCliOutput),
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
