/**
 * The `.ad` script codec façade (#1478 P5 scoping dossier, "the codec seam").
 *
 * The canonical `.ad` replay script format — read half (parsing a script into
 * actions) and write half (formatting actions back into script lines) of one
 * artifact, mutually coupled (`script-formatting.ts` calls into the `open`
 * action's writer; `script.ts` calls into its parser). Shared by the daemon's
 * session-script publication writer, the replay engine's script reader, the
 * CLI's `replay export`, and Maestro's failure-label formatting.
 *
 * Also owns the `# agent-device:target-v1` annotation SERDE (wire type,
 * canonical field order, normalization, size caps, payload parsing). The
 * companion classification core (`classifyTargetBindingMatch`, local-identity
 * + ancestry-prefix matching) is NOT part of this codec — it stays in
 * `src/replay/target-identity.ts`, which imports the types below.
 */

export {
  parseReplayScriptDetailed,
  readReplayScriptMetadata,
  REPLAY_VAR_KEY_RE,
} from './internal/script.ts';
export type { ParsedReplayScript, ReplayScriptMetadata } from './internal/script.ts';

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
export type {
  TargetAncestryEntry,
  TargetAnnotationV1,
  TargetScrollRegion,
  TargetVerification,
} from './internal/target-annotation-serde.ts';
