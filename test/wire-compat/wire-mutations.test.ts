/**
 * Planted-red proofs: does the gate actually catch each class of wire break?
 * (#1432, review P1.)
 *
 * The ledger and closure tests prove the manifest describes today's source.
 * They cannot prove the manifest describes the RIGHT source — a gate can list
 * 117 declarations, pass every check, and still miss the seam that breaks a
 * skewed peer. So each case below mutates one real listed declaration the way
 * a real break would, and asserts the digest moves.
 *
 * Two guards keep these from going vacuous, which is the standing failure mode
 * for regression tests here (AGENTS.md: "a green check is evidence only once
 * you have seen it red"):
 *
 * 1. every mutation must actually change the source it is applied to, so a
 *    renamed field silently turning the replacement into a no-op fails loudly
 *    rather than passing on an unmutated digest;
 * 2. the unmutated digest must equal the ledger's, so the case is pinned to
 *    the declaration the gate really watches rather than to a stale copy.
 *
 * They run against source text in memory. Nothing on disk is modified.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { isExternalWireSpecifier, WIRE_CLOSURE_WAIVERS } from './closure-policy.ts';
import { findClosureGaps } from './closure.ts';
import { digestDeclaration, replaceInDeclaration } from './declaration-digest.ts';
import { readWireLedger } from './ledger.ts';
import { WIRE_DECLARATIONS, wireDeclarationKey } from './surface.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const ledger = readWireLedger(repoRoot);

function readSource(file: string): string {
  return fs.readFileSync(path.join(repoRoot, file), 'utf8');
}

type WireMutation = {
  /** The ADR 0006 break class this case stands for. */
  breakClass: string;
  file: string;
  name: string;
  /** Substring to replace, and what a real break would replace it with. */
  from: string;
  to: string;
};

const MUTATIONS: readonly WireMutation[] = [
  {
    breakClass: 'method naming: a released client keeps sending the old method name',
    file: 'src/daemon/server/http-server.ts',
    name: 'COMMAND_RPC_METHODS',
    from: "'agent-device.command'",
    to: "'agent-device.cmd'",
  },
  {
    breakClass: 'method naming: the lease method table drops a released alias',
    file: 'src/daemon/server/http-server.ts',
    name: 'LEASE_RPC_METHOD_TO_COMMAND',
    from: "'agent-device.lease.allocate': 'lease_allocate',",
    to: '',
  },
  {
    breakClass: 'response serialization: the RPC envelope stops being newline-framed',
    file: 'src/daemon/request-progress-protocol.ts',
    name: 'serializeDaemonRpcResponseEnvelope',
    from: '}\\n`',
    to: '}`',
  },
  {
    breakClass: 'response parsing: the client narrows what a daemon may return',
    file: 'src/daemon/client/daemon-client-rpc.ts',
    name: 'parseDaemonHttpResponseBody',
    from: 'error?: { message?: string; data?: Record<string, unknown> }',
    to: 'error?: { message: string }',
  },
  {
    breakClass: 'auth projection: the header a released client authenticates with is dropped',
    file: 'src/daemon/server/http-server.ts',
    name: 'resolveToken',
    from: "typeof headers['x-agent-device-token'] === 'string'",
    to: 'false',
  },
  {
    breakClass: 'auth projection: the client stops sending the bearer form',
    file: 'src/daemon/http-contract.ts',
    name: 'buildDaemonHttpAuthHeaders',
    from: 'authorization: `Bearer ${normalizedToken}`,',
    to: '',
  },
  {
    breakClass: 'upload ticket shape: a required preflight field is renamed',
    file: 'src/daemon/resumable-upload.ts',
    name: 'BeginResumableUploadOptions',
    from: 'sha256: string;',
    to: 'checksum: string;',
  },
  {
    breakClass: 'upload ticket shape: the preflight body parser requires a new field',
    file: 'src/daemon/upload-http.ts',
    name: 'readUploadPreflightBody',
    from: "readRequiredText(record, 'uploadAttemptId')",
    to: "readRequiredText(record, 'attemptId')",
  },
  {
    breakClass: '308 framing: resumable upload stops signalling continuation',
    file: 'src/daemon/upload-http.ts',
    name: 'handleResumableUpload',
    from: 'res.statusCode = 308;',
    to: 'res.statusCode = 200;',
  },
  {
    breakClass: 'artifact framing: the direct-upload route prefix moves',
    file: 'src/daemon/upload-http.ts',
    name: 'DIRECT_UPLOAD_PATH_PREFIX',
    from: "'/upload/direct/'",
    to: "'/uploads/direct/'",
  },
  {
    breakClass: 'artifact framing: the artifact inventory route stops answering its released path',
    file: 'src/daemon/downloadable-artifact-http.ts',
    name: 'resolveDownloadableArtifactHttpRoute',
    from: "pathname === '/artifacts' || pathname === '/artifacts/'",
    to: "pathname === '/artifacts'",
  },
  {
    breakClass: 'REST error framing: a released status mapping changes',
    file: 'src/daemon/http-errors.ts',
    name: 'statusCodeForNormalizedError',
    from: 'INVALID_ARGS',
    to: 'BAD_ARGS',
  },
  {
    breakClass: 'progress framing: the envelope discriminant is renamed',
    file: 'src/daemon/request-progress-protocol.ts',
    name: 'DaemonProgressEnvelope',
    from: "type: 'progress';",
    to: "kind: 'progress';",
  },
  // Consumer half of the auxiliary boundaries. A client-only narrowing here
  // rejects a released daemon's response with no server change at all, which is
  // why claiming "both sides" required these to be listed and proved.
  {
    breakClass: 'health consumer: the client stops reading the advertised protocol version',
    file: 'src/daemon/client/daemon-client-transport.ts',
    name: 'readHealthPayload',
    from: "typeof parsed.rpcProtocolVersion === 'number' ? parsed.rpcProtocolVersion : undefined",
    to: 'undefined',
  },
  {
    breakClass: 'health consumer: the mismatch refusal ADR 0006 built is weakened',
    file: 'src/daemon/client/daemon-client-transport.ts',
    name: 'readRemoteDaemonHealth',
    from: 'health.rpcProtocolVersion !== DAEMON_RPC_PROTOCOL_VERSION',
    to: 'false',
  },
  {
    breakClass: 'health consumer: the parsed health shape drops a released field',
    file: 'src/daemon/client/daemon-client-transport.ts',
    name: 'RemoteDaemonHealth',
    from: 'rpcProtocolVersion?: number;',
    to: '',
  },
  {
    breakClass: 'upload consumer: the preflight parser stops accepting a released response',
    file: 'src/remote/upload-client.ts',
    name: 'parseUploadPreflightResult',
    from: "preflight.ok !== true || typeof preflight.uploadId !== 'string'",
    to: 'preflight.ok !== true',
  },
  {
    breakClass: 'upload consumer: the preflight response shape narrows',
    file: 'src/remote/upload-client.ts',
    name: 'UploadPreflightResponse',
    from: 'cacheHit?: boolean;',
    to: '',
  },
  {
    breakClass: 'upload consumer: the legacy/finalize response shape narrows',
    file: 'src/remote/upload-client.ts',
    name: 'UploadResponse',
    from: 'uploadId: string;',
    to: 'id: string;',
  },
  {
    breakClass: 'upload consumer: the finalize request body key is renamed',
    file: 'src/remote/upload-client.ts',
    name: 'finalizeDirectUpload',
    from: 'JSON.stringify({ uploadId: options.uploadId })',
    to: 'JSON.stringify({ id: options.uploadId })',
  },
  {
    breakClass: 'upload consumer: the preflight ticket fields the daemon parses are renamed',
    file: 'src/remote/upload-client-artifact.ts',
    name: 'PreparedUploadArtifact',
    from: 'sha256: string;',
    to: 'checksum: string;',
  },
  {
    breakClass: 'artifact consumer: the download request drops its tenant header',
    file: 'src/remote/daemon-artifacts.ts',
    name: 'downloadRemoteArtifact',
    from: '...buildDaemonHttpTenantHeaders(params.requestScope?.tenantId),',
    to: '',
  },
  {
    breakClass: 'artifact consumer: the artifact URL the client requests moves',
    file: 'src/remote/daemon-artifacts.ts',
    name: 'buildDaemonArtifactUrl',
    from: 'artifacts/',
    to: 'artifact/',
  },
  // The client half of the resumable 308 contract. Listing the daemon's
  // handleResumableUpload proves it still PRODUCES 308; these prove the client
  // still consumes the released one — which offset headers it accepts, how it
  // reads `Range`, what `Content-Range` a resumed PUT emits, and that 308 is
  // still the status it treats as "continue".
  {
    breakClass: '308 consumer: the client stops accepting a released offset header',
    file: 'src/remote/upload-stream.ts',
    name: 'parseUploadResumeOffset',
    from: "headers['x-upload-offset'] ?? headers['upload-offset']",
    to: "headers['x-upload-offset']",
  },
  {
    breakClass: '308 consumer: Range-header offset parsing narrows',
    file: 'src/remote/upload-stream.ts',
    name: 'parseUploadResumeOffset',
    from: '/^bytes=0-(\\d+)$/',
    to: '/^bytes 0-(\\d+)$/',
  },
  {
    breakClass: '308 consumer: the resumed request emits a different Content-Range',
    file: 'src/remote/upload-stream.ts',
    name: 'buildUploadRequestHeaders',
    from: "'content-range': `bytes ${startOffset}-${payloadSize - 1}/${payloadSize}`,",
    to: "'content-range': `bytes=${startOffset}-${payloadSize - 1}/${payloadSize}`,",
  },
  {
    breakClass: '308 consumer: the client stops treating 308 as resume-and-continue',
    file: 'src/remote/upload-stream.ts',
    name: 'isUploadResumeStatus',
    from: 'statusCode === 308',
    to: 'statusCode === 208',
  },
  {
    breakClass: '308 consumer: the streamed response shape a caller parses narrows',
    file: 'src/remote/upload-stream.ts',
    name: 'UploadStreamResponse',
    from: 'statusMessage?: string;',
    to: '',
  },
  {
    breakClass: '308 consumer: header value coercion drops a released form',
    file: 'src/remote/upload-stream.ts',
    name: 'parseNonNegativeIntegerHeader',
    from: 'firstHeaderValue(value)',
    to: 'undefined',
  },
];

for (const mutation of MUTATIONS) {
  test(`gate catches — ${mutation.breakClass}`, () => {
    const key = `${mutation.file}#${mutation.name}`;
    const source = readSource(mutation.file);

    assert.equal(
      digestDeclaration(mutation.file, source, mutation.name),
      ledger.declarations[key],
      `${key} is not pinned at its ledger digest, so this case would prove nothing about the gate.`,
    );

    // Scoped to the declaration's own span: a whole-file replace would silently
    // mutate a sibling that happens to share the substring, and throws rather
    // than no-oping when the text has moved on.
    const mutated = replaceInDeclaration(
      mutation.file,
      source,
      mutation.name,
      mutation.from,
      mutation.to,
    );
    assert.notEqual(mutated, source, `The mutation for ${key} did not change the source.`);

    assert.notEqual(
      digestDeclaration(mutation.file, mutated, mutation.name),
      ledger.declarations[key],
      `${key} absorbed a ${mutation.breakClass} without moving its digest, so the gate would let ` +
        `that break ship. The declaration listed in surface.ts is not the one carrying this ` +
        `contract — list the one that is.`,
    );
  });
}

// The closure's own red proof. Dropping a listed declaration from the claimed
// set stands in for never having listed it: if the walk still reports nothing,
// import/re-export resolution is not actually reaching that type and the
// closure claim is hollow — which is precisely the defect review P1 found.
const CLOSURE_PROBES: readonly { reachedFrom: string; omit: string }[] = [
  {
    // Crosses a package boundary AND a façade re-export
    // (`@agent-device/contracts/progress` → `../request-progress.ts`).
    reachedFrom: 'DaemonProgressEnvelope',
    omit: 'packages/contracts/src/request-progress.ts#RequestProgressEvent',
  },
  {
    // Plain relative import inside src/.
    reachedFrom: 'buildLeaseRpcParams',
    omit: 'src/core/lease-scope.ts#LeaseRpcCommand',
  },
  {
    // Workspace specifier resolved through the package's own exports map.
    reachedFrom: 'DaemonResponse',
    omit: 'packages/kernel/src/errors.ts#DaemonError',
  },
  {
    // The consumer half of the auxiliary upload boundary, added after review:
    // proves those files are genuinely wired into the walk, not just listed.
    reachedFrom: 'requestUploadPreflight',
    omit: 'src/remote/upload-client-artifact.ts#PreparedUploadArtifact',
  },
];

for (const probe of CLOSURE_PROBES) {
  test(`closure catches an unlisted wire type reached from ${probe.reachedFrom}`, () => {
    const claimed = new Set(WIRE_DECLARATIONS.map(wireDeclarationKey));
    assert.ok(
      claimed.delete(probe.omit),
      `${probe.omit} must be listed for this probe to mean anything.`,
    );

    const { omitted, unresolved } = findClosureGaps({
      repoRoot,
      readSource,
      declarations: WIRE_DECLARATIONS,
      claimed,
      waivers: WIRE_CLOSURE_WAIVERS,
      isExternalSpecifier: isExternalWireSpecifier,
    });

    assert.deepEqual(unresolved, [], 'The closure must place every name even while probing.');
    assert.ok(
      omitted.some((entry) => entry.startsWith(`${probe.omit} (`)),
      `Removing ${probe.omit} from the claimed set did not make the closure report it. The walk is ` +
        `not reaching that declaration, so listing it proves nothing.\nReported: ${
          omitted.join(', ') || '(nothing)'
        }`,
    );
  });
}
