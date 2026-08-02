/**
 * The `ad-replay` package façade (#1478 P5 stage A).
 *
 * STAGE-A WIDE FAÇADE — TEMPORARY. This re-exports every symbol carried over
 * by the mechanical move so root consumers keep working unchanged apart from
 * their import specifier. It is not the intended final shape: a later stage
 * narrows this façade to `inspectAdReplay`/`runAdReplay` once the daemon
 * handlers and runtime wiring move into this package too. Do not treat the
 * current export list as a design decision — it is scaffolding.
 */

export {
  buildReplayVarScope,
  collectReplayScrubbableVarValues,
  collectReplayShellEnv,
  parseReplayCliEnvEntries,
  readReplayCliEnvEntries,
  readReplayShellEnvSource,
  resolveReplayAction,
  resolveReplayString,
} from './internal/vars.ts';
export type { ReplayVarScope, ReplayVarSources } from './internal/vars.ts';

export { computeReplayPlanDigest } from './internal/plan-digest.ts';
export type { ReplayPlanDigestMetadata } from './internal/plan-digest.ts';

export {
  annotationLocalIdentity,
  classifyTargetBindingMatch,
  matchesAncestryPrefix,
  matchesLocalIdentity,
} from './internal/target-identity.ts';
export type {
  LocalIdentity,
  TargetBindingClassification,
  TargetBindingClassificationInput,
} from './internal/target-identity.ts';

export type { ReplayReportAction } from './internal/session-replay-report-action.ts';

export { rankAndDedupeReplaySuggestions } from './internal/session-replay-suggestion-ranking.ts';

// #1478 P5 stage B: the port TYPE only — root's production adapter
// (`src/daemon/replay-selector-port.ts`) implements it against
// `ReplaySelectorPort`'s three operations. The type is what rides in via
// `runAdReplay`'s runtime parameter once the daemon threads it (stage C); no
// selector AST type is ever exported here.
export type {
  ReplaySelectorPort,
  ReplaySelectorGrammar,
  ReplaySelectorExpressionOutcome,
  ReplayRecordedTargetPolicy,
  ReplayRecordedTargetDisambiguation,
  ReplayRecordedTargetResolved,
  ReplayRecordedTargetUnresolved,
  ReplayRecordedTargetResolution,
  ReplaySelectorCandidateAction,
  ReplaySelectorCandidateOptions,
} from './internal/selector-port.ts';
