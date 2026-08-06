import type { CliOutput } from './command-contract.ts';
import {
  messageCliOutput,
  pinnedRefText,
  resultOutput,
  type CliOutputFormatter,
} from './output-common.ts';

/**
 * Compact `--settle` (#1101) rendering appended to a command's own success
 * line: the verdict, the changed-count summary, and the changed lines
 * themselves (the payload the agent acts on). Empty for non-settle responses,
 * so a formatter can append it unconditionally.
 *
 * Shared across families because the trait is (#1638): the touch commands
 * render it next to their tap line, `scroll` and `back` next to theirs.
 */

type SettleTextView = {
  settled?: boolean;
  waitedMs?: number;
  hint?: string;
  diff?: {
    summary?: { additions?: number; removals?: number; unchanged?: number };
    lines?: Array<{ kind?: string; text?: string; ref?: string }>;
    truncated?: boolean;
  };
  tail?: Array<{ ref?: string; role?: string; label?: string }>;
  tailTruncated?: boolean;
  refsGeneration?: number;
};

/** `messageCliOutput` plus the response's warning and settle notes. */
export const messageWithSettleOutput: CliOutputFormatter = resultOutput(
  (result: Record<string, unknown>): CliOutput => {
    const output = messageCliOutput(result);
    return { data: output.data, text: appendResponseNotes(output.text, result) };
  },
);

export function appendResponseNotes(
  text: string | null | undefined,
  data: Record<string, unknown>,
): string {
  const warning = typeof data.warning === 'string' ? `\nWarning: ${data.warning}` : '';
  return `${text ?? ''}${warning}${formatSettleText(data.settle)}`;
}

function formatSettleText(settle: unknown): string {
  if (!settle || typeof settle !== 'object') return '';
  const view = settle as SettleTextView;
  const parts = [
    formatSettleVerdict(view),
    ...formatSettleDiffLines(view),
    ...formatSettleTailLines(view),
  ];
  if (view.hint) parts.push(`hint: ${view.hint}`);
  return `\n${parts.join('\n')}`;
}

function formatSettleDiffLines(view: SettleTextView): string[] {
  const diff = view.diff;
  const lines = (diff?.lines ?? []).map(
    (line) =>
      `${line.kind === 'removed' ? '-' : '+'} ${pinnedDiffLineText(line, view.refsGeneration)}`,
  );
  if (diff?.truncated) lines.push('… changed lines truncated');
  return lines;
}

/**
 * ADR 0014: a settled diff publishes a PARTIAL frame, which admits only the
 * pinned form of the refs it issued — so a CLI caller who copies a bare `@eN`
 * out of the diff gets `plain_ref_requires_complete_frame`. Render the added
 * line's ref in the same paste-ready `@eN~s<gen>` form the tail already uses.
 * Only added lines carry a ref (`SettleDiffLine`); removed lines render
 * verbatim, since nothing there is a target.
 */
function pinnedDiffLineText(
  line: { text?: string; ref?: string },
  refsGeneration: number | undefined,
): string {
  const text = line.text ?? '';
  const pinned = pinnedRefText(line.ref, refsGeneration);
  if (!pinned || !line.ref) return text;
  const plain = `@${line.ref}`;
  return text.startsWith(`${plain} `) ? `${pinned}${text.slice(plain.length)}` : text;
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
