import type { DaemonArtifactType } from '@agent-device/kernel/contracts';

export type FileInputRef =
  | {
      kind: 'path';
      path: string;
    }
  | {
      kind: 'uploadedArtifact';
      id: string;
    };

export type FileOutputRef =
  | {
      kind: 'path';
      path: string;
    }
  | {
      kind: 'downloadableArtifact';
      clientPath?: string;
      fileName?: string;
    };

export type ArtifactDescriptor =
  | {
      kind: 'localPath';
      field: string;
      artifactType: DaemonArtifactType | undefined;
      path: string;
      fileName?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      kind: 'artifact';
      field: string;
      artifactType: DaemonArtifactType | undefined;
      artifactId: string;
      fileName?: string;
      url?: string;
      clientPath?: string;
      metadata?: Record<string, unknown>;
    };

export type OutputVisibility = 'client-visible' | 'internal';

export type ResolvedInputFile = {
  path: string;
  cleanup?: () => Promise<void>;
};

export type ReservedOutputFile = {
  path: string;
  visibility: OutputVisibility;
  publish: () => Promise<ArtifactDescriptor | undefined>;
  cleanup?: () => Promise<void>;
};

export type TemporaryFile = {
  path: string;
  visibility: 'internal';
  cleanup: () => Promise<void>;
};

export type ResolveInputOptions = {
  usage: string;
  field?: string;
};

export type ReserveOutputOptions = {
  field: string;
  ext: string;
  artifactType: DaemonArtifactType | undefined;
  requestedClientPath?: string;
  visibility?: OutputVisibility;
};

export type CreateTempFileOptions = {
  prefix: string;
  ext: string;
};

export type ArtifactAdapter = {
  resolveInput(ref: FileInputRef, options: ResolveInputOptions): Promise<ResolvedInputFile>;
  reserveOutput(
    ref: FileOutputRef | undefined,
    options: ReserveOutputOptions,
  ): Promise<ReservedOutputFile>;
  createTempFile(options: CreateTempFileOptions): Promise<TemporaryFile>;
};

export type LocalArtifactAdapterOptions = {
  cwd?: string;
  tempDir?: string;
  rootDir?: string;
};
