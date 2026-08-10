/**
 * What the wire-surface closure is allowed to stop at (#1432, review P1).
 *
 * The closure walk fails closed: every type name a listed declaration
 * references must resolve to a listed declaration, or to an entry here. There
 * is no silent skip, because the silent skip WAS the defect — a listed type
 * could grow `foo?: ImportedShape` from an unlisted module and stay green.
 *
 * Two kinds of stop, kept apart because they are different claims:
 *
 * - an EXTERNAL MODULE is outside this repository, so there is no declaration
 *   to digest and no way for a change to it to ship in our tarball;
 * - a WAIVER is a repo declaration the walk reaches that is genuinely not
 *   payload — transport plumbing, a local error class, a callback type. Each
 *   one is a claim someone has to defend in review, which is the point.
 *
 * A waiver stops the walk. If a waived type later starts carrying payload,
 * moving it into `surface.ts` is the fix, not widening this file.
 */

/**
 * Module specifiers whose types have no declaration site in this repo. Prefix
 * match, so `node:http` covers `node:http2` only if spelled out — keep them
 * exact enough to mean something.
 */
const WIRE_EXTERNAL_MODULES: Readonly<Record<string, string>> = {
  'node:http': 'Node HTTP request/response objects are the transport, not the payload on it.',
  'node:stream': 'Stream plumbing carries bytes; the bytes themselves are digested elsewhere.',
  undici: 'HTTP client types belong to the transport library, not to our wire contract.',
};

/**
 * Repo declarations the closure reaches that are deliberately not wire
 * surface. Key is `<file>#<name>`; the value has to say why a change to it
 * cannot change what a skewed peer parses.
 */
export const WIRE_CLOSURE_WAIVERS: Readonly<Record<string, string>> = {
  'packages/kernel/src/errors.ts#AppError':
    'The local error CLASS. Only its projection onto the wire is contractual, and that projection is DaemonError, which is listed.',
  'packages/kernel/src/errors.ts#AppErrorCode':
    'Error-code vocabulary is carried as a plain string in DaemonError.code; adding a code cannot change the envelope a peer parses.',
  'packages/kernel/src/errors.ts#AppErrorDetails':
    'Local detail bag behind AppError; the wire form is DaemonError.details, typed as Record<string, unknown> and listed.',
  'src/daemon/client/daemon-client-metadata.ts#DaemonInfo':
    'Client-side record of where a daemon is listening (pid, ports, state dir). Never serialized into a request or response.',
  'src/daemon/types.ts#DaemonRequest':
    'Re-export alias of the listed kernel DaemonRequest; the declaration that fixes the shape is packages/kernel/src/contracts.ts#DaemonRequest.',
  'src/daemon/types.ts#DaemonResponse':
    'Re-export alias of the listed kernel DaemonResponse; the shape is fixed by packages/kernel/src/contracts.ts#DaemonResponse.',
  'src/daemon/types.ts#DaemonArtifact':
    'Re-export alias of the listed kernel DaemonArtifact; the shape is fixed by packages/kernel/src/contracts.ts#DaemonArtifact.',
  'src/remote/upload-stream.ts#UploadStreamProgressOptions':
    'Byte-progress callback options for local upload rendering. The bytes counted are digested through the request/response declarations; these options never cross the wire.',
  'src/remote/upload-progress.ts#UploadProgressSink':
    'A callback for client-local upload progress rendering. Its events never leave the client, unlike the daemon progress stream, whose envelope and events are listed.',
  'packages/contracts/src/request-progress.ts#RequestProgressSink':
    'A callback type (event) => void. The event it receives is RequestProgressEvent, which is listed; the sink itself never crosses the wire.',

  // The CLI flag/option vocabulary embedded in DaemonCommandRequest. This is
  // the one waiver pair that stops a large subtree, so it is the one to
  // challenge first — the reasoning is ADR 0006's own, not convenience.
  //
  // These types are the CLI-SIDE projection. They do not cross the boundary as
  // typed fields: DaemonRequest carries `input?: Record<string, unknown>` and
  // `flags?: Record<string, unknown>`, both listed, and the flag vocabulary
  // lands inside those bags as plain keys. ADR 0006 then classifies a new flag
  // as additive ("new optional request fields or flags that older daemons can
  // ignore or reject with a normal command error"), explicitly NOT a bump. So
  // digesting them would fire the gate on every new CLI flag for a change the
  // decision says needs no acknowledgment — and a gate that cries wolf gets
  // its acks rubber-stamped, which costs more than the coverage buys.
  //
  // If a flag ever becomes a typed field on DaemonRequest, that changes
  // DaemonRequest's own digest, and the right fix is to list the type here
  // rather than widen this waiver.
  'packages/contracts/src/client-request.ts#InternalRequestOptions':
    'CLI-side option projection; reaches the peer inside DaemonRequest.input/flags (Record<string, unknown>, both listed), and ADR 0006 calls new flags additive.',
  'packages/contracts/src/command-flags.ts#CommandFlags':
    'CLI-side flag vocabulary; reaches the peer inside DaemonRequest.flags (Record<string, unknown>, listed), and ADR 0006 calls new flags additive.',
};

export function isExternalWireSpecifier(specifier: string): boolean {
  return Object.keys(WIRE_EXTERNAL_MODULES).some(
    (prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`),
  );
}
