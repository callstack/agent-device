// The published `agent-device/io` façade. The artifact-adapter vocabulary now lives in
// @agent-device/contracts/artifact-adapter; re-exporting it here keeps the published surface
// unchanged for consumers (a public package entry may re-export its package boundary).
export * from '../io.ts';
export type {
  ArtifactAdapter,
  ArtifactDescriptor,
  CreateTempFileOptions,
  FileInputRef,
  FileOutputRef,
  LocalArtifactAdapterOptions,
  OutputVisibility,
  ReserveOutputOptions,
  ReservedOutputFile,
  ResolveInputOptions,
  ResolvedInputFile,
  TemporaryFile,
} from '@agent-device/contracts/artifact-adapter';
