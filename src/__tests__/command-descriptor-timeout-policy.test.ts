import { test } from 'vitest';
import assert from 'node:assert/strict';
import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import {
  commandDescriptors,
  resolveCommandPostActionObservationSupport,
  resolveCommandTimeoutPolicy,
} from '@agent-device/command-registry/registry';
import {
  DEFAULT_TIMEOUT_POLICY,
  resolveCommandRequestTimeoutMs,
} from '@agent-device/command-registry/timeout-policy';
import { DEFAULT_STABLE_TIMEOUT_MS } from '../commands/interaction/runtime/stable-capture.ts';

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
  // scroll/back joined in #1638: `--settle` gives them the same post-action
  // capture loop, so a wedged bridge is now their dominant hang mode too.
  // The lease route joined in #1774: those commands act on BILLED provider
  // sessions the daemon owns, so a client-side timeout must not SIGKILL the
  // daemon mid-create/mid-release and orphan them (and every other provider
  // session held).
  const preserving = commandDescriptors
    .filter((descriptor) => descriptor.timeoutPolicy.onTimeout === 'preserve-daemon')
    .map((descriptor) => descriptor.name);
  assert.deepEqual(preserving.sort(), [
    'back',
    'click',
    'fill',
    'find',
    'get',
    'hover',
    'is',
    'lease_allocate',
    'lease_heartbeat',
    'lease_release',
    'longpress',
    'press',
    'scroll',
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
    longpress: 210_000,
    // #1774: base allocation budget (300s) + client/daemon race margin (30s).
    lease_allocate: 330_000,
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

test('wait request timeout extends past the user-supplied wait budget', () => {
  const base = {
    positionals: [] as string[],
    flags: {},
  };

  // Explicit budgets beyond the default envelope extend it (budget + margin).
  assert.equal(
    resolveCommandRequestTimeoutMs(resolveCommandTimeoutPolicy('wait'), {
      ...base,
      positionals: ['text', 'Ready', '180000'],
    }),
    210_000,
  );
  assert.equal(
    resolveCommandRequestTimeoutMs(resolveCommandTimeoutPolicy('wait'), {
      ...base,
      positionals: ['stable', '500', '120000'],
    }),
    150_000,
  );
  // Sleep waits block for their full duration and get the same treatment.
  assert.equal(
    resolveCommandRequestTimeoutMs(resolveCommandTimeoutPolicy('wait'), {
      ...base,
      positionals: ['120000'],
    }),
    150_000,
  );
  // Small budgets never shrink the envelope below the default.
  assert.equal(
    resolveCommandRequestTimeoutMs(resolveCommandTimeoutPolicy('wait'), {
      ...base,
      positionals: ['text', 'Ready', '5000'],
    }),
    90_000,
  );
  // No explicit budget → default envelope.
  assert.equal(
    resolveCommandRequestTimeoutMs(resolveCommandTimeoutPolicy('wait'), {
      ...base,
      positionals: ['text', 'Ready'],
    }),
    90_000,
  );
  assert.equal(
    resolveCommandRequestTimeoutMs(resolveCommandTimeoutPolicy('wait'), { ...base }),
    90_000,
  );
});

test('interaction --settle budgets add post-action settle time on top of the normal envelope', () => {
  const base = {
    positionals: ['@e2'],
  };

  // --timeout bounds the SETTLE wait after selector resolution and the action,
  // so the envelope keeps the normal touch-command overhead and then adds the
  // settle budget plus the same safety margin used by wait.
  assert.equal(
    resolveCommandRequestTimeoutMs(resolveCommandTimeoutPolicy('press'), {
      ...base,
      flags: { settle: true, timeoutMs: 120_000 },
    }),
    240_000,
  );
  // A small settle deadline still needs the normal touch-command envelope plus
  // room for post-action observation.
  assert.equal(
    resolveCommandRequestTimeoutMs(resolveCommandTimeoutPolicy('fill'), {
      ...base,
      flags: { settle: true, timeoutMs: 5_000 },
    }),
    125_000,
  );
  // Longpress keeps the cold Android helper route and its 120-second maximum
  // hold inside the outer envelope.
  assert.equal(
    resolveCommandRequestTimeoutMs(resolveCommandTimeoutPolicy('longpress'), {
      ...base,
      positionals: ['300', '500', '120000'],
      flags: {},
    }),
    210_000,
  );
  // Bare --settle adds its default budget after the longpress-specific base,
  // so a maximum hold still leaves room for post-action observation.
  assert.equal(
    resolveCommandRequestTimeoutMs(resolveCommandTimeoutPolicy('longpress'), {
      ...base,
      flags: { settle: true },
    }),
    250_000,
  );
  // Bare timeoutMs without --settle remains wire-compatible with older touch
  // command clients: it is ignored instead of opting into settle semantics.
  assert.equal(
    resolveCommandRequestTimeoutMs(resolveCommandTimeoutPolicy('press'), {
      ...base,
      flags: { timeoutMs: 120_000 },
    }),
    90_000,
  );
  assert.equal(
    resolveCommandRequestTimeoutMs(resolveCommandTimeoutPolicy('press'), { ...base, flags: {} }),
    90_000,
  );
});

test('snapshot uses the standard daemon request timeout with an explicit override', () => {
  const base = {
    positionals: [],
    flags: {},
  };

  assert.equal(
    resolveCommandRequestTimeoutMs(resolveCommandTimeoutPolicy('snapshot'), { ...base }),
    90_000,
  );
  assert.equal(
    resolveCommandRequestTimeoutMs(resolveCommandTimeoutPolicy('snapshot'), {
      ...base,
      flags: { timeoutMs: 120_000 },
    }),
    120_000,
  );
  assert.equal(
    resolveCommandRequestTimeoutMs(resolveCommandTimeoutPolicy('screenshot'), { ...base }),
    90_000,
  );
  assert.equal(
    resolveCommandRequestTimeoutMs(resolveCommandTimeoutPolicy('install'), { ...base }),
    180_000,
  );
  assert.equal(
    resolveCommandRequestTimeoutMs(resolveCommandTimeoutPolicy('reinstall'), { ...base }),
    180_000,
  );
  assert.equal(
    resolveCommandRequestTimeoutMs(resolveCommandTimeoutPolicy('install_source'), { ...base }),
    180_000,
  );
  assert.equal(
    resolveCommandRequestTimeoutMs(resolveCommandTimeoutPolicy('prepare'), {
      ...base,
      positionals: ['ios-runner'],
    }),
    240_000,
  );
  assert.equal(
    resolveCommandRequestTimeoutMs(resolveCommandTimeoutPolicy('prepare'), {
      ...base,
      positionals: ['ios-runner'],
      flags: { timeoutMs: 240_000 },
    }),
    240_000,
  );
  assert.equal(
    resolveCommandRequestTimeoutMs(resolveCommandTimeoutPolicy('test'), { ...base }),
    undefined,
  );
});
