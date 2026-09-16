import type { CliOutput } from '../command-contract.ts';
import { resultOutput, type CliOutputFormatter } from '../output-common.ts';
import type { PolicyActResult, PolicyDecision, PolicySuggestResult } from './policy-contract.ts';

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

export const policyCliOutputFormatters = {
  suggest: resultOutput(suggestCliOutput),
  act: resultOutput(actCliOutput),
} as const satisfies Record<string, CliOutputFormatter>;

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
