import { test } from 'vitest';
import assert from 'node:assert/strict';
import { PUBLIC_COMMANDS } from '../../../command-catalog.ts';
import {
  commandDescriptors,
  resolveCommandPostActionObservationSupport,
  resolveCommandTimeoutPolicy,
} from '../registry.ts';
import { DEFAULT_TIMEOUT_POLICY } from '../timeout-policy.ts';
import { DEFAULT_STABLE_TIMEOUT_MS } from '../../../commands/interaction/runtime/stable-capture.ts';

// ADR 0008 completeness gate for the descriptor timeout policy (the layer that
// replaced the two hand-maintained client lists `isExplicitTimeoutCommand` and
// `DAEMON_PRESERVING_TIMEOUT_COMMANDS`): every public command must carry a
// declared policy, and the sets of commands that deviate from the shared
// default are bounded, diffable lists — they may only change in the same PR
// that updates them here. Behavioral derivation (envelope arithmetic, wait
// budget parsing, flag overrides) is proven by the pre-existing oracle tests in
// src/utils/__tests__/daemon-client.test.ts, which survived this migration
// unchanged.

function settleObservationCommandNames(): string[] {
  return commandDescriptors
    .filter(
      (descriptor) => resolveCommandPostActionObservationSupport(descriptor.name) !== undefined,
    )
    .map((descriptor) => descriptor.name)
    .sort();
}

test('every public command declares a timeout policy on its descriptor', () => {
  const byName = new Map(commandDescriptors.map((descriptor) => [descriptor.name, descriptor]));
  for (const command of Object.values(PUBLIC_COMMANDS)) {
    const descriptor = byName.get(command);
    assert.ok(descriptor, `public command ${command} is missing from the descriptor registry`);
    assert.ok(descriptor.timeoutPolicy, `public command ${command} declares no timeoutPolicy`);
  }
});

test('declared timeout policies are structurally valid', () => {
  for (const descriptor of commandDescriptors) {
    const policy = descriptor.timeoutPolicy;
    assert.ok(
      policy.onTimeout === 'preserve-daemon' || policy.onTimeout === 'reset-daemon',
      `${descriptor.name}: invalid onTimeout ${String(policy.onTimeout)}`,
    );
    if (policy.envelopeMs !== 'unbounded') {
      assert.ok(
        Number.isFinite(policy.envelopeMs) && policy.envelopeMs > 0,
        `${descriptor.name}: envelopeMs must be a positive duration`,
      );
    }
    if (policy.budget.source === 'positional-parser') {
      assert.equal(
        typeof policy.budget.parser,
        'function',
        `${descriptor.name}: positional-parser budget requires a parser`,
      );
    }
  }
});

test('daemon-preserving timeout commands are a bounded, reviewed set', () => {
  // CONSERVATIVE: this list may only change in the same PR that updates it
  // here. Preserving the daemon on timeout is for commands whose dominant
  // hang mode is a blocked platform accessibility bridge — a timed-out
  // poll must not turn into a daemon reset that loses every session (#1075).
  // Interaction commands joined in #1105: their target resolution runs the
  // same capture as snapshot, and resetting the daemon on a wedged capture
  // destroyed healthy app sessions.
  const preserving = commandDescriptors
    .filter((descriptor) => descriptor.timeoutPolicy.onTimeout === 'preserve-daemon')
    .map((descriptor) => descriptor.name);
  assert.deepEqual(preserving.sort(), [
    'click',
    'fill',
    'find',
    'get',
    'is',
    'longpress',
    'press',
    'snapshot',
    'type',
    'wait',
  ]);
});

test('budget sources deviating from the default are bounded, reviewed sets', () => {
  const flagBoundBudget: string[] = [];
  const flagWidenBudget: string[] = [];
  const positionalBudget: string[] = [];
  for (const descriptor of commandDescriptors) {
    const budget = descriptor.timeoutPolicy.budget;
    if (budget.source === 'flag') {
      const widen = 'envelope' in budget && budget.envelope === 'widen';
      (widen ? flagWidenBudget : flagBoundBudget).push(descriptor.name);
    }
    if (budget.source === 'positional-parser') {
      positionalBudget.push(descriptor.name);
    }
  }
  // --timeout bounds the request envelope for these commands only.
  assert.deepEqual(flagBoundBudget.sort(), ['prepare', 'replay', 'snapshot']);
  // --timeout bounds the --settle wait on these commands (#1101); like wait's
  // positional budget it only ever widens the envelope, never shrinks it.
  assert.deepEqual(flagWidenBudget.sort(), settleObservationCommandNames());
  // wait's budget travels as a positional and must widen the envelope.
  assert.deepEqual(positionalBudget, ['wait']);
});

test('settle timeout policy default matches the runtime settle loop default', () => {
  for (const command of settleObservationCommandNames()) {
    const budget = resolveCommandTimeoutPolicy(command).budget;
    assert.equal(budget.source, 'flag', `${command}: expected flag budget`);
    assert.equal(budget.envelope, 'widen', `${command}: expected widening budget`);
    assert.equal(
      budget.defaultBudgetMs,
      DEFAULT_STABLE_TIMEOUT_MS,
      `${command}: default settle budget must match runtime default`,
    );
  }
});

test('request envelopes deviating from the default are bounded, reviewed sets', () => {
  const EXPECTED_ENVELOPES: Record<string, number | 'unbounded'> = {
    prepare: 240_000,
    install: 180_000,
    reinstall: 180_000,
    install_source: 180_000,
    test: 'unbounded',
  };
  for (const descriptor of commandDescriptors) {
    const expected = EXPECTED_ENVELOPES[descriptor.name] ?? 90_000;
    assert.equal(
      descriptor.timeoutPolicy.envelopeMs,
      expected,
      `${descriptor.name}: unexpected request envelope`,
    );
  }
});

test('commands outside the registry fall back to the explicit default policy', () => {
  // Matches the deleted hand lists: not listed meant default envelope and a
  // daemon reset on timeout.
  assert.equal(resolveCommandTimeoutPolicy(undefined), DEFAULT_TIMEOUT_POLICY);
  assert.equal(resolveCommandTimeoutPolicy('not-a-registered-command'), DEFAULT_TIMEOUT_POLICY);
  assert.equal(DEFAULT_TIMEOUT_POLICY.onTimeout, 'reset-daemon');
  assert.equal(DEFAULT_TIMEOUT_POLICY.envelopeMs, 90_000);
  assert.equal(DEFAULT_TIMEOUT_POLICY.budget.source, 'none');
});
