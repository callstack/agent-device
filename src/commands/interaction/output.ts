import type { CommandRequestResult } from '@agent-device/contracts/client';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import type { CliOutput } from '../command-contract.ts';
// Type-only, so the startup closure never reaches the policy runtime through this module.
import type {
  PolicyActResult,
  PolicyDecision,
  PolicySuggestResult,
} from '../policy/policy-contract.ts';
import { displayLabel, formatRole } from '@agent-device/capture-kit/snapshot-lines';
import { readCommandMessage } from '@agent-device/kernel/success-text';
import {
  messageCliOutput,
  messageOutput,
  pinnedRefText,
  resultOutput,
  type CliOutputFormatter,
} from '../output-common.ts';
import { withSettleCapableNotes } from '../settle-output.ts';

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
    return defaultCommandCliOutput(data);
  }
  return { data, text: `Tapped @${ref} (${x}, ${y})` };
}

// #1652: settle-capable entries (click, press, fill, longpress, hover, scroll)
// get the warning/settle notes appended by the trait-derived wrapper; the rest
// of the map is returned untouched.
export const interactionCliOutputFormatters = {
  ...withSettleCapableNotes({
    click: resultOutput(tapCliOutput),
    press: resultOutput(tapCliOutput),
    fill: messageOutput,
    longpress: messageOutput,
    hover: messageOutput,
    scroll: messageOutput,
    get: ({ input, result }) =>
      getCliOutput({
        result: result as CommandRequestResult,
        format: input.format as Parameters<typeof getCliOutput>[0]['format'],
      }),
    is: resultOutput(isCliOutput),
    find: resultOutput(findCliOutput),
    // Policy results carry no settle diff, so they are added outside the settle-note wrapper.
  } satisfies Record<string, CliOutputFormatter>),
  suggest: resultOutput(suggestCliOutput),
  act: resultOutput(actCliOutput),
} satisfies Record<string, CliOutputFormatter>;

function defaultCommandCliOutput(result: CommandRequestResult): CliOutput {
  return messageCliOutput(result as Record<string, unknown>);
}

function suggestCliOutput(result: PolicySuggestResult): CliOutput {
  const lines = [
    `Goal: ${result.goal}`,
    `Screen: ${result.screen}`,
    decisionLine(result.decision),
    topProbabilities(result.decision),
    `Timing: snapshot ${ms(result.snapshotMs)} decide ${ms(result.decision.decideMs)}`,
    `Cost: ${usd(result.decision.costUsd)} for ${result.decision.inputTokens} input tokens`,
  ];
  return { data: result, text: lines.filter(Boolean).join('\n') };
}

function actCliOutput(result: PolicyActResult): CliOutput {
  const lines = [`Goal: ${result.goal}`, `Status: ${result.status}`];
  for (const step of result.steps) {
    const performed = step.performed
      ? ` ${step.performed.action} ${step.performed.target}${step.performed.entry === 'keypad' ? ' via keypad' : ''}`
      : '';
    lines.push(
      `${String(step.step).padStart(2)} ${step.outcome.padEnd(12)}${performed} conf ${step.decision.confidence.toFixed(2)} | ${step.screen}`,
    );
    if (step.reason) lines.push(`   ${step.reason}`);
  }
  const totals = result.totals;
  lines.push(
    `Steps: ${totals.steps}, dead actions ${totals.deadActions}, escalations ${totals.escalations}`,
    `Timing: snapshot ${ms(totals.snapshotMs)} decide ${ms(totals.decideMs)} action ${ms(totals.actionMs)}`,
    `Cost: ${usd(totals.costUsd)} for ${totals.inputTokens} input tokens`,
  );
  return { data: result, text: lines.join('\n') };
}

function decisionLine(decision: PolicyDecision): string {
  const target = decision.target ?? 'none';
  const flags = [decision.done ? 'done' : '', decision.blocked ? 'blocked' : '']
    .filter(Boolean)
    .join(' ');
  return `Next: ${decision.action} ${target} at confidence ${decision.confidence.toFixed(2)}${flags ? ` (${flags})` : ''}`;
}

function topProbabilities(decision: PolicyDecision): string {
  const ranked = Object.entries(decision.probabilities)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([label, probability]) => `${label} ${(probability * 100).toFixed(1)}%`);
  return ranked.length > 0 ? `Probabilities: ${ranked.join(', ')}` : '';
}

function ms(value: number): string {
  return `${Math.round(value)}ms`;
}

function usd(value: number): string {
  return `$${value.toFixed(6)}`;
}
