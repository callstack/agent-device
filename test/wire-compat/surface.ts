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

function kernelContracts(...names: string[]): WireDeclarationRef[] {
  return names.map((name) => ({ file: KERNEL_CONTRACTS, name }));
}

export const WIRE_SURFACE: readonly WireSurfaceGroup[] = [
  {
    adrBullet: 'HTTP route requirements for /health, /rpc, /upload, or /artifacts/*.',
    declarations: [
      { file: 'src/daemon/http-contract.ts', name: 'DAEMON_HTTP_BASE_PATH' },
      { file: 'src/daemon/http-contract.ts', name: 'buildDaemonHttpUrl' },
      { file: 'src/daemon/http-contract.ts', name: 'buildDaemonHttpBaseUrl' },
      { file: 'src/daemon/http-health.ts', name: 'DaemonHealthPayload' },
      { file: 'src/daemon/http-health.ts', name: 'buildDaemonHealthPayload' },
      { file: 'src/daemon/upload-http.ts', name: 'DIRECT_UPLOAD_PATH_PREFIX' },
      { file: 'src/daemon/upload-http.ts', name: 'UploadHttpRoute' },
      { file: 'src/daemon/upload-http.ts', name: 'resolveUploadHttpRoute' },
      {
        file: 'src/daemon/downloadable-artifact-http.ts',
        name: 'DownloadableArtifactHttpRoute',
      },
      {
        file: 'src/daemon/downloadable-artifact-http.ts',
        name: 'resolveDownloadableArtifactHttpRoute',
      },
    ],
    // `/health` and `/rpc` are matched by string comparison inside larger
    // request handlers (`src/daemon/server/http-server.ts`), so digesting them
    // would mean digesting a handler whose body churns for reasons that are not
    // protocol changes. They are left to review because their failure mode is
    // the loud one: a moved route answers 404 at connect time, before any
    // payload is exchanged. Everything digested here can misparse silently
    // instead, which is what the gate exists to prevent.
    uncovered:
      'The /health and /rpc path literals live inside http-server.ts request handlers; a moved ' +
      'route 404s at connect time rather than misparsing, so it stays reviewer-owned.',
  },
  {
    adrBullet: 'Authentication semantics required to authorize RPC, upload, or artifact requests.',
    declarations: [
      { file: 'src/daemon/http-contract.ts', name: 'buildDaemonHttpAuthHeaders' },
      { file: 'src/daemon/http-contract.ts', name: 'DAEMON_HTTP_TENANT_HEADER' },
      { file: 'src/daemon/http-contract.ts', name: 'buildDaemonHttpTenantHeaders' },
    ],
  },
  {
    adrBullet:
      'JSON-RPC envelope shape, method naming, request id handling, or command request projection.',
    declarations: [
      ...kernelContracts(
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
      { file: KERNEL_DEVICE, name: 'PLATFORM_SELECTORS' },
      { file: KERNEL_DEVICE, name: 'PlatformSelector' },
      // The CLI's projection of a command into the request the daemon receives.
      { file: 'src/commands/cli-grammar/types.ts', name: 'DaemonCommandRequest' },
    ],
  },
  {
    adrBullet:
      'Response, error, artifact, upload, or progress-stream framing that existing clients parse.',
    declarations: [
      ...kernelContracts(
        'DaemonResponse',
        'DaemonResponseData',
        'ResponseCost',
        'DaemonArtifact',
        'DaemonArtifactType',
        'DaemonArtifactKnownType',
      ),
      { file: KERNEL_ERRORS, name: 'DaemonError' },
      // "These are wire values" — the progress module says so itself: the daemon
      // serializes them onto the response stream and the CLI reconstructs them.
      ...(
        [
          'RequestProgressEvent',
          'ReplayTestSuiteProgressEvent',
          'ReplayTestProgressEvent',
          'CommandProgressEvent',
        ] as const
      ).map((name) => ({ file: 'packages/contracts/src/request-progress.ts', name })),
      { file: 'src/daemon/request-progress-protocol.ts', name: 'DaemonProgressEnvelope' },
      { file: 'src/daemon/request-progress-protocol.ts', name: 'DaemonResponseEnvelope' },
      { file: 'src/daemon/request-progress-protocol.ts', name: 'serializeDaemonProgressEnvelope' },
      { file: 'src/daemon/request-progress-protocol.ts', name: 'isDaemonProgressEnvelope' },
      { file: 'src/daemon/request-progress-protocol.ts', name: 'isDaemonResponseEnvelope' },
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

/**
 * Files the manifest draws declarations from. The closure check only looks for
 * omitted siblings here: a type declared in a file the wire surface never
 * touches cannot be reached by a peer parsing a payload.
 */
export const WIRE_SURFACE_FILES: readonly string[] = [
  ...new Set(WIRE_DECLARATIONS.map((ref) => ref.file)),
].sort();
