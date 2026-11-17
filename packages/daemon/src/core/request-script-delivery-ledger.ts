import type {
  DaemonArtifact,
  DaemonResponse,
  ScriptDeliveryFailure,
  ScriptDeliveryReceipt,
} from '@agent-device/kernel/contracts';
import { readScriptDeliveryFailure } from '@agent-device/kernel/contracts';
import { normalizeBatchCommandName } from '@agent-device/contracts/command';
import type { DaemonRequest } from './daemon-request.ts';
/**
 * The script-delivery ledger of one daemon request (ADR 0016, #4595).
 *
 * A composite request (a `batch`) runs its steps as nested requests. A step that records into an
 * armed remote recording writes a script version, and a step that runs `close` ends the recording.
 * Each of those names its result on the reply of the NESTED request. A client must not read those
 * step results to work out what it should have received: #4582 tried exactly that and every way a
 * batch answer could mislead a client survived six review rounds.
 *
 * So the request that owns the outer reply collects the delivery facts its executed steps answered —
 * as its own runner reports them, because only the runner knows which plan position ran what — and
 * answers ONE receipt on that reply, successful or failed. A request that collected nothing answers
 * no receipt, so every reply a single command gets keeps the shape it had before.
 *
 * Effects stay independent in the ledger: no version is merged into another, no failure is dropped
 * because a version arrived, and a close is named only for a step that really ran one.
 */
export type ScriptDeliveryLedger = {
  /** Whether a nested request fed this ledger: only a composite request answers a receipt. */
  nested: boolean;
  /** Newest version per publication, among the versions the executed steps wrote. */
  versions: Map<string, DaemonArtifact>;
  /** Every typed delivery failure a step disclosed, kept per publication. */
  failures: Map<string, ScriptDeliveryFailure[]>;
  /** The step that closed the recording, and the 1-based plan position that reached it. */
  close?: { publicationId: string; step: number };
};

/**
 * Runs `handle` for an outermost request on a script ledger of its own and reports the delivery its
 * nested requests fed into it on its reply: in `data` on success, in `error.details` on failure,
 * because a failed batch still delivers what its completed steps wrote. A nested request already
 * carries its delegating request's ledger and reports nothing.
 *
 * A request whose ledger no nested request fed answers NO receipt: only a composite collects nested
 * effects, so every single-command reply keeps the shape it had before this receipt existed.
 */
export async function reportScriptDelivery(
  req: DaemonRequest,
  handle: (req: DaemonRequest) => Promise<DaemonResponse>,
): Promise<DaemonResponse> {
  if (req.internal?.scriptDelivery) return await handle(req);
  const scriptDelivery: ScriptDeliveryLedger = {
    nested: false,
    versions: new Map(),
    failures: new Map(),
  };
  const response = await handle({ ...req, internal: { ...req.internal, scriptDelivery } });
  if (response.ok) {
    for (const version of sessionScriptVersions(response.data))
      collectVersion(scriptDelivery, version);
    const failure = readScriptDeliveryFailure(response.data);
    if (failure) collectFailure(scriptDelivery, failure);
  }
  if (!scriptDelivery.nested) return response;
  const publicationId = onlyPublication(scriptDelivery);
  if (publicationId === undefined) return response;
  const receipt = receiptOf(scriptDelivery, publicationId);
  if (!receipt) return response;
  if (response.ok) {
    return { ok: true, data: { ...response.data, scriptDeliveryReceipt: receipt } };
  }
  return {
    ok: false,
    error: {
      ...response.error,
      details: { ...response.error.details, scriptDeliveryReceipt: receipt },
    },
  };
}

/**
 * Records the script-delivery facts one executed batch step answered.
 *
 * Each fact is one the daemon's own handler answered for that step: the `session-script` version a
 * recorded action wrote and registered for download, the typed failure of a version the daemon could
 * not write, and the publication a `close` named on its reply. A failed step wrote no version and
 * closed nothing, so it records nothing; its error reaches the batch error unchanged.
 */
export function collectBatchStepDelivery(
  req: DaemonRequest,
  step: Readonly<{ number: number; command: string }>,
  response: DaemonResponse,
): void {
  const scriptDelivery = req.internal?.scriptDelivery;
  if (!scriptDelivery) return;
  scriptDelivery.nested = true;
  if (!response.ok) return;
  const data = response.data ?? {};
  for (const version of sessionScriptVersions(data)) collectVersion(scriptDelivery, version);
  const failure = readScriptDeliveryFailure(data);
  if (failure) collectFailure(scriptDelivery, failure);
  // A close names the recording it ended on its own reply, whether or not it wrote the final script.
  // Only the runner knows this plan position ran `close`, and only this reply says it happened.
  const closed =
    typeof data.scriptPublicationId === 'string' ? data.scriptPublicationId : undefined;
  if (closed && normalizeBatchCommandName(step.command) === 'close') {
    scriptDelivery.close = { publicationId: closed, step: step.number };
  }
}

/**
 * Adds one version, keeping the newest per publication. A version is already a registered
 * downloadable artifact of the recording, so a receipt names exactly what its writer registered.
 */
function collectVersion(
  scriptDelivery: ScriptDeliveryLedger,
  version: DaemonArtifact | undefined,
): void {
  const publicationId = version?.scriptPublicationId;
  const revision = version?.scriptRevision;
  if (!publicationId || typeof revision !== 'number') return;
  const known = scriptDelivery.versions.get(publicationId)?.scriptRevision;
  if (typeof known === 'number' && known >= revision) return;
  scriptDelivery.versions.set(publicationId, version);
}

function collectFailure(
  scriptDelivery: ScriptDeliveryLedger,
  failure: ScriptDeliveryFailure,
): void {
  const failures = scriptDelivery.failures.get(failure.publicationId);
  if (failures) failures.push(failure);
  else scriptDelivery.failures.set(failure.publicationId, [failure]);
}

/**
 * The one recording a receipt can name. A request that collected facts for two recordings — or for
 * none — answers no receipt rather than guessing one, because one reply delivers one recording.
 */
function onlyPublication(scriptDelivery: ScriptDeliveryLedger): string | undefined {
  const publications = new Set<string>([
    ...scriptDelivery.versions.keys(),
    ...scriptDelivery.failures.keys(),
  ]);
  if (scriptDelivery.close) publications.add(scriptDelivery.close.publicationId);
  return publications.size === 1 ? [...publications][0] : undefined;
}

function receiptOf(
  scriptDelivery: ScriptDeliveryLedger,
  publicationId: string,
): ScriptDeliveryReceipt | undefined {
  const version = scriptDelivery.versions.get(publicationId);
  const failures = scriptDelivery.failures.get(publicationId) ?? [];
  const close =
    scriptDelivery.close?.publicationId === publicationId ? scriptDelivery.close : undefined;
  if (!version && failures.length === 0 && !close) return undefined;
  return {
    publicationId,
    ...(version ? { version } : {}),
    ...(close ? { close: { step: close.step } } : {}),
    ...(failures.length > 0 ? { failures } : {}),
  };
}

/**
 * The `session-script` versions a reply names. Selection is linear in the entries one reply names;
 * an entry that is not a full-script version — a non-object entry, another artifact type, a missing
 * revision — is skipped rather than competing with one that is.
 */
function sessionScriptVersions(data: Record<string, unknown> | undefined): DaemonArtifact[] {
  const artifacts = Array.isArray(data?.artifacts) ? data.artifacts : [];
  return artifacts.filter(isSessionScriptVersion);
}

function isSessionScriptVersion(
  artifact: unknown,
): artifact is DaemonArtifact & { scriptRevision: number; scriptPublicationId: string } {
  if (!artifact || typeof artifact !== 'object') return false;
  const candidate = artifact as Partial<DaemonArtifact>;
  return (
    candidate.field === 'savedScript' &&
    candidate.artifactType === 'session-script' &&
    typeof candidate.scriptPublicationId === 'string' &&
    typeof candidate.scriptRevision === 'number'
  );
}
