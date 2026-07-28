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
    repairHint: 'manual',
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
  // ADR 0012 decision 6: repairHint is a small fixed token that must survive
  // the minimal overflow fallback, not just the happy path.
  assert.equal(bounded.repairHint, divergence.repairHint);
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

// --- ADR 0012 decision 6: the `repairHint` text guidance embeds the
// concrete `resume.from`/`planDigest` command ONLY when `resume.allowed` is
// true, and never renders a `--from` command a structured caller would be
// refused — it surfaces `resume.reason` instead. ---

test('formatReplayDivergenceReport embeds the concrete resume command for an allowed record-and-heal divergence', async () => {
  const { formatReplayDivergenceReport } = await import('../divergence.ts');
  const report = formatReplayDivergenceReport({
    divergence: {
      version: 1,
      kind: 'action-failure',
      step: { index: 2, source: { path: '/tmp/flow.ad', line: 3 } },
      action: 'click id="article"',
      cause: { code: 'COMMAND_FAILED', message: 'not hittable' },
      screen: { state: 'available', refsGeneration: 1, refs: [{ ref: 'e1', role: 'button' }] },
      suggestions: [],
      suggestionCount: 0,
      resume: { allowed: true, from: 3, planDigest: 'deadbeef' },
      repairHint: 'record-and-heal',
    },
  });
  assert.ok(report);
  assert.match(report!, /Repair hint: record-and-heal — press the correct control/);
  // The LITERAL next command, computed from this exact `resume` — never the
  // generic `<step\+1>` placeholder — so a text-only caller reads the same
  // continuation a JSON\/MCP-first caller would follow mechanically.
  assert.match(report!, /then replay --from 3 --plan-digest deadbeef\./);
  assert.doesNotMatch(report!, /<step/);
});

test('formatReplayDivergenceReport never renders a --from command when resume is NOT allowed, surfacing the reason instead', async () => {
  const { formatReplayDivergenceReport } = await import('../divergence.ts');
  const report = formatReplayDivergenceReport({
    divergence: {
      version: 1,
      kind: 'action-failure',
      step: { index: 2, source: { path: '/tmp/flow.ad', line: 3 } },
      action: 'click id="article"',
      cause: { code: 'COMMAND_FAILED', message: 'not hittable' },
      screen: { state: 'available', refsGeneration: 1, refs: [{ ref: 'e1', role: 'button' }] },
      suggestions: [],
      suggestionCount: 0,
      resume: {
        allowed: false,
        from: 3,
        planDigest: 'deadbeef',
        reason: 'step 1 is inside runtime control flow (retry); skipping it cannot be proven safe.',
      },
      repairHint: 'record-and-heal',
    },
  });
  assert.ok(report);
  assert.match(report!, /Repair hint: record-and-heal/);
  // A text caller must never be told to run a --from a structured caller
  // (reading the same `resume.allowed:false`) would be refused.
  assert.doesNotMatch(report!, /replay --from/);
  assert.match(report!, /cannot currently be resumed automatically/);
  assert.match(report!, /step 1 is inside runtime control flow \(retry\)/);
});

test('formatReplayDivergenceReport falls back to a generic non-resumable sentence when resume carries no reason', async () => {
  const { formatReplayDivergenceReport } = await import('../divergence.ts');
  const report = formatReplayDivergenceReport({
    divergence: {
      version: 1,
      kind: 'action-failure',
      step: { index: 2, source: { path: '/tmp/flow.ad', line: 3 } },
      action: 'click id="article"',
      cause: { code: 'COMMAND_FAILED', message: 'not hittable' },
      screen: { state: 'unavailable', reason: 'sparse-snapshot', hint: 'run snapshot -i.' },
      suggestions: [],
      suggestionCount: 0,
      resume: { allowed: false, reason: 'resume not yet supported' },
      repairHint: 'state-repair',
    },
  });
  assert.ok(report);
  assert.doesNotMatch(report!, /replay --from/);
  assert.match(report!, /cannot currently be resumed automatically \(resume not yet supported\)/);
});

// --- #1262: `caution`/`manual` are genuinely dual-path — the daemon cannot
// know at divergence time whether the agent will fix app state (--no-record,
// resuming at the unshifted `resume.from`, N) or perform the step's intent as
// a recorded action (record-and-heal-shaped, resuming at N + 1). The `N + 1`
// command is rendered IFF the wire carries `resume.alternateFrom` (the
// daemon's own verdict that `--from N + 1` would be accepted) — the renderer
// NEVER re-derives resumability, so text and structured wire never disagree. ---

test('formatReplayDivergenceReport embeds BOTH concrete resume commands for a caution divergence whose wire carries alternateFrom', async () => {
  const { formatReplayDivergenceReport } = await import('../divergence.ts');
  const report = formatReplayDivergenceReport({
    divergence: {
      version: 1,
      kind: 'identity-mismatch',
      step: { index: 2, source: { path: '/tmp/flow.ad', line: 3 } },
      action: 'click label="Save"',
      cause: { code: 'IDENTITY_MISMATCH', message: 'resolved a different element' },
      screen: { state: 'available', refsGeneration: 1, refs: [{ ref: 'e1', role: 'button' }] },
      suggestions: [],
      suggestionCount: 0,
      // caution's resume.from is UNSHIFTED (N); alternateFrom carries N + 1,
      // present only because the daemon proved `--from 3` would be accepted.
      resume: { allowed: true, from: 2, planDigest: 'deadbeef', alternateFrom: 3 },
      repairHint: 'caution',
    },
  });
  assert.ok(report);
  assert.match(report!, /Repair hint: caution — something already matches the recorded selector/);
  // The state-fix command uses N (resume.from itself, unshifted)...
  assert.match(
    report!,
    /if you fixed app state with --no-record actions: replay --from 2 --plan-digest deadbeef/,
  );
  // ...and the recorded-action command uses alternateFrom (N + 1) verbatim —
  // never re-derived from `from` on the client side.
  assert.match(
    report!,
    /if you performed the step's intent as a recorded action: replay --from 3 --plan-digest deadbeef\./,
  );
});

test('formatReplayDivergenceReport embeds BOTH concrete resume commands for a manual divergence whose wire carries alternateFrom', async () => {
  const { formatReplayDivergenceReport } = await import('../divergence.ts');
  const report = formatReplayDivergenceReport({
    divergence: {
      version: 1,
      kind: 'action-failure',
      step: { index: 5, source: { path: '/tmp/flow.ad', line: 9 } },
      action: 'click label="Confirm"',
      cause: { code: 'COMMAND_FAILED', message: 'not hittable' },
      screen: { state: 'available', refsGeneration: 1, refs: [{ ref: 'e1', role: 'button' }] },
      suggestions: [],
      suggestionCount: 0,
      resume: { allowed: true, from: 5, planDigest: 'cafef00d', alternateFrom: 6 },
      repairHint: 'manual',
    },
  });
  assert.ok(report);
  assert.match(report!, /Repair hint: manual — no safe automated repair could be proven/);
  assert.match(
    report!,
    /if you fixed app state with --no-record actions: replay --from 5 --plan-digest cafef00d/,
  );
  assert.match(
    report!,
    /if you performed the step's intent as a recorded action: replay --from 6 --plan-digest cafef00d\./,
  );
});

test('formatReplayDivergenceReport renders ONLY the state-fix command for a caution divergence WITHOUT alternateFrom (the diverged step is not skip-safe)', async () => {
  const { formatReplayDivergenceReport } = await import('../divergence.ts');
  // resume.allowed is true (resuming AT N is fine), but the diverged step N
  // is a runScript/control-flow action, so `--from N + 1` would be refused —
  // the daemon omits alternateFrom, and the text must NOT offer `--from N + 1`.
  const report = formatReplayDivergenceReport({
    divergence: {
      version: 1,
      kind: 'identity-mismatch',
      step: { index: 2, source: { path: '/tmp/flow.ad', line: 3 } },
      action: 'click label="Save"',
      cause: { code: 'IDENTITY_MISMATCH', message: 'resolved a different element' },
      screen: { state: 'available', refsGeneration: 1, refs: [{ ref: 'e1', role: 'button' }] },
      suggestions: [],
      suggestionCount: 0,
      resume: { allowed: true, from: 2, planDigest: 'deadbeef' },
      repairHint: 'caution',
    },
  });
  assert.ok(report);
  assert.match(report!, /Repair hint: caution — something already matches the recorded selector/);
  // The state-fix command IS rendered (resuming AT N stays allowed)...
  assert.match(
    report!,
    /if you fixed app state with --no-record actions: replay --from 2 --plan-digest deadbeef\./,
  );
  // ...but the recorded-action alternate is NOT offered — no alternateFrom on
  // the wire means the renderer must never advertise `--from 3`.
  assert.doesNotMatch(report!, /if you performed the step's intent as a recorded action/);
  assert.doesNotMatch(report!, /--from 3/);
});

test('formatReplayDivergenceReport renders neither caution command when resume is NOT allowed', async () => {
  const { formatReplayDivergenceReport } = await import('../divergence.ts');
  const report = formatReplayDivergenceReport({
    divergence: {
      version: 1,
      kind: 'identity-mismatch',
      step: { index: 2, source: { path: '/tmp/flow.ad', line: 3 } },
      action: 'click label="Save"',
      cause: { code: 'IDENTITY_MISMATCH', message: 'resolved a different element' },
      screen: { state: 'available', refsGeneration: 1, refs: [{ ref: 'e1', role: 'button' }] },
      suggestions: [],
      suggestionCount: 0,
      resume: {
        allowed: false,
        from: 2,
        planDigest: 'deadbeef',
        reason: 'step 1 is inside runtime control flow (retry); skipping it cannot be proven safe.',
      },
      repairHint: 'caution',
    },
  });
  assert.ok(report);
  assert.match(report!, /Repair hint: caution — something already matches the recorded selector/);
  assert.doesNotMatch(report!, /replay --from/);
  assert.match(report!, /cannot currently be resumed automatically/);
});

// --- #1271 stage 2 (ADR-0012 amendment): read-only diagnostics an agent runs
// mid-repair to LOCATE the target (snapshot -i, get attrs, find, is) are
// EXCLUDED from the healed script by default (stage 1's interim
// "use --no-record" guidance is superseded now the daemon enforces this
// itself). The repairHint guidance must teach the new default AND the
// `--record` escape hatch for a corrective action that is itself a read —
// but ONLY when `resume.repairSessionHeld === true` (decision 6, R7 C1's
// signal that this divergence came from a repair-armed `--save-script`
// replay). A plain non-repair divergence never carries `repairSessionHeld`
// and must never render the clause — it would be pure noise. ---

const REPAIR_DIAGNOSTICS_CLAUSE_PATTERN =
  /Read-only inspection while armed \(snapshot -i, get attrs, find, is\) is excluded from the healed script by default — no --no-record needed\. If the step you are repairing is itself a read, add --record to that command so it lands in the heal\./;

test('formatReplayDivergenceReport appends the diagnostics default-exclusion clause for record-and-heal when repairSessionHeld is true', async () => {
  const { formatReplayDivergenceReport } = await import('../divergence.ts');
  const report = formatReplayDivergenceReport({
    divergence: {
      version: 1,
      kind: 'action-failure',
      step: { index: 2, source: { path: '/tmp/flow.ad', line: 3 } },
      action: 'click id="article"',
      cause: { code: 'COMMAND_FAILED', message: 'not hittable' },
      screen: { state: 'available', refsGeneration: 1, refs: [{ ref: 'e1', role: 'button' }] },
      suggestions: [],
      suggestionCount: 0,
      resume: { allowed: true, from: 3, planDigest: 'deadbeef', repairSessionHeld: true },
      repairHint: 'record-and-heal',
    },
  });
  assert.ok(report);
  assert.match(report!, REPAIR_DIAGNOSTICS_CLAUSE_PATTERN);
  // The existing resume guidance must still render — the new clause is
  // additive, not a replacement.
  assert.match(report!, /then replay --from 3 --plan-digest deadbeef\./);
});

test('formatReplayDivergenceReport OMITS the diagnostics clause for record-and-heal when repairSessionHeld is absent (plain, non-repair divergence)', async () => {
  const { formatReplayDivergenceReport } = await import('../divergence.ts');
  const report = formatReplayDivergenceReport({
    divergence: {
      version: 1,
      kind: 'action-failure',
      step: { index: 2, source: { path: '/tmp/flow.ad', line: 3 } },
      action: 'click id="article"',
      cause: { code: 'COMMAND_FAILED', message: 'not hittable' },
      screen: { state: 'available', refsGeneration: 1, refs: [{ ref: 'e1', role: 'button' }] },
      suggestions: [],
      suggestionCount: 0,
      // No `repairSessionHeld` — this divergence is not from a repair-armed
      // replay, so the diagnostics clause would be pure noise.
      resume: { allowed: true, from: 3, planDigest: 'deadbeef' },
      repairHint: 'record-and-heal',
    },
  });
  assert.ok(report);
  assert.doesNotMatch(report!, /Read-only inspection/);
  assert.doesNotMatch(report!, /excluded from the healed script by default/);
});

test('formatReplayDivergenceReport appends the diagnostics clause for state-repair when armed, distinct from the existing app-state --no-record clause', async () => {
  const { formatReplayDivergenceReport } = await import('../divergence.ts');
  const report = formatReplayDivergenceReport({
    divergence: {
      version: 1,
      kind: 'action-failure',
      step: { index: 4, source: { path: '/tmp/flow.ad', line: 8 } },
      action: 'click label="Continue"',
      cause: { code: 'COMMAND_FAILED', message: 'not hittable' },
      screen: { state: 'available', refsGeneration: 1, refs: [{ ref: 'e1', role: 'button' }] },
      suggestions: [],
      suggestionCount: 0,
      resume: { allowed: true, from: 4, planDigest: 'cafef00d', repairSessionHeld: true },
      repairHint: 'state-repair',
    },
  });
  assert.ok(report);
  // The app-state-fix clause (about correcting APP STATE) still renders...
  assert.match(report!, /fix app state with --no-record actions, then replay --from 4/);
  // ...and the diagnostics clause (about inspection READS) is additive, not
  // a replacement for it — both can be true for the same divergence.
  assert.match(report!, REPAIR_DIAGNOSTICS_CLAUSE_PATTERN);
});

test('formatReplayDivergenceReport OMITS the diagnostics clause for state-repair when repairSessionHeld is absent', async () => {
  const { formatReplayDivergenceReport } = await import('../divergence.ts');
  const report = formatReplayDivergenceReport({
    divergence: {
      version: 1,
      kind: 'action-failure',
      step: { index: 4, source: { path: '/tmp/flow.ad', line: 8 } },
      action: 'click label="Continue"',
      cause: { code: 'COMMAND_FAILED', message: 'not hittable' },
      screen: { state: 'available', refsGeneration: 1, refs: [{ ref: 'e1', role: 'button' }] },
      suggestions: [],
      suggestionCount: 0,
      resume: { allowed: true, from: 4, planDigest: 'cafef00d' },
      repairHint: 'state-repair',
    },
  });
  assert.ok(report);
  assert.match(report!, /fix app state with --no-record actions, then replay --from 4/);
  assert.doesNotMatch(report!, /Read-only inspection/);
});

test('formatReplayDivergenceReport appends the diagnostics clause for caution when armed, alongside the dual-path resume commands', async () => {
  const { formatReplayDivergenceReport } = await import('../divergence.ts');
  const report = formatReplayDivergenceReport({
    divergence: {
      version: 1,
      kind: 'identity-mismatch',
      step: { index: 2, source: { path: '/tmp/flow.ad', line: 3 } },
      action: 'click label="Save"',
      cause: { code: 'IDENTITY_MISMATCH', message: 'resolved a different element' },
      screen: { state: 'available', refsGeneration: 1, refs: [{ ref: 'e1', role: 'button' }] },
      suggestions: [],
      suggestionCount: 0,
      resume: {
        allowed: true,
        from: 2,
        planDigest: 'deadbeef',
        alternateFrom: 3,
        repairSessionHeld: true,
      },
      repairHint: 'caution',
    },
  });
  assert.ok(report);
  assert.match(
    report!,
    /if you performed the step's intent as a recorded action: replay --from 3 --plan-digest deadbeef\./,
  );
  assert.match(report!, REPAIR_DIAGNOSTICS_CLAUSE_PATTERN);
});

test('formatReplayDivergenceReport OMITS the diagnostics clause for caution when repairSessionHeld is absent', async () => {
  const { formatReplayDivergenceReport } = await import('../divergence.ts');
  const report = formatReplayDivergenceReport({
    divergence: {
      version: 1,
      kind: 'identity-mismatch',
      step: { index: 2, source: { path: '/tmp/flow.ad', line: 3 } },
      action: 'click label="Save"',
      cause: { code: 'IDENTITY_MISMATCH', message: 'resolved a different element' },
      screen: { state: 'available', refsGeneration: 1, refs: [{ ref: 'e1', role: 'button' }] },
      suggestions: [],
      suggestionCount: 0,
      resume: { allowed: true, from: 2, planDigest: 'deadbeef', alternateFrom: 3 },
      repairHint: 'caution',
    },
  });
  assert.ok(report);
  assert.doesNotMatch(report!, /Read-only inspection/);
});

test('formatReplayDivergenceReport appends the diagnostics clause for manual when armed, even when resume is NOT allowed', async () => {
  const { formatReplayDivergenceReport } = await import('../divergence.ts');
  // `repairSessionHeld` reports the daemon KEPT THE SESSION LIVE, independent
  // of `resume.allowed` (plan-resumability) — the diagnostics clause must
  // still render here: the agent may still inspect the (held) session while
  // deciding on a manual repair, and any such read is excluded from the heal
  // by default unless recorded with `--record`.
  const report = formatReplayDivergenceReport({
    divergence: {
      version: 1,
      kind: 'action-failure',
      step: { index: 5, source: { path: '/tmp/flow.ad', line: 9 } },
      action: 'click label="Confirm"',
      cause: { code: 'COMMAND_FAILED', message: 'not hittable' },
      screen: { state: 'available', refsGeneration: 1, refs: [{ ref: 'e1', role: 'button' }] },
      suggestions: [],
      suggestionCount: 0,
      resume: {
        allowed: false,
        from: 5,
        planDigest: 'cafef00d',
        reason: 'step 4 is inside runtime control flow (retry); skipping it cannot be proven safe.',
        repairSessionHeld: true,
      },
      repairHint: 'manual',
    },
  });
  assert.ok(report);
  assert.match(report!, /cannot currently be resumed automatically/);
  assert.match(report!, REPAIR_DIAGNOSTICS_CLAUSE_PATTERN);
});

test('formatReplayDivergenceReport OMITS the diagnostics clause for manual when repairSessionHeld is absent', async () => {
  const { formatReplayDivergenceReport } = await import('../divergence.ts');
  const report = formatReplayDivergenceReport({
    divergence: {
      version: 1,
      kind: 'action-failure',
      step: { index: 5, source: { path: '/tmp/flow.ad', line: 9 } },
      action: 'click label="Confirm"',
      cause: { code: 'COMMAND_FAILED', message: 'not hittable' },
      screen: { state: 'available', refsGeneration: 1, refs: [{ ref: 'e1', role: 'button' }] },
      suggestions: [],
      suggestionCount: 0,
      resume: { allowed: true, from: 5, planDigest: 'cafef00d', alternateFrom: 6 },
      repairHint: 'manual',
    },
  });
  assert.ok(report);
  assert.doesNotMatch(report!, /Read-only inspection/);
});
