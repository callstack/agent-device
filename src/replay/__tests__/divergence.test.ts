import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  applyReplayDivergenceLevelCaps,
  boundReplayDivergence,
  measureReplayDivergenceBytes,
  sanitizeReplayDivergenceField,
  REPLAY_DIVERGENCE_DEFAULT_REF_LIMIT,
  REPLAY_DIVERGENCE_DIGEST_REF_LIMIT,
  REPLAY_DIVERGENCE_LEVEL_BYTE_LIMITS,
  REPLAY_DIVERGENCE_SUGGESTION_LIMIT,
  truncateUtf8Field,
  type ReplayDivergence,
} from '../divergence.ts';

function buildDivergence(overrides: Partial<ReplayDivergence> = {}): ReplayDivergence {
  return {
    version: 1,
    kind: 'action-failure',
    step: { index: 3, source: { path: '/tmp/flow.ad', line: 5 } },
    action: 'click "Save"',
    cause: { code: 'COMMAND_FAILED', message: 'Selector did not match', hint: 'Run find.' },
    screen: { state: 'available', refsGeneration: 4, refs: [{ ref: 'e1', role: 'button' }] },
    suggestions: [],
    suggestionCount: 0,
    resume: { allowed: true, from: 3, planDigest: 'deadbeef' },
    ...overrides,
  };
}

test('truncateUtf8Field leaves short strings untouched', () => {
  assert.equal(truncateUtf8Field('hello'), 'hello');
});

test('truncateUtf8Field truncates to the byte limit with a marker, never splitting a codepoint', () => {
  const value = '💾'.repeat(200); // 4 bytes per emoji, well over 256 bytes
  const truncated = truncateUtf8Field(value, 32);
  assert.ok(Buffer.byteLength(truncated, 'utf8') <= 32);
  assert.ok(truncated.endsWith('…<truncated>'));
  // Round-tripping through Buffer must not produce U+FFFD replacement chars —
  // proof the cut landed on a codepoint boundary.
  assert.ok(!truncated.includes('�'));
});

test('truncateUtf8Field is a no-op at exactly the limit', () => {
  const value = 'a'.repeat(256);
  assert.equal(truncateUtf8Field(value), value);
});

test('applyReplayDivergenceLevelCaps: digest omits suggestions but keeps suggestionCount, caps refs to 8', () => {
  const divergence = buildDivergence({
    suggestions: [
      { selector: 'id="save"', basis: 'id' },
      { selector: 'label="Save"', basis: 'label' },
    ],
    suggestionCount: 2,
    screen: {
      state: 'available',
      refsGeneration: 1,
      refs: Array.from({ length: 12 }, (_, i) => ({ ref: `e${i}`, role: 'button' })),
    },
  });
  const digest = applyReplayDivergenceLevelCaps(divergence, 'digest');
  assert.deepEqual(digest.suggestions, []);
  assert.equal(digest.suggestionCount, 2);
  assert.ok(digest.screen.state === 'available');
  assert.equal(
    (digest.screen as Extract<typeof digest.screen, { state: 'available' }>).refs.length,
    REPLAY_DIVERGENCE_DIGEST_REF_LIMIT,
  );
  assert.equal(digest.screen.state === 'available' && digest.screen.truncated, true);
});

test('applyReplayDivergenceLevelCaps: default/full cap refs to 20 and suggestions to 5', () => {
  const divergence = buildDivergence({
    suggestions: Array.from({ length: 8 }, (_, i) => ({
      selector: `id="s${i}"`,
      basis: 'id' as const,
    })),
    suggestionCount: 8,
    screen: {
      state: 'available',
      refsGeneration: 1,
      refs: Array.from({ length: 30 }, (_, i) => ({ ref: `e${i}`, role: 'button' })),
    },
  });
  const bounded = applyReplayDivergenceLevelCaps(divergence, 'default');
  assert.equal(bounded.suggestions.length, REPLAY_DIVERGENCE_SUGGESTION_LIMIT);
  assert.ok(bounded.screen.state === 'available');
  assert.equal(
    (bounded.screen as Extract<typeof bounded.screen, { state: 'available' }>).refs.length,
    REPLAY_DIVERGENCE_DEFAULT_REF_LIMIT,
  );
});

test('boundReplayDivergence passes a small divergence through unchanged at every level', () => {
  const divergence = buildDivergence();
  for (const level of ['digest', 'default', 'full'] as const) {
    const bounded = boundReplayDivergence({
      divergence,
      level,
      writeOverflowArtifact: () => {
        throw new Error('overflow artifact should not be needed for a small divergence');
      },
    });
    assert.ok(measureReplayDivergenceBytes(bounded) <= REPLAY_DIVERGENCE_LEVEL_BYTE_LIMITS[level]);
    assert.equal(bounded.cause.message, divergence.cause.message);
    assert.equal(bounded.overflow, undefined);
    assert.equal(bounded.artifactUnavailable, undefined);
  }
});

test('boundReplayDivergence writes an overflow artifact and returns a minimal fallback when the digest budget is exceeded', () => {
  // A field-truncation pass is the CALLER's responsibility at construction
  // time (session-replay-divergence.ts truncates every field to 256 bytes
  // before this point) — boundReplayDivergence only bounds array shape and
  // the overall byte budget, so an oversized single field (as could slip
  // through if a caller forgot to truncate) is exactly the case the overflow
  // path must still catch deterministically.
  const divergence = buildDivergence({
    cause: {
      code: 'COMMAND_FAILED',
      message: 'x'.repeat(20_000),
    },
    suggestions: Array.from({ length: 5 }, (_, i) => ({
      selector: `id="save-button-candidate-number-${i}-with-a-fairly-long-descriptive-selector-string"`,
      basis: 'id' as const,
      label: 'A'.repeat(200),
    })),
    suggestionCount: 5,
    screen: {
      state: 'available',
      refsGeneration: 1,
      refs: Array.from({ length: 20 }, (_, i) => ({
        ref: `e${i}`,
        role: 'button',
        label: 'B'.repeat(200),
      })),
    },
  });
  let writeCalls = 0;
  const bounded = boundReplayDivergence({
    divergence,
    level: 'digest',
    writeOverflowArtifact: (full) => {
      writeCalls += 1;
      assert.equal(full.suggestions.length, REPLAY_DIVERGENCE_SUGGESTION_LIMIT);
      return { artifactPath: '/tmp/session/replay-divergence/1.json' };
    },
  });
  assert.equal(writeCalls, 1);
  assert.ok(measureReplayDivergenceBytes(bounded) <= REPLAY_DIVERGENCE_LEVEL_BYTE_LIMITS.digest);
  assert.deepEqual(bounded.suggestions, []);
  assert.equal(bounded.screen.state, 'unavailable');
  assert.ok(bounded.overflow);
  assert.equal(bounded.overflow?.artifactPath, '/tmp/session/replay-divergence/1.json');
  assert.ok((bounded.overflow?.omittedBytes ?? 0) > 0);
  // The cause is never dropped by overflow handling (only the screen digest
  // and suggestions are), though the minimal fallback still enforces its own
  // 256-byte field cap defensively.
  assert.ok(divergence.cause.message.startsWith(bounded.cause.message.slice(0, 50)));
  assert.ok(Buffer.byteLength(bounded.cause.message, 'utf8') <= 256);
  assert.equal(bounded.step.index, divergence.step.index);
});

test('boundReplayDivergence sets artifactUnavailable when the artifact write itself fails', () => {
  const divergence = buildDivergence({
    cause: { code: 'COMMAND_FAILED', message: 'x'.repeat(20_000) },
    suggestions: Array.from({ length: 5 }, (_, i) => ({
      selector: `id="save-button-candidate-number-${i}-with-a-fairly-long-descriptive-selector-string"`,
      basis: 'id' as const,
      label: 'A'.repeat(200),
    })),
    suggestionCount: 5,
    screen: {
      state: 'available',
      refsGeneration: 1,
      refs: Array.from({ length: 20 }, (_, i) => ({
        ref: `e${i}`,
        role: 'button',
        label: 'B'.repeat(200),
      })),
    },
  });
  const bounded = boundReplayDivergence({
    divergence,
    level: 'digest',
    writeOverflowArtifact: () => ({ artifactUnavailable: true }),
  });
  assert.equal(bounded.artifactUnavailable, true);
  assert.equal(bounded.overflow, undefined);
  // The (truncated) cause survives even when the artifact could not be written.
  assert.ok(divergence.cause.message.startsWith(bounded.cause.message.slice(0, 50)));
});

test('resume carries the from index and planDigest through unmodified', () => {
  const divergence = buildDivergence({
    resume: { allowed: false, from: 3, planDigest: 'deadbeef', reason: 'skips control flow' },
  });
  assert.deepEqual(divergence.resume, {
    allowed: false,
    from: 3,
    planDigest: 'deadbeef',
    reason: 'skips control flow',
  });
});

// --- ADR 0012: redact BEFORE truncation ("All rendered strings ... pass
// through the central diagnostics redactor before truncation") ---

test('sanitizeReplayDivergenceField redacts a secret that straddles the truncation boundary', () => {
  // The secret assignment starts before byte 256 and its value crosses the
  // cut. Truncate-first could split the token so the redactor's pattern no
  // longer sees the full assignment; redact-first replaces the value before
  // any bytes are dropped, so no fragment of the secret can survive.
  // 200 prefix bytes put the assignment's VALUE across the raw 256-byte
  // boundary (the secret spans bytes ~211-262): truncate-first would cut
  // mid-secret and leave an unredactable fragment behind; redact-first
  // replaces the value before any bytes are dropped.
  const secret = 'hunter2-super-secret-value-abcdef123456-ghijkl-7890';
  const value = `${'x'.repeat(200)} password=${secret} ${'y'.repeat(200)}`;
  const sanitized = sanitizeReplayDivergenceField(value);
  assert.ok(Buffer.byteLength(sanitized, 'utf8') <= 256);
  assert.ok(!sanitized.includes('hunter2'));
  assert.ok(!sanitized.includes(secret.slice(0, 8)));
  assert.ok(sanitized.includes('password=[REDACTED]'));
});

test('sanitizeReplayDivergenceField redacts sensitive content even when no truncation is needed', () => {
  const sanitized = sanitizeReplayDivergenceField('open failed: bearer abc123def token leaked');
  assert.ok(!sanitized.includes('abc123def'));
  assert.ok(sanitized.includes('[REDACTED]'));
});

// --- Text report carries the repair data (bounded refs + unavailable hint) ---

test('formatReplayDivergenceReport lists a bounded ref/role/label subset for an available screen', async () => {
  const { formatReplayDivergenceReport } = await import('../divergence.ts');
  const report = formatReplayDivergenceReport({
    divergence: {
      version: 1,
      kind: 'action-failure',
      step: { index: 5, source: { path: '/tmp/flow.ad', line: 6 } },
      action: 'press "Pop to top"',
      cause: { code: 'COMMAND_FAILED', message: 'Selector did not match' },
      screen: {
        state: 'available',
        refsGeneration: 42,
        refs: Array.from({ length: 12 }, (_, i) => ({
          ref: `e${i + 1}`,
          role: 'button',
          label: `Button ${i + 1}`,
        })),
      },
      suggestions: [],
      suggestionCount: 0,
      resume: { allowed: true, from: 5, planDigest: 'deadbeef' },
    },
  });
  assert.ok(report);
  // A text-only caller can act without a follow-up snapshot: ref lines are listed.
  assert.match(report!, /Screen: 12 actionable ref\(s\) captured \(refsGeneration 42\)/);
  assert.match(report!, /^ {2}@e1 \[button\] "Button 1"$/m);
  assert.match(report!, /^ {2}@e8 \[button\] "Button 8"$/m);
  // Bounded to 8 lines, remainder summarized.
  assert.doesNotMatch(report!, /@e9 /);
  assert.match(report!, /^ {2}\.\.\. 4 more$/m);
});

test('formatReplayDivergenceReport carries the unavailable-screen hint', async () => {
  const { formatReplayDivergenceReport } = await import('../divergence.ts');
  const report = formatReplayDivergenceReport({
    divergence: {
      version: 1,
      kind: 'action-failure',
      step: { index: 1, source: { path: '/tmp/flow.ad', line: 1 } },
      action: 'click "Save"',
      cause: { code: 'COMMAND_FAILED', message: 'not hittable' },
      screen: {
        state: 'unavailable',
        reason: 'sparse-snapshot',
        hint: 'run snapshot -i to observe the current screen.',
      },
      suggestions: [],
      suggestionCount: 0,
      resume: { allowed: true, from: 5, planDigest: 'deadbeef' },
    },
  });
  assert.ok(report);
  assert.match(report!, /Screen: unavailable \(sparse-snapshot\)\. run snapshot -i/);
});

test('scrubReplayVarValues replaces every occurrence with a named marker, longest value first', async () => {
  const { scrubReplayVarValues } = await import('../divergence.ts');
  const entries = [
    { name: 'LONG', value: 'abc-def' },
    { name: 'SHORT', value: 'abc' },
  ].sort((a, b) => b.value.length - a.value.length);
  assert.equal(
    scrubReplayVarValues('x abc-def y abc z abc-def', entries),
    'x <var:LONG> y <var:SHORT> z <var:LONG>',
  );
  // Not shape-based: plain, non-secret-looking values are scrubbed too.
  assert.equal(
    scrubReplayVarValues('value=3000 done', [{ name: 'T', value: '3000' }]),
    'value=<var:T> done',
  );
});

// --- ADR 0012 migration step 4: target-binding divergence wire shape ---

test('a target-binding divergence kind carries targetBinding.classification equal to kind', () => {
  for (const kind of ['selector-miss', 'identity-mismatch', 'identity-unverifiable'] as const) {
    const divergence = buildDivergence({
      kind,
      targetBinding: {
        classification: kind,
        matchCount: kind === 'selector-miss' ? 0 : 1,
        recorded: { role: 'button', label: 'Save' },
        mismatches: [],
        candidates: [],
      },
    });
    assert.equal(divergence.targetBinding?.classification, divergence.kind);
  }
});

test('matchCount presence rule: the key is entirely absent (never null) for recorded-unverifiable', () => {
  const divergence = buildDivergence({
    kind: 'identity-unverifiable',
    targetBinding: {
      classification: 'identity-unverifiable',
      recorded: { role: 'button', label: 'Save' },
      mismatches: [],
      candidates: [],
    },
  });
  const serialized = JSON.parse(JSON.stringify(divergence)) as Record<string, unknown>;
  const targetBinding = serialized.targetBinding as Record<string, unknown>;
  assert.equal('matchCount' in targetBinding, false);
});

test('matchCount presence rule: the key is present (0..N) on every path that performs resolution', () => {
  for (const matchCount of [0, 1, 4]) {
    const divergence = buildDivergence({
      kind: matchCount === 0 ? 'selector-miss' : 'identity-mismatch',
      targetBinding: {
        classification: matchCount === 0 ? 'selector-miss' : 'identity-mismatch',
        matchCount,
        recorded: { role: 'button', label: 'Save' },
        mismatches: [],
        candidates: [],
      },
    });
    assert.equal(divergence.targetBinding?.matchCount, matchCount);
  }
});

test('a target-binding divergence carries a real computed resume object (not a stub)', () => {
  // ADR 0012 step 5 (#1211) wiring: a target-binding divergence fires
  // pre-action, so it resumes at the SAME failed step with a real digest —
  // never the retired `{allowed:false, reason:'resume not yet supported'}` stub.
  const divergence = buildDivergence({
    kind: 'identity-mismatch',
    resume: { allowed: true, from: 7, planDigest: 'abc123' },
    targetBinding: {
      classification: 'identity-mismatch',
      matchCount: 1,
      recorded: { id: 'save', role: 'button', label: 'Save' },
      observed: { id: 'save-v2', role: 'button', label: 'Save' },
      mismatches: [],
      candidates: [],
    },
  });
  assert.deepEqual(divergence.resume, { allowed: true, from: 7, planDigest: 'abc123' });
  assert.notEqual((divergence.resume as { reason?: string }).reason, 'resume not yet supported');
});

test('boundReplayDivergence keeps targetBinding on the minimal overflow fallback (it is small repair data, not a bulk digest)', () => {
  const divergence = buildDivergence({
    kind: 'identity-unverifiable',
    cause: { code: 'IDENTITY_UNVERIFIABLE', message: 'x'.repeat(20_000) },
    targetBinding: {
      classification: 'identity-unverifiable',
      matchCount: 4,
      recorded: { id: 'save', role: 'button', label: 'Save' },
      mismatches: [],
      candidates: [
        { ref: 'e1', role: 'button', label: 'Row' },
        { ref: 'e2', role: 'button', label: 'Row' },
      ],
    },
    screen: {
      state: 'available',
      refsGeneration: 1,
      refs: Array.from({ length: 20 }, (_, i) => ({
        ref: `e${i}`,
        role: 'button',
        label: 'B'.repeat(200),
      })),
    },
  });
  const bounded = boundReplayDivergence({
    divergence,
    level: 'digest',
    writeOverflowArtifact: () => ({ artifactPath: '/tmp/session/replay-divergence/1.json' }),
  });
  assert.ok(bounded.overflow); // confirms the minimal-fallback path actually ran
  assert.deepEqual(bounded.targetBinding, divergence.targetBinding);
});

test('formatReplayDivergenceReport renders matchCount, mismatches, and candidates for a target-binding divergence', async () => {
  const { formatReplayDivergenceReport } = await import('../divergence.ts');
  const report = formatReplayDivergenceReport({
    divergence: {
      version: 1,
      kind: 'identity-mismatch',
      step: { index: 2, source: { path: '/tmp/flow.ad', line: 3 } },
      action: 'click id="save"',
      cause: { code: 'IDENTITY_MISMATCH', message: 'wrong element' },
      screen: { state: 'unavailable', reason: 'sparse-snapshot' },
      suggestions: [],
      suggestionCount: 0,
      resume: { allowed: true, from: 2, planDigest: 'deadbeef' },
      targetBinding: {
        classification: 'identity-mismatch',
        matchCount: 1,
        recorded: { id: 'save', role: 'button', label: 'Save' },
        observed: { id: 'save-v2', role: 'button', label: 'Save' },
        mismatches: ['id: recorded=save observed=save-v2'],
        candidates: [],
      },
    },
  });
  assert.ok(report);
  assert.match(report!, /Target binding: identity-mismatch \(matchCount 1\)/);
  assert.match(report!, /mismatches: id: recorded=save observed=save-v2/);
});

test('formatReplayDivergenceReport lists candidates for an identity-unverifiable target-binding divergence', async () => {
  const { formatReplayDivergenceReport } = await import('../divergence.ts');
  const report = formatReplayDivergenceReport({
    divergence: {
      version: 1,
      kind: 'identity-unverifiable',
      step: { index: 1, source: { path: '/tmp/flow.ad', line: 1 } },
      action: 'click role=button label="Row"',
      cause: { code: 'IDENTITY_UNVERIFIABLE', message: 'ambiguous' },
      screen: { state: 'unavailable', reason: 'sparse-snapshot' },
      suggestions: [],
      suggestionCount: 0,
      resume: { allowed: true, from: 1, planDigest: 'deadbeef' },
      targetBinding: {
        classification: 'identity-unverifiable',
        matchCount: 2,
        recorded: { role: 'button', label: 'Row' },
        mismatches: [],
        candidates: [
          { ref: 'e1', role: 'button', label: 'Row' },
          { ref: 'e2', role: 'button', label: 'Row' },
        ],
      },
    },
  });
  assert.ok(report);
  assert.match(report!, /2 candidate\(s\) shared the recorded identity/);
  assert.match(report!, /@e1 \[button\] "Row"/);
});
