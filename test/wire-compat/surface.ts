/**
 * The daemon RPC wire surface, grouped by the ADR 0006 rule each group serves
 * (#1432).
 *
 * ADR 0006 says exactly when `DAEMON_RPC_PROTOCOL_VERSION` must be bumped, and
 * until this manifest existed nothing checked that it was. The runtime guard
 * (`readRemoteDaemonHealth`) refuses a mismatched peer — but only when someone
 * remembered to bump the constant, so a wire change that skipped the bump left
 * both sides advertising the same protocol while parsing different payloads.
 *
 * The grouping is not decoration: each group quotes the ADR bullet it covers,
 * so a reader can check the manifest against the decision rather than against
 * someone's summary of it. `uncovered` is the honest half — where a bullet is
 * only partly digestible, the group says which part is reviewer-owned and why,
 * instead of implying coverage the digests do not provide.
 *
 * Review P1 (2026-08-10) corrected a real overclaim here: the first version
 * quoted all four bullets but digested only the payload TYPES, leaving the
 * producer and consumer seams — method sets, response serialization, auth
 * projection, upload ticket/308 framing, artifact framing, and the client's
 * own parsers — able to break a skewed peer without moving a listed digest.
 * Both sides of every boundary are now listed, and what remains outside is
 * named in `uncovered` rather than implied to be covered.
 */

export type WireDeclarationRef = {
  /** Repo-relative source file. */
  file: string;
  /** Top-level declaration name, exported or not. */
  name: string;
};

export type WireSurfaceGroup = {
  /** The ADR 0006 "bump it for" bullet this group covers, quoted. */
  adrBullet: string;
  declarations: readonly WireDeclarationRef[];
  /** Part of the bullet the digests deliberately do not cover, and why. */
  uncovered?: string;
};

const KERNEL_CONTRACTS = 'packages/kernel/src/contracts.ts';
const KERNEL_ERRORS = 'packages/kernel/src/errors.ts';
const KERNEL_DEVICE = 'packages/kernel/src/device.ts';
const REQUEST_PROGRESS = 'packages/contracts/src/request-progress.ts';
const HTTP_CONTRACT = 'src/daemon/http-contract.ts';
const HTTP_HEALTH = 'src/daemon/http-health.ts';
const HTTP_ERRORS = 'src/daemon/http-errors.ts';
const HTTP_SERVER = 'src/daemon/server/http-server.ts';
const UPLOAD_HTTP = 'src/daemon/upload-http.ts';
const ARTIFACT_HTTP = 'src/daemon/downloadable-artifact-http.ts';
const REQUEST_DIAGNOSTICS_HTTP = 'src/daemon/request-diagnostics-http.ts';
const HTTP_REQUEST_TARGET = 'src/daemon/http-request-target.ts';
const REMOTE_REQUEST_DIAGNOSTICS = 'src/remote/remote-request-diagnostics.ts';
const PROGRESS_PROTOCOL = 'src/daemon/request-progress-protocol.ts';
const CLIENT_RPC = 'src/daemon/client/daemon-client-rpc.ts';
const CLIENT_PROGRESS = 'src/daemon/client/daemon-client-progress.ts';
const CLIENT_TRANSPORT = 'src/daemon/client/daemon-client-transport.ts';
const UPLOAD_CLIENT = 'src/remote/upload-client.ts';
const REMOTE_ARTIFACTS = 'src/remote/daemon-artifacts.ts';
const UPLOAD_STREAM = 'src/remote/upload-stream.ts';

function from(file: string, ...names: string[]): WireDeclarationRef[] {
  return names.map((name) => ({ file, name }));
}

export const WIRE_SURFACE: readonly WireSurfaceGroup[] = [
  {
    adrBullet: 'HTTP route requirements for /health, /rpc, /upload, or /artifacts/*.',
    declarations: [
      ...from(
        HTTP_CONTRACT,
        'DAEMON_HTTP_BASE_PATH',
        'buildDaemonHttpUrl',
        'buildDaemonHttpBaseUrl',
      ),
      ...from(HTTP_HEALTH, 'DaemonHealthPayload', 'buildDaemonHealthPayload'),
      // A shrunk body limit rejects payloads a released client still sends, so
      // it is a route requirement rather than an implementation detail.
      ...from(HTTP_SERVER, 'MAX_HTTP_RPC_BODY_BYTES'),
      ...from(
        UPLOAD_HTTP,
        'DIRECT_UPLOAD_PATH_PREFIX',
        'UploadHttpRoute',
        'resolveUploadHttpRoute',
        'handleUpload',
        'handleUploadPreflight',
        // Carries the 308 resumable-upload framing (status, headers).
        'handleResumableUpload',
        'handleUploadFinalize',
        'resolveHttpRequestBaseUrl',
      ),
      ...from(
        ARTIFACT_HTTP,
        'DownloadableArtifactHttpRoute',
        'resolveDownloadableArtifactHttpRoute',
        'readArtifactId',
        'readRequestPathname',
      ),
      // Shared by every auxiliary route: how one segment of a request target
      // becomes the id a route matches on.
      ...from(HTTP_REQUEST_TARGET, 'decodeUriSegment'),
      // `/sessions/<session>/requests/<requestId>/diagnostics` (#1801): the
      // route a remote caller fetches a failed request's record by. The
      // resolver owns the path shape and the segment vocabulary; the client's
      // URL builder below is its counterpart.
      ...from(REQUEST_DIAGNOSTICS_HTTP, 'resolveRequestDiagnosticsHttpRoute'),
      ...from(REMOTE_REQUEST_DIAGNOSTICS, 'buildRemoteRequestDiagnosticsUrl'),
      // Consumer side of /health: the client reads this payload and refuses a
      // mismatched peer from it, so a narrowed reader defeats the very check
      // ADR 0006 built. `readRemoteDaemonHealth` is where the comparison lives.
      ...from(
        CLIENT_TRANSPORT,
        'RemoteDaemonHealth',
        'readHealthPayload',
        'readDaemonHttpHealth',
        'readRemoteDaemonHealth',
      ),
    ],
    // What is left is `createDaemonHttpServer`, a 200+ line dispatcher whose
    // body churns for reasons that are not protocol changes. Everything it
    // dispatches WITH — method sets, envelope, error framing, auth projection,
    // request projections — is digested individually above and below, so the
    // uncovered remainder is the wiring plus the two path literals it compares
    // (`/health`, `/rpc`). Those stay reviewer-owned because their failure mode
    // is the loud one: a moved route answers 404 at connect time, before any
    // payload is exchanged. Everything digested here can misparse silently
    // instead, which is what the gate exists to prevent.
    uncovered:
      'createDaemonHttpServer dispatch wiring, and the /health and /rpc path literals inside it: ' +
      'a moved route 404s at connect time rather than misparsing, so it stays reviewer-owned.',
  },
  {
    adrBullet: 'Authentication semantics required to authorize RPC, upload, or artifact requests.',
    declarations: [
      ...from(
        HTTP_CONTRACT,
        'buildDaemonHttpAuthHeaders',
        'DAEMON_HTTP_TENANT_HEADER',
        'buildDaemonHttpTenantHeaders',
      ),
      ...from(
        HTTP_SERVER,
        'HttpAuthHookContext',
        'HttpAuthHookResult',
        'HttpAuthHook',
        'HttpAuthDecision',
        'resolveToken',
        'readHeaderValue',
        'enforceDaemonToken',
        'authorizeAuxiliaryHttpRequest',
      ),
      ...from(UPLOAD_HTTP, 'AuxiliaryHttpAuthorizer', 'buildUploadTicketAuthHeaders'),
      ...from(ARTIFACT_HTTP, 'DownloadableArtifactHttpAuthorizer'),
      // The diagnostics route's authorization: the same token/auth-hook gate as
      // the artifact routes, plus the tenant rule that decides which sessions a
      // caller may read a record from (#1801).
      ...from(REQUEST_DIAGNOSTICS_HTTP, 'RequestDiagnosticsHttpAuthorizer'),
      ...from('src/daemon/session-tenant-scope.ts', 'isTenantOwnedSessionName'),
    ],
  },
  {
    adrBullet:
      'JSON-RPC envelope shape, method naming, request id handling, or command request projection.',
    declarations: [
      ...from(
        KERNEL_CONTRACTS,
        'JsonRpcId',
        'JsonRpcRequestEnvelope',
        'jsonRpcRequestSchema',
        'CommandRpcParams',
        'commandRpcParamsSchema',
        'DaemonRequest',
        'DaemonRequestMeta',
        'SessionRuntimeHints',
        'daemonRuntimeSchema',
        'DaemonInstallSource',
        'DAEMON_LOCK_POLICIES',
        'DaemonLockPolicy',
        'LEASE_BACKENDS',
        'LeaseBackend',
        'SESSION_ISOLATION_MODES',
        'SessionIsolationMode',
        'RESPONSE_LEVELS',
        'ResponseLevel',
      ),
      ...from(KERNEL_DEVICE, 'PLATFORM_SELECTORS', 'PlatformSelector'),
      // The CLI's projection of a command into the request the daemon receives.
      // Its embedded flag/option vocabulary is waived rather than listed — see
      // closure-policy.ts: those reach the peer inside DaemonRequest's untyped
      // `flags`/`input` bags, and ADR 0006 calls new flags additive.
      ...from('src/commands/cli-grammar/types.ts', 'DaemonCommandRequest'),
      // The lease method vocabulary the client and daemon must agree on.
      ...from('src/core/lease-scope.ts', 'LeaseRpcCommand'),
      // Producer side: the method vocabulary a released client sends, and the
      // projections that turn each method's params into a DaemonRequest.
      ...from(
        HTTP_SERVER,
        'JsonRpcRequest',
        'JsonRpcResponse',
        'COMMAND_RPC_METHODS',
        'INSTALL_FROM_SOURCE_RPC_METHODS',
        'RELEASE_MATERIALIZED_PATHS_RPC_METHODS',
        'LEASE_RPC_METHOD_TO_COMMAND',
        'SUPPORTED_RPC_METHODS',
        'isCommandRpcMethod',
        'methodToDaemonRequest',
        'parseCommandRpcParams',
        'toDaemonRequest',
        'toLeaseDaemonRequest',
        'toInstallFromSourceDaemonRequest',
        'toReleaseMaterializedPathsDaemonRequest',
      ),
      // Consumer side: the payload the client actually puts on the wire. A
      // client-only change here breaks an older daemon just as surely.
      ...from(
        CLIENT_RPC,
        'buildHttpRpcPayload',
        'isLeaseRpcCommand',
        'leaseRpcMethodForCommand',
        'buildLeaseRpcParams',
      ),
    ],
  },
  {
    adrBullet:
      'Response, error, artifact, upload, or progress-stream framing that existing clients parse.',
    declarations: [
      ...from(
        KERNEL_CONTRACTS,
        'DaemonResponse',
        'DaemonResponseData',
        'ResponseCost',
        'DaemonArtifact',
        'DaemonArtifactType',
        'DaemonArtifactKnownType',
      ),
      ...from(
        KERNEL_ERRORS,
        'DaemonError',
        'DiagnosticsRecordRef',
        'ErrorCause',
        'readDiagnosticsRecordRef',
      ),
      // "These are wire values" — the progress module says so itself: the daemon
      // serializes them onto the response stream and the CLI reconstructs them.
      ...from(
        REQUEST_PROGRESS,
        'RequestProgressEvent',
        'ReplayTestSuiteProgressEvent',
        'ReplayTestProgressEvent',
        'CommandProgressEvent',
      ),
      ...from(
        PROGRESS_PROTOCOL,
        'DaemonProgressEnvelope',
        'DaemonResponseEnvelope',
        'shouldStreamRequestProgress',
        'isDaemonProgressEnvelope',
        'isDaemonResponseEnvelope',
        'serializeDaemonProgressEnvelope',
        'serializeDaemonResponseEnvelope',
        'serializeDaemonRpcResponseEnvelope',
      ),
      ...from(
        HTTP_SERVER,
        'createRpcError',
        'sendJson',
        'writeProgressEnvelope',
        'writeRpcResponseEnvelope',
        'jsonRpcCodeForNormalizedError',
      ),
      ...from(
        HTTP_ERRORS,
        'NormalizedHttpError',
        'statusCodeForNormalizedError',
        'sendRestJsonError',
        'failStreamedHttpResponse',
      ),
      ...from(
        UPLOAD_HTTP,
        'UploadPreflightBody',
        'UploadFinalizeBody',
        'readUploadPreflightBody',
        'readUploadFinalizeBody',
        'sendJson',
        'sendUploadedArtifactResponse',
      ),
      // The resumable-upload ticket the preflight response hands back.
      ...from('src/daemon/resumable-upload.ts', 'BeginResumableUploadOptions'),
      // `NormalizedHttpError` is `ReturnType<typeof normalizeError>`, so the
      // function and its return type — not a type alias — are what fix the
      // REST error payload a released client parses.
      ...from(KERNEL_ERRORS, 'normalizeError', 'NormalizedError', 'NormalizeErrorContext'),
      ...from(ARTIFACT_HTTP, 'handleArtifactInventory', 'handleArtifactDownload'),
      // Producer and consumer of the diagnostics record body (#1801): what the
      // daemon streams back (status, content type/length) and what the client
      // accepts before it will name the fetched copy as the caller's log path.
      ...from(
        REQUEST_DIAGNOSTICS_HTTP,
        'REQUEST_DIAGNOSTICS_CONTENT_TYPE',
        'RequestDiagnosticsHttpOptions',
        'handleRequestDiagnostics',
      ),
      ...from(
        REMOTE_REQUEST_DIAGNOSTICS,
        'RemoteDiagnosticsEndpoint',
        'RemoteDaemonErrorPayload',
        'localizeRemoteDaemonError',
        'fetchRemoteRequestDiagnostics',
      ),
      // Consumer side: what the client accepts back. A parser narrowed here
      // rejects a released daemon's response without any server change.
      ...from(
        CLIENT_RPC,
        'handleDaemonHttpResponseBody',
        'parseDaemonHttpResponseBody',
        'toDaemonHttpRpcError',
        'rejectDaemonHttpRpcError',
        'appErrorFromDaemonError',
        'resolveDaemonHttpResult',
      ),
      ...from(
        CLIENT_PROGRESS,
        'ProgressResponseFormat',
        'shouldReadDaemonProgressStream',
        'createInvalidDaemonResponseError',
      ),
      // Consumer side of the auxiliary /upload boundary: the shapes the client
      // expects back from preflight, direct/resumable, legacy and finalize, and
      // the parser that decides whether a daemon's preflight is usable at all.
      ...from(
        UPLOAD_CLIENT,
        'ARTIFACT_HASH_ALGORITHM',
        'UploadResponse',
        'UploadPreflightResponse',
        'UploadPreflightResult',
        'parseUploadPreflightResult',
        'isStringRecord',
        'requestUploadPreflight',
        'uploadDirectArtifact',
        'tryDirectUploadWithResume',
        'shouldRetryDirectUpload',
        'finalizeDirectUpload',
        'uploadLegacyArtifact',
      ),
      // The prepared artifact whose fields (sha256, sizeBytes, fileName,
      // artifactType, contentType) ARE the preflight body the daemon parses.
      ...from('src/remote/upload-client-artifact.ts', 'PreparedUploadArtifact'),
      // Consumer side of the resumable 308 contract. Listing the daemon's
      // `handleResumableUpload` proves it still PRODUCES 308; it says nothing
      // about the client still CONSUMING the released one. These own which
      // offset headers are accepted (`x-upload-offset`, `upload-offset`,
      // `Range: bytes=0-N`) and what `Content-Range` a resumed PUT emits.
      //
      // `streamFileToHttpRequestAttempt` is listed despite its size, unlike
      // `createDaemonHttpServer` above: that one only dispatches to handlers
      // that are each digested, while this IS the resume state machine — it
      // decides whether a 308 continues the upload and what the next request
      // carries, so a change to its sequencing alone can break a released
      // daemon while every helper below keeps its digest.
      ...from(
        UPLOAD_STREAM,
        'MAX_UPLOAD_REDIRECTS',
        'UploadStreamResponse',
        'streamFileToHttpRequest',
        'streamFileToHttpRequestAttempt',
        'buildUploadRequestHeaders',
        'isUploadRedirectStatus',
        'isUploadResumeStatus',
        'parseUploadResumeOffset',
        'parseNonNegativeIntegerHeader',
        'firstHeaderValue',
      ),
      // Consumer side of /artifacts/*: URL construction, the inventory/header/
      // body materialization the client performs, and the artifact fields it
      // rewrites on the way through.
      ...from(
        REMOTE_ARTIFACTS,
        'DaemonArtifactEndpoint',
        'buildDaemonArtifactUrl',
        'isRemoteDaemon',
        'DownloadRemoteArtifactParams',
        'downloadRemoteArtifact',
        'materializeRemoteArtifacts',
        'resolveMaterializedArtifactPath',
      ),
    ],
  },
];

/** Stable ledger key for a declaration: `<file>#<name>`. */
export function wireDeclarationKey(ref: WireDeclarationRef): string {
  return `${ref.file}#${ref.name}`;
}

export const WIRE_DECLARATIONS: readonly WireDeclarationRef[] = WIRE_SURFACE.flatMap(
  (group) => group.declarations,
);

/** Files the manifest draws declarations from. */
export const WIRE_SURFACE_FILES: readonly string[] = [
  ...new Set(WIRE_DECLARATIONS.map((ref) => ref.file)),
].sort();
