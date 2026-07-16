import type { ResponseLevel } from '../kernel/contracts.ts';
import { redactDiagnosticData } from '../kernel/redaction.ts';

/**
 * ADR 0012 migration steps 2 + 4: structured replay divergence report.
 *
 * `kind` is `'action-failure'` for an ordinary failed step (step 2), or one
 * of decision 3's three target-binding classes when pre-action verification
 * (step 4, `session-replay-target-verification.ts`) blocks a resolved-target
 * action before it is sent: `selector-miss` (the recorded selector/ref no
 * longer matches anything), `identity-mismatch` (something matches, but not
 * the recorded identity — or a unique/isolated identity-set member differs
 * from the resolution winner), or `identity-unverifiable` (the recording
 * itself carries no trustworthy identity, or several candidates share the
 * recorded identity and neither disambiguation signal isolates one). A
 * target-binding `kind` always carries `targetBinding` with
 * `targetBinding.classification === kind`.
 */
export type ReplayDivergenceKind =
  | 'action-failure'
  | 'selector-miss'
  | 'identity-mismatch'
  | 'identity-unverifiable';

export type ReplayDivergenceTargetBindingKind = Exclude<ReplayDivergenceKind, 'action-failure'>;

/** The identity tier of a `target-v1` annotation (decision 3), as reported on the wire. */
export type ReplayDivergenceTargetIdentity = {
  id?: string;
  role: string;
  label?: string;
};

export type ReplayDivergenceTargetCandidate = {
  ref?: string;
  role: string;
  label?: string;
};

/**
 * ADR 0012 decision 4: the `targetBinding` object attached to a
 * target-binding divergence. `matchCount` follows decision 3's conditional
 * presence rule exactly — present (0..N) on every path that performs
 * resolution, absent (key omitted, never `null`) only when
 * `classification === 'identity-unverifiable'` was reached through path 1
 * (a recorded-`unverifiable` annotation, before any resolution).
 */
export type ReplayDivergenceTargetBinding = {
  classification: ReplayDivergenceTargetBindingKind;
  matchCount?: number;
  recorded: ReplayDivergenceTargetIdentity;
  observed?: ReplayDivergenceTargetIdentity;
  mismatches: string[];
  candidates: ReplayDivergenceTargetCandidate[];
};

export type ReplayDivergenceStepSource = {
  path: string;
  line: number;
};

export type ReplayDivergenceStep = {
  /** 1-based executable-plan ordinal, not a source line. */
  index: number;
  source: ReplayDivergenceStepSource;
};

export type ReplayDivergenceCause = {
  code: string;
  message: string;
  hint?: string;
};

export type ReplayDivergenceScreenRef = {
  ref: string;
  role: string;
  label?: string;
};

/**
 * Discriminated per the ADR: `available` is a fresh, healthy snapshot digest
 * and the only form that issues actionable refs; `unavailable` is returned
 * when capture fails or is sparse and must never fall back to the old
 * session tree or mask the original replay cause.
 */
export type ReplayDivergenceScreen =
  | {
      state: 'available';
      refsGeneration: number;
      refs: ReplayDivergenceScreenRef[];
      truncated?: true;
    }
  | {
      state: 'unavailable';
      reason: string;
      hint?: string;
    };

/** Strongest recorded-identity component the suggestion's selector matched on. */
export type ReplayDivergenceSuggestionBasis = 'id' | 'role-label' | 'label' | 'other';

export type ReplayDivergenceSuggestion = {
  selector: string;
  basis: ReplayDivergenceSuggestionBasis;
  ref?: string;
  role?: string;
  label?: string;
};

/**
 * ADR 0012 decision 4 / migration step 5, refined by decision 6, R2, and
 * #1262. `from` is the 1-based plan ordinal the caller should actually pass
 * to `--from` — NOT always the failed step's own index. It depends on the
 * divergence's `repairHint` (`ReplayRepairHint`, below): for
 * `record-and-heal`, the agent performs the diverged step manually before
 * this report is acted on, so `from` is the failed step's index **+ 1**
 * (resuming AT the failed step would re-diverge on the exact step just
 * repaired); for every other hint (`state-repair`, `caution`, `manual`, and a
 * plain `action-failure`), `from` equals the failed step's index unchanged —
 * and, per #1262, this is UNCONDITIONAL for `caution`/`manual`: `from`
 * (`N`) is never made illegal for these hints, since a `--no-record`
 * app-state fix re-runs the unchanged step. When the diverged step was the
 * plan's LAST step, a `record-and-heal` `from` can equal `actions.length + 1`
 * — a legal EMPTY-TAIL resume (there is nothing left to replay; the runtime
 * executes zero steps and reaches the normal end-of-plan completion path),
 * not an out-of-range error. `caution`/`manual` are genuinely dual-path: they
 * ALSO have a record-and-heal-shaped alternate repair (the agent performs the
 * diverged step's intent as a recorded action instead), resumed at a DIFFERENT
 * ordinal than their own reported `from` — carried as `alternateFrom` (below),
 * never as `resume.from` itself. At the last step that alternate rides the
 * SAME empty-tail authorization `record-and-heal` uses. Every one-past-the-end
 * ordinal is authorized ONLY for the exact session + target that produced it
 * (the daemon tracks a per-session watermark, `session.pendingRecordAndHeal`)
 * and only once a new action proves the corrective press actually happened —
 * never a general "one past the end is fine" for any session.
 *
 * `planDigest` is the SHA-256 digest of the canonical fully expanded plan
 * (`computeReplayPlanDigest`) that produced this report — always present.
 * `allowed` reports whether the daemon can resume AT `from`; `reason` is
 * present only when `allowed` is `false`. This must agree with the
 * `repairHint` text guidance rendered by `formatReplayDivergenceReport`
 * (below) — both are derived from the same computed `from`, and when
 * `allowed` is `false` the text guidance never renders a `--from` command,
 * surfacing `reason` instead.
 *
 * `alternateFrom` (#1262) is the `caution`/`manual` dual-path's SECOND
 * ordinal: their `from` (`N`) is the app-state-fix continuation, and
 * `alternateFrom` (`N + 1`) is the record-and-heal-shaped alternate — the
 * agent performs the diverged step's intent as a recorded action, then
 * resumes PAST it. It is present ONLY when a `--from N + 1` request for THIS
 * divergence would actually be accepted by the daemon. Generic `.ad` plans
 * have no runtime variable producers or control wrappers, so only the
 * empty-tail session requirement can make this alternate unavailable. Absent
 * for every other hint (`record-and-heal`'s
 * `from` already IS the `N + 1` continuation; `state-repair` has no
 * recorded-action alternate). The text guidance
 * (`buildRepairHintGuidance`, below) renders the `N + 1` command iff
 * this field is present — it never re-derives resumability, so text and the
 * structured wire never disagree on the advertised next command.
 *
 * `repairSessionHeld` is decision 6, R7's repair-transaction liveness signal
 * (C1): set `true` by the daemon on ANY divergence from a repair-armed
 * (`--save-script`) replay — independent of `allowed`, which only reports
 * plan-resumability. It is the distinct wire signal that the owning
 * daemon/session was KEPT LIVE and remains addressable for the agent's
 * corrective actions + `replay --from`/`close`. Absent (never `false`) on a
 * plain, non-repair divergence, which gets no keep-alive.
 */
export type ReplayDivergenceResume =
  | {
      allowed: true;
      from: number;
      planDigest: string;
      alternateFrom?: number;
      repairSessionHeld?: true;
    }
  | { allowed: false; from: number; planDigest: string; reason: string; repairSessionHeld?: true };

export type ReplayDivergenceOverflow = {
  omittedBytes: number;
  artifactPath: string;
};

/**
 * ADR 0012 decision 6, R3: the daemon-computed repair routing hint. Always
 * defined (never absent/null) — the mapping in
 * `src/daemon/handlers/session-replay-repair-hint.ts` is total, defaulting
 * to `manual` whenever no safer routing can be proven. A small fixed token,
 * so it is carried at every response level (including `--level digest`) and
 * every projection (text, JSON, client `AppError`, MCP `structuredContent`).
 */
export type ReplayRepairHint = 'record-and-heal' | 'state-repair' | 'caution' | 'manual';

export type ReplayDivergence = {
  version: 1;
  kind: ReplayDivergenceKind;
  step: ReplayDivergenceStep;
  action: string;
  cause: ReplayDivergenceCause;
  screen: ReplayDivergenceScreen;
  suggestions: ReplayDivergenceSuggestion[];
  /** Suggestions available at default/full, independent of how many are carried at this level. */
  suggestionCount: number;
  resume: ReplayDivergenceResume;
  repairHint: ReplayRepairHint;
  overflow?: ReplayDivergenceOverflow;
  artifactUnavailable?: true;
  /** Present iff `kind` is a target-binding kind; `targetBinding.classification === kind`. */
  targetBinding?: ReplayDivergenceTargetBinding;
};

type BoundedResponseLevel = 'digest' | 'default' | 'full';

export const REPLAY_DIVERGENCE_LEVEL_BYTE_LIMITS: Record<BoundedResponseLevel, number> = {
  digest: 8 * 1024,
  default: 24 * 1024,
  full: 64 * 1024,
};

export const REPLAY_DIVERGENCE_DEFAULT_REF_LIMIT = 20;
export const REPLAY_DIVERGENCE_DIGEST_REF_LIMIT = 8;
export const REPLAY_DIVERGENCE_SUGGESTION_LIMIT = 5;
// ADR 0012's 256-UTF-8-byte per-field cap; reached only through the field
// sanitizers below so it is enforced in one place.
const REPLAY_DIVERGENCE_FIELD_BYTE_LIMIT = 256;

function levelForResponseLevel(level: ResponseLevel | undefined): BoundedResponseLevel {
  return level === 'digest' || level === 'full' ? level : 'default';
}

/**
 * UTF-8 byte-accurate truncation with a marker, never splitting a multi-byte
 * codepoint. Used for every individual string field the ADR caps at 256 bytes
 * (labels, ids, selectors, source paths, mismatch values, cause messages,
 * hints).
 */
export function truncateUtf8Field(
  value: string,
  limit = REPLAY_DIVERGENCE_FIELD_BYTE_LIMIT,
): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= limit) return value;
  const marker = '…<truncated>';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const budget = Math.max(0, limit - markerBytes);
  let sliceEnd = budget;
  // Back off until we are not mid-codepoint (UTF-8 continuation bytes are 10xxxxxx).
  while (sliceEnd > 0 && (bytes[sliceEnd]! & 0xc0) === 0x80) sliceEnd -= 1;
  return `${bytes.subarray(0, sliceEnd).toString('utf8')}${marker}`;
}

/** Field sanitizer in the ADR-mandated order: redact first, then truncate. */
export function sanitizeReplayDivergenceField(
  value: string,
  limit = REPLAY_DIVERGENCE_FIELD_BYTE_LIMIT,
): string {
  return truncateUtf8Field(redactDiagnosticData(value), limit);
}

export type ReplayVarScrubEntry = { name: string; value: string };

/**
 * Categorical expanded-variable exclusion (ADR 0012): every occurrence of a
 * replay-scope value is replaced with a `<var:NAME>` marker, whatever the
 * value looks like — this is not shape-based secret redaction.
 */
export function scrubReplayVarValues(value: string, entries: ReplayVarScrubEntry[]): string {
  let output = value;
  for (const entry of entries) {
    if (!entry.value) continue;
    output = output.split(entry.value).join(`<var:${entry.name}>`);
  }
  return output;
}

/** Per-report field sanitizer: variable scrub, then redact, then truncate. */
export function createReplayDivergenceSanitizer(
  scrubVars: ReplayVarScrubEntry[],
): (value: string, limit?: number) => string {
  return (value, limit) =>
    sanitizeReplayDivergenceField(scrubReplayVarValues(value, scrubVars), limit);
}

function boundScreenRefs(screen: ReplayDivergenceScreen, limit: number): ReplayDivergenceScreen {
  if (screen.state !== 'available' || screen.refs.length <= limit) return screen;
  return { ...screen, refs: screen.refs.slice(0, limit), truncated: true };
}

/**
 * Applies one level's array caps only (ref count, suggestion presence/count).
 * Field-level 256-byte truncation is expected to already be applied by the
 * caller at construction time — this function only bounds array shape.
 */
export function applyReplayDivergenceLevelCaps(
  divergence: ReplayDivergence,
  level: ResponseLevel | undefined,
): ReplayDivergence {
  const bounded = levelForResponseLevel(level);
  const refLimit =
    bounded === 'digest' ? REPLAY_DIVERGENCE_DIGEST_REF_LIMIT : REPLAY_DIVERGENCE_DEFAULT_REF_LIMIT;
  const screen = boundScreenRefs(divergence.screen, refLimit);
  const suggestions =
    bounded === 'digest' ? [] : divergence.suggestions.slice(0, REPLAY_DIVERGENCE_SUGGESTION_LIMIT);
  return { ...divergence, screen, suggestions };
}

export function measureReplayDivergenceBytes(divergence: ReplayDivergence): number {
  return Buffer.byteLength(JSON.stringify(divergence), 'utf8');
}

/**
 * Bounds the divergence to the response level's byte ceiling. On overflow,
 * the fuller detail goes to a session-scoped artifact and a minimal
 * divergence is returned; the cause is never dropped, only the screen digest
 * and suggestions.
 */
export function boundReplayDivergence(params: {
  divergence: ReplayDivergence;
  level: ResponseLevel | undefined;
  writeOverflowArtifact: (
    fullDivergence: ReplayDivergence,
  ) => { artifactPath: string } | { artifactUnavailable: true };
}): ReplayDivergence {
  const { divergence, level, writeOverflowArtifact } = params;
  const bounded = levelForResponseLevel(level);
  const limit = REPLAY_DIVERGENCE_LEVEL_BYTE_LIMITS[bounded];
  const capped = applyReplayDivergenceLevelCaps(divergence, level);
  const cappedBytes = measureReplayDivergenceBytes(capped);
  if (cappedBytes <= limit) return capped;

  const omittedBytes = cappedBytes - limit;
  const full = applyReplayDivergenceLevelCaps(divergence, 'full');
  const artifactResult = writeOverflowArtifact(full);
  const minimal = buildMinimalReplayDivergence(capped);
  return 'artifactPath' in artifactResult
    ? { ...minimal, overflow: { omittedBytes, artifactPath: artifactResult.artifactPath } }
    : { ...minimal, artifactUnavailable: true };
}

// Owns the "the minimal fallback always fits the budget" guarantee, so it
// sanitizes every field itself rather than trusting the caller did.
function buildMinimalReplayDivergence(capped: ReplayDivergence): ReplayDivergence {
  return {
    version: capped.version,
    kind: capped.kind,
    step: {
      index: capped.step.index,
      source: {
        path: sanitizeReplayDivergenceField(capped.step.source.path),
        line: capped.step.source.line,
      },
    },
    action: sanitizeReplayDivergenceField(capped.action),
    cause: {
      code: capped.cause.code,
      message: sanitizeReplayDivergenceField(capped.cause.message),
      ...(capped.cause.hint ? { hint: sanitizeReplayDivergenceField(capped.cause.hint) } : {}),
    },
    screen: {
      state: 'unavailable',
      reason: 'omitted-for-size',
      hint:
        'The screen digest and suggestions were omitted to stay within the response byte budget. ' +
        'See overflow.artifactPath (or retry at --level full) for the complete report.',
    },
    suggestions: [],
    suggestionCount: capped.suggestionCount,
    resume: capped.resume,
    repairHint: capped.repairHint,
    // targetBinding is the actual repair value of a target-binding
    // divergence and is small relative to a full screen digest — keep it on
    // the minimal fallback rather than dropping it with the screen/suggestions.
    ...(capped.targetBinding ? { targetBinding: capped.targetBinding } : {}),
  };
}

// Compact human-readable divergence report for text surfaces (CLI, MCP text,
// `test` failures). Repair data (step location, screen availability, ranked
// suggestions, overflow pointer) that the --json/structuredContent paths
// carry must not be dropped on a text path. Reads the loose `details` bag so
// every surface (which holds an error `details` record) can share it.
export function formatReplayDivergenceReport(
  details: Record<string, unknown> | undefined,
): string | null {
  const divergence = details?.divergence;
  if (!divergence || typeof divergence !== 'object') return null;
  const record = divergence as Record<string, unknown>;
  const lines = [
    ...divergenceStepLine(record.step),
    ...divergenceTargetBindingLines(record.kind, record.targetBinding),
    ...divergenceRepairHintLine(record.repairHint, record.resume),
    ...divergenceScreenLine(record.screen),
    ...divergenceSuggestionLines(record.suggestions, record.suggestionCount),
    ...divergenceOverflowLine(record.overflow, record.artifactUnavailable),
  ];
  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * ADR 0012 decision 6, extended per #1262: the repair-routing hint rendered
 * on every text surface (CLI, MCP text, `test` failures) — the same field
 * that rides `structuredContent`/JSON, so a text-only caller still learns
 * which repair sub-flow applies. `record-and-heal`/`state-repair` guidance
 * embeds the CONCRETE `resume.from`/`planDigest` values (computed by
 * `buildReplayDivergenceResume`, decision 6 R2) when `resume.allowed` is
 * true, so a text-only or JSON/MCP-first caller reads the identical next
 * command instead of deriving it. `caution`/`manual` are genuinely dual-path
 * (the daemon cannot know at divergence time which repair applies), so their
 * guidance embeds `--from resume.from` (`N`, unshifted — a `--no-record`
 * app-state fix) whenever `resume.allowed` is true, AND `--from
 * resume.alternateFrom` (`N + 1`, a record-and-heal-shaped recorded corrective
 * action) IFF the wire carries `alternateFrom` — the daemon's own verdict that
 * a `--from N + 1` request would be accepted (`computeReplayResumeAlternateFrom`,
 * `session-replay-resume.ts`). The renderer gates the second command on that
 * field's PRESENCE and never re-derives resumability, so text and the
 * structured wire never disagree on the advertised next command. When
 * `resume.allowed` is false, a resume command is never rendered for any hint,
 * and the reported `reason` is surfaced instead.
 *
 * #1271 stage 1: whenever `resume.repairSessionHeld` is `true` (this
 * divergence is from a repair-armed `--save-script` replay), every hint's
 * guidance also appends `REPAIR_DIAGNOSTICS_NO_RECORD_CLAUSE` — read-only
 * diagnostics used to locate the repair target are recorded into the healed
 * script by default, so the agent must pass `--no-record` on inspection
 * commands. See `buildRepairHintGuidance`.
 */
function divergenceRepairHintLine(repairHint: unknown, resume: unknown): string[] {
  if (typeof repairHint !== 'string') return [];
  const guidance = buildRepairHintGuidance(repairHint, resume);
  return [`Repair hint: ${repairHint}${guidance ? ` — ${guidance}` : ''}`];
}

type ResumeGuidance =
  | { allowed: true; from: number; planDigest: string; alternateFrom: number | undefined }
  | { allowed: false; reason: string | undefined };

/** Reads the parts of `resume` the repair-hint guidance needs; `undefined` when the shape is unreadable. */
function readResumeGuidance(resume: unknown): ResumeGuidance | undefined {
  const record = resume as Record<string, unknown> | undefined;
  if (!record || typeof record.allowed !== 'boolean') return undefined;
  if (!record.allowed) {
    return {
      allowed: false,
      reason: typeof record.reason === 'string' ? record.reason : undefined,
    };
  }
  const { from, planDigest, alternateFrom } = record;
  if (typeof from !== 'number' || typeof planDigest !== 'string' || planDigest.length === 0) {
    return undefined;
  }
  return {
    allowed: true,
    from,
    planDigest,
    // Rendered VERBATIM from the wire; the daemon already proved a `--from
    // alternateFrom` request would be accepted (#1262). The renderer must NOT
    // re-derive it — that is precisely the bug the wire field fixed.
    alternateFrom: typeof alternateFrom === 'number' ? alternateFrom : undefined,
  };
}

function formatResumeCommand(from: number, planDigest: string): string {
  return `replay --from ${from} --plan-digest ${planDigest}`;
}

/**
 * #1271 stage 1 (safe interim; the maintainer's default-exclusion stage 2 is
 * gated on an ADR-0012 amendment): read-only diagnostics an agent runs to
 * LOCATE the repair target (`snapshot -i`, `get attrs`, `find`, `is`) are, by
 * default, recorded into the healed script exactly like the corrective press
 * — the wave-3 E3 experiment measured 0/4 trials producing a clean healed
 * script hands-off, and one recorded `get attrs` caused a second,
 * self-inflicted `identity-mismatch` divergence on fresh replay. Distinct from
 * the existing `--no-record` mentions above (`state-repair`'s "fix app state
 * with --no-record actions", and `buildDualPathRepairHintGuidance`'s
 * state-fix clause), which are about correcting APP STATE, not about
 * inspection reads — both clauses can legitimately apply to the same
 * divergence.
 */
const REPAIR_DIAGNOSTICS_NO_RECORD_CLAUSE =
  'Read-only inspection while armed (snapshot -i, get attrs, find, is) is recorded too — use --no-record on those commands or they will land in the healed script.';

/**
 * Gated on `resume.repairSessionHeld === true` (decision 6, R7 C1): that is
 * the ONLY signal that this divergence came from a repair-armed
 * (`--save-script`) replay, where recorded diagnostics can actually pollute a
 * healed script. It is absent (never `false`) on a plain non-repair
 * divergence, so the clause must never render there — it would be pure noise.
 */
function isRepairSessionHeld(resume: unknown): boolean {
  const record = resume as Record<string, unknown> | undefined;
  return record?.repairSessionHeld === true;
}

function buildRepairHintGuidance(repairHint: string, resume: unknown): string | undefined {
  const guidance = readResumeGuidance(resume);
  const core = buildRepairHintGuidanceCore(repairHint, guidance);
  if (core === undefined) return undefined;
  return isRepairSessionHeld(resume) ? `${core} ${REPAIR_DIAGNOSTICS_NO_RECORD_CLAUSE}` : core;
}

function buildRepairHintGuidanceCore(
  repairHint: string,
  guidance: ResumeGuidance | undefined,
): string | undefined {
  switch (repairHint) {
    case 'record-and-heal':
      return guidance?.allowed
        ? `press the correct control via a blessed @ref from screen.refs (recorded), then ${formatResumeCommand(guidance.from, guidance.planDigest)}.`
        : `press the correct control via a blessed @ref from screen.refs (recorded). ${resumeUnavailableSentence(guidance)}`;
    case 'state-repair':
      return guidance?.allowed
        ? `fix app state with --no-record actions, then ${formatResumeCommand(guidance.from, guidance.planDigest)} to re-run it.`
        : `fix app state with --no-record actions. ${resumeUnavailableSentence(guidance)}`;
    case 'caution':
      return buildDualPathRepairHintGuidance({
        lead: 'something already matches the recorded selector; a blind re-press may repeat the mistake.',
        guidance,
      });
    case 'manual':
      return buildDualPathRepairHintGuidance({
        lead: 'no safe automated repair could be proven; inspect the screen and repair by hand.',
        guidance,
      });
    default:
      return undefined;
  }
}

/**
 * `caution`/`manual` guidance (#1262): the daemon cannot know at divergence
 * time which of two repairs applies. Always offers `--from N` (an app-state
 * fix via `--no-record` actions, then re-run the unchanged step; `resume.from`
 * itself, never shifted for these hints — authorized by `resume.allowed`).
 * ADDITIONALLY offers `--from alternateFrom` (a record-and-heal-shaped
 * recorded corrective action, resuming PAST the diverged step) IFF the wire
 * carries `resume.alternateFrom` — the daemon has already proven such a
 * request would be accepted (`computeReplayResumeAlternateFrom`,
 * `session-replay-resume.ts`). The renderer gates on the field's PRESENCE and
 * never re-derives resumability, so it can never advertise a `--from` the
 * daemon would then refuse (the parity bug #1262's review flagged: `N + 1` is
 * unsafe exactly when the diverged step is a `runScript`/control-flow action,
 * which `resume.allowed` for `N` does not detect). When the alternate is
 * absent, only the state-fix command is shown. Neither command is rendered
 * when `resume.allowed` is false — `N` itself is not resumable, so its
 * alternate is moot.
 */
function buildDualPathRepairHintGuidance(params: {
  lead: string;
  guidance: ResumeGuidance | undefined;
}): string {
  const { lead, guidance } = params;
  if (!guidance?.allowed) return `${lead} ${resumeUnavailableSentence(guidance)}`;
  const stateFixClause = `if you fixed app state with --no-record actions: ${formatResumeCommand(guidance.from, guidance.planDigest)}`;
  if (guidance.alternateFrom === undefined) return `${lead} ${stateFixClause}.`;
  const recordedActionClause = `if you performed the step's intent as a recorded action: ${formatResumeCommand(guidance.alternateFrom, guidance.planDigest)}`;
  return `${lead} ${stateFixClause}; ${recordedActionClause}.`;
}

/** Never renders a `--from` command — only reached when `resume.allowed` is false (or unreadable). */
function resumeUnavailableSentence(guidance: ResumeGuidance | undefined): string {
  if (guidance && !guidance.allowed && guidance.reason) {
    return `This step cannot currently be resumed automatically (${guidance.reason}) — run a fresh full replay instead.`;
  }
  return 'This step cannot currently be resumed automatically — run a fresh full replay instead.';
}

function divergenceTargetBindingLines(kind: unknown, targetBinding: unknown): string[] {
  if (typeof kind !== 'string' || kind === 'action-failure') return [];
  const record = targetBinding as Record<string, unknown> | undefined;
  if (!record) return [];
  return [
    divergenceTargetBindingHeaderLine(kind, record.matchCount),
    ...divergenceTargetBindingMismatchLines(record.mismatches),
    ...divergenceTargetBindingCandidateLines(record.candidates),
  ];
}

function divergenceTargetBindingHeaderLine(kind: string, matchCount: unknown): string {
  const suffix = typeof matchCount === 'number' ? ` (matchCount ${matchCount})` : '';
  return `Target binding: ${kind}${suffix} — recorded target evidence did not verify.`;
}

function divergenceTargetBindingMismatchLines(mismatches: unknown): string[] {
  if (!Array.isArray(mismatches) || mismatches.length === 0) return [];
  return [`  mismatches: ${mismatches.slice(0, 5).join('; ')}`];
}

function divergenceTargetBindingCandidateLines(candidates: unknown): string[] {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  return [
    `  ${candidates.length} candidate(s) shared the recorded identity:`,
    ...candidates.slice(0, 5).map((candidate) => `    ${divergenceScreenRefLine(candidate)}`),
  ];
}

function divergenceStepLine(step: unknown): string[] {
  const record = step as Record<string, unknown> | undefined;
  if (typeof record?.index !== 'number') return [];
  const source = record.source as Record<string, unknown> | undefined;
  const location =
    typeof source?.path === 'string' && typeof source.line === 'number'
      ? ` (${source.path}:${source.line})`
      : '';
  return [`Divergence at step ${record.index}${location}`];
}

// Bound on ref lines in the TEXT report (matches the digest ref cap); the
// full list rides in the structured payload.
const TEXT_REPORT_REF_LINE_LIMIT = 8;

function divergenceScreenLine(screen: unknown): string[] {
  const record = screen as Record<string, unknown> | undefined;
  if (record?.state === 'available' && Array.isArray(record.refs)) {
    return availableScreenLines(record.refs, record.refsGeneration);
  }
  if (record?.state === 'unavailable') {
    return [unavailableScreenLine(record)];
  }
  return [];
}

function availableScreenLines(refs: unknown[], refsGeneration: unknown): string[] {
  const shown = refs.slice(0, TEXT_REPORT_REF_LINE_LIMIT).map(divergenceScreenRefLine);
  const remaining = refs.length - shown.length;
  return [
    `Screen: ${refs.length} actionable ref(s) captured (refsGeneration ${refsGeneration}).`,
    ...shown,
    ...(remaining > 0 ? [`  ... ${remaining} more`] : []),
  ];
}

function unavailableScreenLine(record: Record<string, unknown>): string {
  const hint = typeof record.hint === 'string' && record.hint.length > 0 ? ` ${record.hint}` : '';
  return `Screen: unavailable (${String(record.reason ?? 'unknown')}).${hint}`;
}

function divergenceScreenRefLine(entry: unknown): string {
  const ref = entry as Record<string, unknown>;
  const label = typeof ref.label === 'string' ? ` "${ref.label}"` : '';
  return `  @${String(ref.ref)} [${String(ref.role)}]${label}`;
}

function divergenceSuggestionLines(suggestions: unknown, suggestionCount: unknown): string[] {
  if (Array.isArray(suggestions) && suggestions.length > 0) {
    return ['Suggestions:', ...suggestions.slice(0, 5).map(divergenceSuggestionLine)];
  }
  if (typeof suggestionCount === 'number' && suggestionCount > 0) {
    return [
      `Suggestions: ${suggestionCount} available (omitted at this response level; rerun with --json for the full report).`,
    ];
  }
  return [];
}

function divergenceSuggestionLine(entry: unknown): string {
  const suggestion = entry as Record<string, unknown>;
  const label = typeof suggestion.label === 'string' ? ` "${suggestion.label}"` : '';
  return `  - [${String(suggestion.basis)}]${label} ${String(suggestion.selector)}`;
}

function divergenceOverflowLine(overflow: unknown, artifactUnavailable: unknown): string[] {
  if (overflow && typeof overflow === 'object') {
    return [
      `Full report written to ${String((overflow as Record<string, unknown>).artifactPath)}.`,
    ];
  }
  if (artifactUnavailable === true) {
    return [
      'Full report exceeded the response budget and the overflow artifact could not be written.',
    ];
  }
  return [];
}
