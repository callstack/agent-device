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
 * `src/daemon/replay/internal/session-replay-repair-hint.ts` is total, defaulting
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
