/**
 * iOS out-of-process system surfaces that agent-device observes and drives IN PLACE, never by
 * activation: launching or activating the host cancels what it presents (issue #2438), so the
 * runner addresses the host process while it is foreground and the `open` path refuses it. The set
 * is deliberately closed and tiny; add a host only with live evidence that it presents out of
 * process and dies on activation. Rationale per host lives in the canonical fixture
 * `contracts/fixtures/ios-system-surface-hosts.json` (see also docs/adr/0004); this module and the
 * Swift `SystemSurfaceHostRegistry` both mirror it, each guarded by a parity test.
 */

/** Why a system surface is served in place; carried at snapshot-response level as provenance. */
export type IosSystemSurfaceKind = 'web-auth' | 'payment';

/**
 * How a capture of ordinary app content names its surface in a `PostActionSurfaceChange`
 * (`@agent-device/contracts/interaction`), against a host bundle id for a sheet. Lives here, not
 * beside that type, so this module keeps its zero-import closure.
 */
export const APP_SURFACE = 'app';

export type IosSystemSurfaceHost = Readonly<{
  bundleId: string;
  kind: IosSystemSurfaceKind;
  /**
   * Simulator app-binary path fragment the host-side presence probe matches with `pgrep -f`. Only
   * a matched pid's environment is then read, to confirm the process belongs to the requested
   * device. The Swift runner detects the host by bundle id (`XCUIApplication.state`) instead.
   */
  processExecutable: string;
}>;

export const IOS_SYSTEM_SURFACE_HOSTS: readonly IosSystemSurfaceHost[] = Object.freeze([
  Object.freeze({
    bundleId: 'com.apple.SafariViewService',
    kind: 'web-auth' as const,
    processExecutable: 'SafariViewService.app/SafariViewService',
  }),
  Object.freeze({
    bundleId: 'com.apple.PassbookUIService',
    kind: 'payment' as const,
    processExecutable: 'PassbookUIService.app/PassbookUIService',
  }),
]);

const HOST_BY_BUNDLE_ID: ReadonlyMap<string, IosSystemSurfaceHost> = new Map(
  IOS_SYSTEM_SURFACE_HOSTS.map((host) => [host.bundleId, host] as const),
);

/** The registered host for a bundle id, or undefined when it is not a system surface host. */
export function iosSystemSurfaceHost(
  bundleId: string | undefined,
): IosSystemSurfaceHost | undefined {
  return bundleId === undefined ? undefined : HOST_BY_BUNDLE_ID.get(bundleId);
}

/**
 * Whole-snapshot provenance: the capture describes a system surface presented over the session app,
 * not the app itself. Carried at response level (it applies to the entire snapshot) and folded into
 * iOS snapshot lineage so `--verify`/`--settle` never compare an app baseline against a sheet
 * capture. Mirrors the Android system-chrome/system-surface provenance model.
 */
export type IosSystemSurfaceProvenance = Readonly<{
  bundleId: string;
  kind: IosSystemSurfaceKind;
}>;

/**
 * How the agent-facing sentences name each kind of surface. Exhaustive over the kind so a new host
 * kind cannot ship without its wording.
 */
const SURFACE_NOUN: Readonly<Record<IosSystemSurfaceKind, string>> = Object.freeze({
  'web-auth': 'a system web sign-in sheet',
  payment: 'the system Apple Pay sheet',
});

/**
 * Every bundle id that reaches the sentences below came from the registry: the runner stamps only
 * registered hosts, and the wire reader drops anything else. An unregistered id here is a
 * programming error, not a state to describe.
 */
function surfaceNoun(bundleId: string): string {
  const host = HOST_BY_BUNDLE_ID.get(bundleId);
  if (!host) throw new Error(`${bundleId} is not a registered iOS system surface host`);
  return SURFACE_NOUN[host.kind];
}

/**
 * Refusal shown when a user tries to `open` a system surface host directly. These surfaces are not
 * launched; while genuinely presented they appear in the session app's snapshots on their own, and
 * are driven in place. Keyed by callers off `UNSUPPORTED_OPERATION`; the text is the agent-facing
 * explanation.
 */
export function iosSystemSurfaceOpenRefusal(bundleId: string): string {
  return `${bundleId} hosts ${surfaceNoun(bundleId)} and cannot be opened directly — launching or activating it cancels what it presents. While it is on screen it already appears in this session's snapshots; read it and interact with it there without opening it.`;
}

/**
 * The one agent-facing explanation for an iOS capture that faithfully shows an occluding system
 * surface instead of app content. Shared by the direct snapshot warning and every selector-backed
 * consumer (find/wait/get/is) so the disclosure cannot silently drop on one route while surviving
 * on another; generalizes the Android system-surface disclosure.
 */
export function iosSystemSurfaceDisclosure(bundleId: string): string {
  return `This snapshot shows ${surfaceNoun(bundleId)} presented over the app (hosted out of the app process), not app content. Its controls are real and interactive; complete or dismiss the sheet to return to app content.`;
}

/**
 * The agent-facing sentence for a surface TRANSITION between two captures — the post-action
 * observation's case, where the pre-action baseline and the capture taken after the action describe
 * different surfaces. When the AFTER capture is a sheet the standing disclosure applies verbatim;
 * when it is app content again (`to` is {@link APP_SURFACE}) the sentence names the sheet that left,
 * which the standing sentence cannot say.
 */
export function iosSystemSurfaceTransitionDisclosure(change: { from: string; to: string }): string {
  return change.to === APP_SURFACE
    ? `Before this action ${surfaceNoun(change.from)} was presented over the app and it is gone now, so this observation describes app content while the pre-action tree described that sheet.`
    : iosSystemSurfaceDisclosure(change.to);
}
