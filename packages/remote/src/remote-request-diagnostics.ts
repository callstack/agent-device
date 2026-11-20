/**
 * Makes a remote daemon's request diagnostics record readable by the caller
 * (#1801).
 *
 * A daemon renders `logPath` as a path on its own host. For a remote daemon —
 * a CI runner driving an EAS/limrun simulator on someone else's macOS box —
 * that path names a filesystem the caller cannot open, so an agent that follows
 * it loses a turn and a CI job cannot keep the record as an artifact.
 *
 * The daemon-host path is therefore removed from the error at this boundary
 * (`stripDaemonLogPath`, whose result type forbids carrying it further) and a
 * caller-local `logPath` can then come only from the record this module
 * actually fetched. When the fetch cannot happen the error names no path at all
 * and says why instead.
 *
 * Bounded on purpose: one attempt, a short timeout, and a size cap. This runs
 * on a request that already failed, so it must not turn one failure into two.
 */

import { resolveRemoteRequestDiagnosticsPath } from '@agent-device/daemon-contracts/session-artifact-paths';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { addAbortSignal } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DaemonError, DiagnosticsRecordRef } from '@agent-device/kernel/errors';
import { loadNodeHttpRequester } from '@agent-device/host-kit/transport';
import {
  buildDaemonHttpAuthHeaders,
  buildDaemonHttpLeaseHeaders,
  buildDaemonHttpTenantHeaders,
  buildDaemonHttpUrl,
} from '@agent-device/contracts/daemon-http';

const REMOTE_DIAGNOSTICS_FETCH_TIMEOUT_MS = 10_000;
const REMOTE_DIAGNOSTICS_MAX_BYTES = 8 * 1024 * 1024;

export type RemoteDiagnosticsEndpoint = {
  baseUrl: string;
  token: string;
  tenantId?: string;
  leaseId?: string;
};

/**
 * An error payload as it arrived from a REMOTE daemon. `logPath` is typed away
 * rather than merely deleted, so nothing downstream can put the daemon's path
 * back on a value the caller will read.
 */
export type RemoteDaemonErrorPayload = Omit<DaemonError, 'logPath'> & { logPath?: never };

function buildRemoteRequestDiagnosticsUrl(baseUrl: string, ref: DiagnosticsRecordRef): string {
  return buildDaemonHttpUrl(
    baseUrl,
    `sessions/${encodeURIComponent(ref.session)}/requests/${encodeURIComponent(ref.requestId)}/diagnostics`,
  );
}

/**
 * Drops the daemon-host path from a remote error — the only place that happens.
 * It is dropped rather than kept under another key because `diagnosticsRecord`
 * already identifies the same record precisely, without leaving a path shaped
 * like something the caller could open.
 */
function stripDaemonLogPath(error: DaemonError): RemoteDaemonErrorPayload {
  const { logPath: _daemonLogPath, ...rest } = error;
  return rest;
}

/**
 * Rewrites a remote daemon's error so every path it names is one the caller can
 * open: the record is fetched into `<stateDir>/remote-diagnostics/...` and
 * `logPath` points there, or no `logPath` is named and `logPathUnavailable`
 * says which daemon and request the missing record belongs to.
 *
 * Total by contract — it always answers with the daemon's error, never with a
 * failure of its own. Every way of not getting the record is one of the
 * `logPathUnavailable` reasons, so the request that already failed cannot fail
 * a second time on the way to being reported.
 */
export async function localizeRemoteDaemonError(
  error: DaemonError,
  params: {
    endpoint: RemoteDiagnosticsEndpoint;
    stateDir: string;
    requestId?: string;
    /** The caller's cancellation: an aborted request fetches no record, and an abort stops one. */
    signal?: AbortSignal;
  },
): Promise<DaemonError> {
  const payload = stripDaemonLogPath(error);
  const ref = error.diagnosticsRecord;
  const requestId = ref?.requestId ?? params.requestId;
  if (!ref) {
    return withUnavailableRecord(
      payload,
      params.endpoint,
      requestId,
      // A daemon too old to carry the locator, or a failure that never reached
      // a session scope, has no record this route could serve.
      'the daemon named no diagnostics record',
    );
  }

  try {
    const destinationPath = resolveRemoteRequestDiagnosticsPath(params.stateDir, ref);
    const failure = params.signal?.aborted
      ? CANCELED
      : await fetchRemoteRequestDiagnostics({
          endpoint: params.endpoint,
          ref,
          destinationPath,
          signal: params.signal,
        });
    if (failure) {
      return withUnavailableRecord(payload, params.endpoint, requestId, failure);
    }
    return { ...payload, logPath: destinationPath };
  } catch (localizationFailure) {
    return withUnavailableRecord(
      payload,
      params.endpoint,
      requestId,
      localizationFailure instanceof Error
        ? localizationFailure.message
        : String(localizationFailure),
    );
  }
}

function withUnavailableRecord(
  payload: RemoteDaemonErrorPayload,
  endpoint: RemoteDiagnosticsEndpoint,
  requestId: string | undefined,
  reason: string,
): DaemonError {
  return {
    ...payload,
    logPathUnavailable: `remote daemon ${endpoint.baseUrl}, request ${requestId ?? 'unknown'}: ${reason}`,
  };
}

/**
 * Stages one bounded diagnostics record. After the cancellation check, publish the complete
 * record atomically. Return a failure reason if the caller has no record to open.
 */
async function fetchRemoteRequestDiagnostics(params: {
  endpoint: RemoteDiagnosticsEndpoint;
  ref: DiagnosticsRecordRef;
  destinationPath: string;
  signal: AbortSignal | undefined;
}): Promise<string | undefined> {
  const { endpoint, ref, destinationPath, signal } = params;
  let url: URL;
  try {
    url = new URL(buildRemoteRequestDiagnosticsUrl(endpoint.baseUrl, ref));
  } catch {
    return 'daemon base URL is not a valid URL';
  }
  const timeout = AbortSignal.timeout(REMOTE_DIAGNOSTICS_FETCH_TIMEOUT_MS);
  const transfer = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let staging: string | undefined;
  try {
    const transport = await loadNodeHttpRequester(url.protocol);
    const parent = path.dirname(destinationPath);
    await fs.promises.mkdir(parent, { recursive: true });
    transfer.throwIfAborted();

    staging = fs.mkdtempSync(path.join(parent, '.diagnostics-'));
    const staged = path.join(staging, 'record');
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = transport.request(
        {
          protocol: url.protocol,
          host: url.hostname,
          port: url.port,
          method: 'GET',
          path: url.pathname + url.search,
          headers: {
            ...buildDaemonHttpAuthHeaders(endpoint.token),
            ...buildDaemonHttpTenantHeaders(endpoint.tenantId),
            ...buildDaemonHttpLeaseHeaders(endpoint.leaseId),
          },
        },
        resolve,
      );
      request.once('error', reject);
      addAbortSignal(transfer, request).end();
    });
    if (response.statusCode !== 200) {
      response.destroy();
      return `HTTP ${response.statusCode ?? 500}`;
    }
    await pipeline(response, limitRecordSize, fs.createWriteStream(staged, { mode: 0o600 }), {
      signal: transfer,
    });
    transfer.throwIfAborted();
    fs.renameSync(staged, destinationPath);
    return undefined;
  } catch (error) {
    if (signal?.aborted) return CANCELED;
    if (timeout.aborted) return `fetch timed out after ${REMOTE_DIAGNOSTICS_FETCH_TIMEOUT_MS}ms`;
    return error instanceof Error ? error.message : String(error);
  } finally {
    if (staging) await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

async function* limitRecordSize(source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  let bytes = 0;
  for await (const chunk of source) {
    bytes += chunk.length;
    if (bytes > REMOTE_DIAGNOSTICS_MAX_BYTES) {
      throw new Error(`record exceeds ${REMOTE_DIAGNOSTICS_MAX_BYTES} bytes`);
    }
    yield chunk;
  }
}

const CANCELED = 'the request was canceled';
