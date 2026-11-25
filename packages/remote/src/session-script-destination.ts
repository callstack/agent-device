import crypto from 'node:crypto';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type {
  DaemonArtifact,
  DaemonResponse,
  ScriptDeliveryFailure,
  ScriptDeliveryReceipt,
} from '@agent-device/kernel/contracts';
import { readScriptDeliveryReceipt } from '@agent-device/kernel/contracts';
import type { DaemonError } from '@agent-device/kernel/errors';
import { readResponseWarnings } from '@agent-device/kernel/success-text';
import { assertScriptArtifactsCapability } from '@agent-device/daemon-contracts/daemon-resolution';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type {
  DaemonArtifactEndpoint,
  RemoteDaemonArtifactEndpoint,
  fetchRemoteArtifact,
} from './daemon-artifacts.ts';
import {
  createRecord,
  readRecord,
  recordPath,
  removeRecord,
  withRecordLock,
} from './script-publication-record.ts';
import { publishScriptVersion } from './script-version-publisher.ts';

type RemoteEndpoint = DaemonArtifactEndpoint & { capabilities?: readonly string[] };

/**
 * Sends a remote `open --save-script`. Before the open leaves, the client mints a publication ID
 * and records the caller destination and the `--force` grant under it. The serialized request
 * carries the ID and omits the destination. A daemon answer that does not name the ID removes the
 * record. A failed open may still have armed the recording, so it keeps the record. A record that
 * outlives its open stays inert: only artifacts of its own ID match it.
 */
export async function sendRemoteScriptOpen(
  info: RemoteEndpoint,
  req: DaemonWireRequest,
  stateDir: string,
  send: (req: DaemonWireRequest) => Promise<DaemonResponse>,
): Promise<DaemonResponse> {
  assertScriptArtifactsCapability(info.capabilities);
  const { savedScript: destination, ...clientArtifactPaths } = req.meta?.clientArtifactPaths ?? {};
  if (!info.baseUrl || !destination) throw new Error('A remote script open needs a destination.');
  const publicationId = crypto.randomUUID();
  const file = recordPath(stateDir, info.baseUrl, req, publicationId);
  await createRecord(file, { destination, force: req.flags?.force === true, revision: 0 });
  const meta = { ...req.meta, clientArtifactPaths, scriptPublicationId: publicationId };
  const response = await send({ ...req, meta });
  if (!response.ok || response.data?.scriptPublicationId !== publicationId) {
    // A record that cannot be removed stays inert, so the open's own outcome is reported.
    await withRecordLock(file, async () => removeRecord(file)).catch(() => {});
  }
  return response;
}

export type SessionScriptDelivery = Readonly<{
  /** Publishes one script artifact and names it in `data`, or drops it from the response. */
  publish(
    artifact: DaemonArtifact,
    data: Record<string, unknown>,
    kept: DaemonArtifact[],
  ): Promise<void>;
  /** Runs the downloads of one response, then retires the record a close names. */
  settleAfter(
    run: (scripts: SessionScriptDelivery) => Promise<DaemonResponse>,
  ): Promise<DaemonResponse>;
}>;

/**
 * Settles the one delivery receipt a response names (ADR 0016, #4595): at most one version
 * fetched, and the record retired when the receipt names a close.
 *
 * The receipt is validated against THIS client's record — exact publication ID, tenant, session and
 * endpoint. A receipt naming a recording this client never opened under that scope authorizes nothing
 * and says so in the diagnostic, because a response never establishes a destination.
 */
async function settleScriptReceipt(
  context: Readonly<{
    endpoint: RemoteDaemonArtifactEndpoint;
    req: DaemonWireRequest;
    stateDir: string;
    fetch: typeof fetchRemoteArtifact;
  }>,
  receipt: ScriptDeliveryReceipt,
  data: Record<string, unknown>,
): Promise<ReceiptSettlement> {
  const { endpoint, req, stateDir } = context;
  for (const failure of receipt.failures ?? []) {
    discloseDeliveryFailure(data, req, failure, undefined);
  }
  const file = recordPath(stateDir, endpoint.baseUrl, req, receipt.publicationId);
  const record = readRecord(file);
  if (!record) {
    emitDiagnostic({
      level: 'warn',
      phase: 'session_script_artifact_dropped',
      data: { session: req.session, publicationId: receipt.publicationId },
    });
    return {};
  }
  // The daemon names a close only for a step that ran one, so the receipt's close retires the record.
  const closes = receipt.close !== undefined;
  const published = receipt.version
    ? await publishScriptVersion(context, receipt.version, closes)
    : undefined;
  if (published && 'failure' in published) {
    discloseDeliveryFailure(data, req, published.failure, published.error);
  }
  const destination = published && 'published' in published ? published.published : undefined;
  return {
    ...(closes ? { retire: file } : {}),
    ...(destination !== undefined && receipt.version?.artifactId !== undefined
      ? { artifactId: receipt.version.artifactId, published: destination }
      : {}),
  };
}

type ReceiptSettlement = {
  retire?: string;
  published?: string;
  artifactId?: string;
};

/** Retires a record without letting a failure here replace the request's own outcome. */
function retireQuietly(req: DaemonWireRequest, file: string): Promise<void> {
  return withRecordLock(file, async () => removeRecord(file)).catch((retireError: unknown) =>
    emitDiagnostic({
      level: 'warn',
      phase: 'session_script_retire_failed',
      data: { session: req.session, error: String(retireError) },
    }),
  );
}

/**
 * Publishes the session-script artifacts of one remote response to the destinations this client
 * recorded, and retires the record that a close names. A version that cannot be saved keeps the
 * response successful and adds `scriptDeliveryFailure` and a warning. A close retires its record
 * even when another artifact fails, and the first error is the one reported.
 *
 * A response that names a delivery receipt (#4595) delivers THROUGH that receipt: at most its one
 * version is downloaded, and the receipt's failures and close are what the client acts on. The
 * session-script artifacts such a response still lists are then dropped rather than downloaded, so
 * one response never moves two versions. An entry that is not shaped as one script artifact is
 * dropped without touching any response field: a peer cannot erase a disclosure or a publication
 * this client already made.
 */
export function sessionScriptDelivery(
  endpoint: RemoteDaemonArtifactEndpoint,
  req: DaemonWireRequest,
  response: Extract<DaemonResponse, { ok: true }>,
  stateDir: string,
  fetch: typeof fetchRemoteArtifact,
): SessionScriptDelivery {
  const context = { endpoint, req, stateDir, fetch };
  const receipt = req.command === 'batch' ? readScriptDeliveryReceipt(response) : undefined;
  const rejected =
    receipt === undefined &&
    req.command === 'batch' &&
    response.data?.scriptDeliveryReceipt !== undefined
      ? unreadableReceiptFailure()
      : undefined;
  const named = response.data?.scriptPublicationId;
  const closedId = req.command === 'close' && typeof named === 'string' ? named : undefined;
  // The receipt's own version is downloaded before the artifact loop runs, so the loop learns the
  // published destination from here rather than downloading anything a second time.
  let settled: ReceiptSettlement | undefined;
  const delivery: SessionScriptDelivery = {
    publish: async (artifact, data, kept) => {
      if (artifact.field !== 'savedScript' || artifact.artifactType !== 'session-script') return;
      // The receipt is the one delivery instruction of this response; a step's or the batch's own
      // artifact entry is the same version it already names, so it is never downloaded a second time.
      if (req.command === 'batch') {
        if (settled?.published && artifact.artifactId === settled.artifactId) {
          data.savedScript = settled.published;
          kept.push({ ...artifact, localPath: settled.published });
        }
        return;
      }
      const outcome = await publishScriptVersion(context, artifact, req.command === 'close');
      if ('failure' in outcome) {
        // A delivery failure never changes the outcome of the action that recorded the version.
        discloseDeliveryFailure(data, req, outcome.failure, outcome.error);
        return;
      }
      const { published } = outcome;
      if (published === undefined) return;
      data.savedScript = published;
      kept.push({ ...artifact, localPath: published });
    },
    settleAfter: async (run) => {
      const data = response.data ?? {};
      if (rejected) discloseDeliveryFailure(data, req, rejected, undefined);
      settled = receipt ? await settleScriptReceipt(context, receipt, data) : undefined;
      try {
        return await run(delivery);
      } finally {
        // A record that cannot be retired stays inert, so the request keeps its own outcome.
        if (settled?.retire) await retireQuietly(req, settled.retire);
        else if (closedId !== undefined)
          await retireQuietly(req, recordPath(stateDir, endpoint.baseUrl, req, closedId));
      }
    },
  };
  return delivery;
}

function unreadableReceiptFailure(): ScriptDeliveryFailure {
  return {
    reason: 'script_delivery_failed',
    publicationId: '',
    message: 'The daemon answered a malformed script delivery receipt.',
    hint: 'No batch recording was delivered from it. Update the daemon or proxy, then run the batch again.',
  };
}

/**
 * Adds one delivery failure and its warning to a response body's disclosure fields. One field
 * reports the latest failure; all earlier failures remain in the receipt and their paired warnings —
 * the text of every failure still reaches the caller.
 */
function discloseDeliveryFailure(
  data: Record<string, unknown>,
  req: DaemonWireRequest,
  failure: ScriptDeliveryFailure,
  error: unknown,
): void {
  data.scriptDeliveryFailure = failure;
  data.warnings = [...readResponseWarnings(data), `${failure.message} ${failure.hint}`];
  emitDiagnostic({
    level: 'warn',
    phase: 'session_script_delivery_failed',
    data: { session: req.session, ...(error === undefined ? {} : { error: String(error) }) },
  });
}

/**
 * Settles the one delivery receipt a FAILED response names (#4595), where no successful-artifact
 * path runs: a batch that stopped mid-plan still delivers what its completed steps wrote. The
 * disclosure rides the error the caller receives.
 */
export async function settleScriptDeliveryReceiptOfFailure(
  endpoint: RemoteDaemonArtifactEndpoint,
  req: DaemonWireRequest,
  error: DaemonError,
  stateDir: string,
  fetch: typeof fetchRemoteArtifact,
): Promise<DaemonError> {
  if (req.command !== 'batch') return error;
  const receipt = readScriptDeliveryReceipt({ ok: false, error });
  if (!receipt) {
    if (error.details?.scriptDeliveryReceipt === undefined) return error;
    const details = { ...error.details };
    discloseDeliveryFailure(details, req, unreadableReceiptFailure(), undefined);
    return { ...error, details };
  }
  const data: Record<string, unknown> = { ...(error.details ?? {}) };
  const settled = await settleScriptReceipt({ endpoint, req, stateDir, fetch }, receipt, data);
  if (settled.retire) await retireQuietly(req, settled.retire);
  const disclosure: Record<string, unknown> = {
    ...(data.scriptDeliveryFailure === undefined
      ? {}
      : { scriptDeliveryFailure: data.scriptDeliveryFailure }),
    ...(data.warnings === undefined ? {} : { warnings: data.warnings }),
  };
  if (Object.keys(disclosure).length === 0) return error;
  return { ...error, details: { ...(error.details ?? {}), ...disclosure } };
}
