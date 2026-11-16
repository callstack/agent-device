import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { DaemonArtifact, DaemonResponse } from '@agent-device/kernel/contracts';
import { isRecord } from '@agent-device/kernel/record';
import type { downloadRemoteArtifact } from './daemon-artifacts.ts';
import type { SessionScriptDelivery } from './session-script-destination.ts';

/** Command name the runner records for a step whose result carries none. */
const UNKNOWN_STEP_COMMAND = 'batch';

/**
 * Delivers the session scripts a `batch` response carries, in step order.
 *
 * A step's `data` is what that command would have answered on its own, so each step is delivered
 * through the session-script owner under its own command name: a step that closes the recording
 * retires this client's record, and a step that only records a version leaves the record open for
 * the next step. The batch's own payload carries the version the daemon stamped after the last step,
 * so it is delivered last under the batch's own command name — after a closing step retired the
 * record, which drops that version instead of writing a stale one. The destination still comes only
 * from the record this client's own `open --save-script` wrote, never from the response, which names
 * artifacts and not paths.
 *
 * A step that cannot save its version keeps the batch successful and reports the typed failure on
 * that step's result, the way the same command does on its own.
 */
export async function deliverRemoteBatchScripts(
  endpoint: Readonly<{ baseUrl: string; token: string }>,
  req: DaemonWireRequest,
  response: Extract<DaemonResponse, { ok: true }>,
  stateDir: string,
  download: typeof downloadRemoteArtifact,
  isScriptArtifact: (artifact: DaemonArtifact | undefined) => boolean,
): Promise<DaemonResponse> {
  const results = readBatchResults(response.data);
  const nextResults: unknown[] = [];
  for (const [index, result] of results.entries()) {
    const delivered = await deliverScripts(endpoint, req, stateDir, download, isScriptArtifact, {
      command: readString(result.command) ?? UNKNOWN_STEP_COMMAND,
      // A copy: the session-script owner narrows the payload it is handed, and the daemon's own
      // response object stays as it arrived.
      data: isRecord(result.data) ? { ...result.data } : undefined,
    });
    nextResults.push(delivered === undefined ? results[index] : { ...result, data: delivered });
  }
  const data = { ...response.data, ...(results.length > 0 ? { results: nextResults } : {}) };
  // The batch's own payload last: it names the newest revision, and a closing step has already
  // retired the record, so a script that arrived after the close is dropped rather than rewritten.
  const deliveredPayload = await deliverScripts(
    endpoint,
    req,
    stateDir,
    download,
    isScriptArtifact,
    {
      command: req.command,
      data,
    },
  );
  return { ok: true, data: deliveredPayload ?? data };
}

/**
 * Delivers one payload's session-script artifacts — a step's result or the batch's own data — or
 * answers `undefined` when that payload carries none and the caller reports it as the daemon
 * answered it.
 *
 * The payload keeps the batch request's own endpoint, tenant and session, which is what lets it
 * reach the record that armed the recording, and takes the command name of its own, which is what
 * makes a terminal `close` retire that record.
 */
async function deliverScripts(
  endpoint: Readonly<{ baseUrl: string; token: string }>,
  req: DaemonWireRequest,
  stateDir: string,
  download: typeof downloadRemoteArtifact,
  isScriptArtifact: (artifact: DaemonArtifact | undefined) => boolean,
  payload: Readonly<{ command: string; data: Record<string, unknown> | undefined }>,
): Promise<Record<string, unknown> | undefined> {
  const data = payload.data;
  const artifacts = Array.isArray(data?.artifacts) ? data.artifacts : [];
  if (!data || !artifacts.some((artifact) => isScriptArtifact(artifact as DaemonArtifact))) {
    return undefined;
  }
  const { sessionScriptDelivery } = await import('./session-script-destination.ts');
  const scripts = sessionScriptDelivery(
    endpoint,
    { ...req, command: payload.command },
    { ok: true, data },
    stateDir,
    download,
  );
  let published = data;
  await scripts.settleAfter(async () => {
    published = await publishStepArtifacts(scripts, data, isScriptArtifact);
    return { ok: true, data: published };
  });
  return published;
}

/**
 * Publishes the session-script artifacts of one payload and keeps every other artifact as the daemon
 * answered it. Only the session-script owner owns `savedScript`; a payload's other artifacts are the
 * daemon's own outputs, which the daemon already wrote on its side.
 */
async function publishStepArtifacts(
  scripts: SessionScriptDelivery,
  data: Record<string, unknown>,
  isScriptArtifact: (artifact: DaemonArtifact | undefined) => boolean,
): Promise<Record<string, unknown>> {
  const nextData = { ...data };
  const kept: DaemonArtifact[] = [];
  for (const artifact of data.artifacts as DaemonArtifact[]) {
    if (!isScriptArtifact(artifact)) {
      kept.push(artifact);
      continue;
    }
    await scripts.publish(artifact, nextData, kept);
  }
  nextData.artifacts = kept;
  return nextData;
}

function readBatchResults(data: unknown): ReadonlyArray<Record<string, unknown>> {
  if (!isRecord(data) || !Array.isArray(data.results)) return [];
  return data.results.filter((result): result is Record<string, unknown> => isRecord(result));
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
