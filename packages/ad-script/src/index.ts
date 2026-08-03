/**
 * The `.ad` script codec façade (#1478 P5 scoping dossier, "the codec seam";
 * widened by the P5 review pass, "keep genuinely shared recording vocabulary
 * in its proper shared owner").
 *
 * The canonical `.ad` replay script format — read half (parsing a script into
 * actions) and write half (formatting actions back into script lines) of one
 * artifact, mutually coupled (`script-formatting.ts` calls into the `open`
 * action's writer; `script.ts` calls into its parser). Shared by the daemon's
 * session-script publication writer, the replay engine's script reader, the
 * CLI's `replay export`, and Maestro's failure-label formatting.
 *
 * Also owns the `# agent-device:target-v1` annotation SERDE (wire type,
 * canonical field order, normalization, size caps, payload parsing) and,
 * alongside it, the local-identity + ancestry-prefix matching primitives and
 * their diagnostic diffs (`target-annotation-identity.ts`) — both record/
 * replay-shared `.ad` vocabulary, not engine policy. The companion
 * CLASSIFICATION core (`classifyTargetBindingMatch`,
 * `target-annotation-classification.ts`, decision 3's replay-time
 * verification paths 2-6) moved here too (#1555 review, "complete the
 * binding façade instead of documenting deviations"): its only real
 * consumers are the daemon's record-time self-check
 * (`src/daemon/session-target-evidence.ts`) and replay-time classification
 * wrapper (`src/daemon/handlers/session-replay-target-classification.ts`),
 * neither reachable through `@agent-device/ad-replay`'s
 * `inspectAdReplay`/`runAdReplay`. The annotation SHAPE is not exported here
 * either: it lives in `@agent-device/contracts/replay`, which every consumer
 * (this package included) imports directly.
 *
 * Also owns `${VAR}` scope/env/resolution (`vars.ts`): the same script-
 * language semantics as `env KEY=VALUE` directive parsing, shared by the
 * daemon's replay runtime and the Maestro replay path.
 *
 * Also owns `resolveDeclaredScriptPlatform` (`open-script.ts`, #1555
 * structural-quality review): the platform a script declares before its
 * first real `open` (`runtime` actions, then the `open` action's own
 * attached hint) — `.ad` script semantics, not engine or daemon policy, and
 * needed independently by both `@agent-device/ad-replay`'s plan-digest
 * precedence and the daemon's device-selection platform resolution
 * (`src/daemon/replay-device-selection.ts`), which is exactly the "shared by
 * record/replay AND the daemon" shape this package exists to own.
 */

export {
  parseReplayScriptDetailed,
  readReplayScriptMetadata,
  REPLAY_VAR_KEY_RE,
} from './internal/script.ts';
export type { ParsedReplayScript, ReplayScriptMetadata } from './internal/script.ts';

export { resolveDeclaredScriptPlatform } from './internal/open-script.ts';

export {
  appendScriptSeriesFlags,
  formatDivergenceActionLabel,
  formatScriptArg,
  formatScriptStringLiteral,
  isClickLikeCommand,
  isTouchTargetCommand,
  stripRecordedRefGeneration,
} from './internal/script-utils.ts';

export {
  formatPortableActionLine,
  formatTargetAnnotationLines,
} from './internal/script-formatting.ts';

export {
  normalizeIdentifierField,
  normalizeLabelField,
  normalizeRoleField,
  parseTargetAnnotationV1Payload,
  serializeTargetAnnotationV1,
  truncateToUtf8Bytes,
  utf8ByteLength,
  TARGET_ANNOTATION_MAX_ANCESTRY,
  TARGET_ANNOTATION_MAX_FIELD_BYTES,
  TARGET_ANNOTATION_MAX_PAYLOAD_BYTES,
} from './internal/target-annotation-serde.ts';

export {
  annotationLocalIdentity,
  firstAncestryMismatch,
  identityFieldMismatches,
  matchesAncestryPrefix,
  matchesLocalIdentity,
} from './internal/target-annotation-identity.ts';
export type { LocalIdentity } from './internal/target-annotation-identity.ts';

export { classifyTargetBindingMatch } from './internal/target-annotation-classification.ts';
export type {
  TargetBindingClassification,
  TargetBindingClassificationInput,
} from './internal/target-annotation-classification.ts';

export {
  buildReplayVarScope,
  collectReplayScrubbableVarValues,
  collectReplayShellEnv,
  parseReplayCliEnvEntries,
  readReplayCliEnvEntries,
  readReplayShellEnvSource,
  resolveReplayAction,
} from './internal/vars.ts';
export type { ReplayVarScope } from './internal/vars.ts';
