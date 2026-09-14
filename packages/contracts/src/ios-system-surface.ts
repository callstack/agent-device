/**
 * iOS out-of-process system surfaces that agent-device observes and drives IN PLACE, never by
 * activation.
 *
 * `com.apple.SafariViewService` hosts `ASWebAuthenticationSession` and `SFSafariViewController`
 * out of the app's process. It is presented over a still-foreground app, and any
 * `XCUIApplication.activate()` or `simctl launch` on it cancels the authentication session and
 * blacks the view (issue #2438). So the runner reads and drives it without activation, and the
 * `open` path refuses to launch it. The set is deliberately closed and tiny; add a host only with
 * live evidence that it presents out of process and dies on activation.
 *
 * The canonical membership lives in `contracts/fixtures/ios-system-surface-hosts.json`; this module
 * and the Swift `SystemSurfaceHostRegistry` both mirror it, each guarded by a parity test.
 */

/** Why a system surface is served in place; carried at snapshot-response level as provenance. */
export type IosSystemSurfaceKind = 'web-auth';

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
]);

const HOST_BY_BUNDLE_ID: ReadonlyMap<string, IosSystemSurfaceHost> = new Map(
  IOS_SYSTEM_SURFACE_HOSTS.map((host) => [host.bundleId, host] as const),
);

/** The bundle id, if any, is a known observe-in-place system surface host. */
export function isIosSystemSurfaceHost(bundleId: string | undefined): boolean {
  return bundleId !== undefined && HOST_BY_BUNDLE_ID.has(bundleId);
}

/**
 * Refusal shown when a user tries to `open` a system surface host directly. These surfaces are not
 * launched; while genuinely presented they appear in the session app's snapshots on their own, and
 * are driven in place. Keyed by callers off `UNSUPPORTED_OPERATION`; the text is the agent-facing
 * explanation.
 */
export function iosSystemSurfaceOpenRefusal(bundleId: string): string {
  return `${bundleId} is a system-hosted surface (e.g. a web sign-in sheet) that cannot be opened directly — launching or activating it cancels what it presents. While it is on screen it already appears in this session's snapshots; read it and interact with it there without opening it.`;
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
 * The one agent-facing explanation for an iOS capture that faithfully shows an occluding system
 * surface (a web sign-in sheet) instead of app content. Shared by the direct snapshot warning and
 * every selector-backed consumer (find/wait/get/is) so the disclosure cannot silently drop on one
 * route while surviving on another; generalizes the Android system-surface disclosure.
 */
export const IOS_SYSTEM_SURFACE_DISCLOSURE =
  'A system web sign-in sheet is presented over the app, so this snapshot shows that sheet (hosted out of the app process). Its controls are real and interactive; complete or dismiss the sheet to return to app content.';

/**
 * The agent-facing sentence for a surface TRANSITION between two captures — the post-action
 * observation's case, where the pre-action baseline and the capture taken after the action describe
 * different surfaces. `to` is the surface the AFTER capture describes: a host bundle id when the
 * sheet is now on screen (the standing disclosure applies verbatim), or `undefined` when the sheet
 * has left and the capture shows app content again, which the standing sentence cannot say.
 */
export function iosSystemSurfaceTransitionDisclosure(to: string | undefined): string {
  return to === undefined
    ? 'A system web sign-in sheet was presented over the app before this action and is gone now, so this observation describes app content while the pre-action tree described that sheet.'
    : IOS_SYSTEM_SURFACE_DISCLOSURE;
}
