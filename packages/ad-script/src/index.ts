export { parseReplayScriptDetailed, readReplayScriptMetadata } from './internal/script.ts';
export type { ReplayScriptMetadata } from './internal/script.ts';

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
  parseTargetAnnotationV1Payload,
  serializeTargetAnnotationV1,
  utf8ByteLength,
  TARGET_ANNOTATION_MAX_ANCESTRY,
  TARGET_ANNOTATION_MAX_FIELD_BYTES,
  TARGET_ANNOTATION_MAX_PAYLOAD_BYTES,
} from './internal/target-annotation-serde.ts';

export {
  annotationLocalIdentity,
  demoteNonUniqueLocalIdentity,
  firstAncestryMismatch,
  idMatchCountInTree,
  identityFieldMismatches,
  localIdentitiesEqual,
  matchesAncestryPrefix,
  matchesLocalIdentity,
  readNodeLocalIdentity,
  readNodeStructuralDenotation,
  siblingOrdinal,
  structuralDenotationsEqual,
} from './internal/target-annotation-identity.ts';
export type { LocalIdentity } from './internal/target-annotation-identity.ts';

export { classifyTargetBindingMatch } from './internal/target-annotation-classification.ts';

export {
  buildReplayVarScope,
  collectReplayScrubbableVarValues,
  collectReplayShellEnv,
  parseReplayCliEnvEntries,
  readReplayCliEnvEntries,
  readReplayShellEnvSource,
  resolveReplayAction,
} from './internal/vars.ts';

export {
  isMaestroYamlPath,
  maestroBackendRequiredMessage,
  resolveReplayFormat,
} from './internal/format.ts';

export {
  readRecordedInputVariableName,
  recordedInputPlaceholder,
  validateRecordedInputVariableName,
} from './internal/recorded-input.ts';

export {
  buildAncestryChain,
  buildIndexMap,
  filterIdentitySet,
} from './internal/target-evidence-tree.ts';

export { parseReplayInput } from './internal/replay-input.ts';
