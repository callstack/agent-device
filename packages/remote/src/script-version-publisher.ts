import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { DaemonArtifact, ScriptDeliveryFailure } from '@agent-device/kernel/contracts';
import { shellQuoteIfNeeded } from '@agent-device/kernel/device-shell';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { publishScriptFileSync, scriptAncestryReason } from '@agent-device/host-kit/file';
import type { DaemonArtifactEndpoint, fetchRemoteArtifact } from './daemon-artifacts.ts';
import {
  readRecord,
  recordPath,
  withRecordLock,
  writeRecord,
} from './script-publication-record.ts';

/** The fetch stops at this size, so a daemon cannot fill the caller's memory or disk. */
const MAX_SCRIPT_BYTES = 8 * 1024 * 1024;

/** A published destination, `undefined` when no record matches, or a typed delivery failure. */
type PublishOutcome =
  | Readonly<{ published: string | undefined }>
  | Readonly<{ failure: ScriptDeliveryFailure; error: unknown }>;

type ScriptVersionContext = {
  endpoint: Required<DaemonArtifactEndpoint>;
  req: DaemonWireRequest;
  stateDir: string;
  fetch: typeof fetchRemoteArtifact;
  signal?: AbortSignal;
};

export function scriptVersionTarget(context: ScriptVersionContext, artifact: DaemonArtifact) {
  const { endpoint, req, stateDir } = context;
  const { scriptPublicationId: id, scriptRevision: revision, artifactId } = artifact;
  if (
    artifact.field !== 'savedScript' ||
    artifact.artifactType !== 'session-script' ||
    typeof id !== 'string' ||
    typeof artifactId !== 'string' ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision <= 0
  )
    return undefined;
  const file = recordPath(stateDir, endpoint.baseUrl, req, id);
  const record = readRecord(file);
  return record && { file, record, id, revision, artifactId };
}

/**
 * Publishes one version and returns the destination, `undefined` when no record of this client
 * matches the artifact, or a typed delivery failure. A version no newer than the one published is
 * answered from the record, and nothing is fetched. `closesRecording` says this version is the last
 * one any later command will ask for, so the failure hint offers the recovery that is actually left.
 *
 * The version is fetched into memory, capped at `MAX_SCRIPT_BYTES`. Under the record lock, the
 * revision is compared again and host-kit judges the recorded destination and commits the file in
 * one synchronous call, as a local close-time write does. The first version is linked exclusively
 * unless the open granted `--force`.
 */
export async function publishScriptVersion(
  context: Readonly<ScriptVersionContext>,
  artifact: DaemonArtifact,
  closesRecording: boolean,
): Promise<PublishOutcome> {
  const { endpoint, req } = context;
  const target = scriptVersionTarget(context, artifact);
  if (!target) {
    emitDiagnostic({
      level: 'warn',
      phase: 'session_script_artifact_dropped',
      data: { session: req.session, artifactId: artifact.artifactId },
    });
    return { published: undefined };
  }
  const { file, record, id, revision, artifactId } = target;
  if (revision <= record.revision) return { published: record.destination };
  try {
    const contents = await context.fetch({
      ...endpoint,
      artifactId,
      requestScope: req.meta,
      maxBytes: MAX_SCRIPT_BYTES,
      signal: context.signal,
    });
    return await withRecordLock(file, async () => {
      // Decided from the record as the lock holds it: a close or a newer version may have won meanwhile.
      const current = readRecord(file);
      if (!current) return { published: undefined };
      if (revision <= current.revision) return { published: current.destination };
      // A caller abort while this publish waited for the lock wins: nothing is written (#4518).
      if (context.signal?.aborted) throw createRequestCanceledError({}, context.signal.reason);
      const published = publishScriptFileSync({
        destination: current.destination,
        contents,
        publish: current.revision === 0 && !current.force ? 'link-exclusive' : 'replace',
      });
      writeRecord(file, { ...current, revision });
      return { published };
    });
  } catch (error) {
    return {
      failure: scriptDeliveryFailure(record.destination, id, error, closesRecording),
      error,
    };
  }
}

function scriptDeliveryFailure(
  destination: string,
  publicationId: string,
  error: unknown,
  closing: boolean,
): ScriptDeliveryFailure {
  // Only the exclusive link of the first version can find an existing entry.
  const exists = (error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST';
  const refusal = scriptAncestryReason(error);
  if (refusal) {
    return {
      reason: 'script_delivery_failed',
      cause: refusal,
      publicationId,
      message:
        error instanceof AppError
          ? error.message
          : `The remote script could not be saved to ${destination}.`,
      hint: error instanceof AppError ? (error.details?.hint ?? '') : '',
    };
  }
  const recovery = closing
    ? 'The session is closed, so no later version follows.'
    : 'The next recorded action or close delivers the full recording again.';
  return exists
    ? {
        reason: 'script_delivery_failed',
        cause: 'script_target_exists',
        publicationId,
        message: `A file already exists at ${destination}.`,
        hint: `Remove the existing file, or start a new recording by reusing your original open command with ${recordAgainArguments(destination)}.`,
      }
    : {
        reason: 'script_delivery_failed',
        cause: 'script_download_failed',
        publicationId,
        message: `The remote script could not be saved to ${destination}.`,
        hint: `The file may still hold the previous version. ${recovery}`,
      };
}

/**
 * The arguments that record again to the same file; a bare `--save-script` would pick a new file name. A path with a
 * C0 or C1 control character cannot survive a rendered text line, so they name a placeholder for it instead.
 */
function recordAgainArguments(destination: string): string {
  const control = (char: string) => char < ' ' || (char >= '\u007f' && char <= '\u009f');
  if ([...destination].some(control)) {
    return '--save-script=<path> --force, with the path quoted for your shell';
  }
  return `--save-script=${shellQuoteIfNeeded(destination)} --force`;
}
