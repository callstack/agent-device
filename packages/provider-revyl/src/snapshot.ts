import type { SnapshotViewportSize } from '@agent-device/kernel/snapshot';
import { snapshotViewportSizeFrom } from '@agent-device/kernel/rect';
import type { SnapshotRuntimeResult } from '@agent-device/contracts/interactor-types';
import { acquireProviderKeyboard } from '@agent-device/contracts/tap-keyboard-occlusion';
import { REVYL_SNAPSHOT_CHANNEL } from './device.ts';
import type { RevylSession } from './revyl-session.ts';

/** Reads one Revyl worker's accessibility tree and the box its actions measure. */
export type RevylSnapshotReader = Readonly<{
  /** The platform's own hierarchy XML: XCUITest-style on iOS, a uiautomator dump on Android. */
  readHierarchyXml(signal?: AbortSignal): Promise<string>;
  /** `health`'s screen size — the box Revyl itself coordinates actions in. */
  viewport(): SnapshotViewportSize | undefined;
}>;

export function createRevylSnapshotReader(session: RevylSession): RevylSnapshotReader {
  return {
    readHierarchyXml: (signal) => session.client.getWorkerHierarchy(session.runId, signal),
    viewport: () =>
      session.screen === undefined
        ? undefined
        : snapshotViewportSizeFrom({ x: 0, y: 0, ...session.screen }),
  };
}

/**
 * Reads one provider snapshot from one Revyl worker.
 *
 * The host presents what this returns: `producer` and `nodes` drive selector resolution and the
 * recorded replay, and an iOS acquisition goes through the host's iOS presenter. Each platform's XML
 * is parsed by the reader that already parses that shape on a WebDriver-backed device, so a selector
 * written against a local simulator or an adb-connected phone resolves here from the same node facts.
 */
export async function captureRevylSnapshot(
  session: RevylSession,
  reader: RevylSnapshotReader,
  signal?: AbortSignal,
): Promise<SnapshotRuntimeResult> {
  const xml = await reader.readHierarchyXml(signal);
  // Parsing and presenting are not cancelable, so the signal is checked once more here: a capture
  // the caller gave up on does not report a snapshot it finished building afterwards.
  signal?.throwIfAborted();
  return session.platform === 'ios'
    ? await captureRevylIosSnapshot(xml)
    : await captureRevylAndroidSnapshot(xml, reader.viewport());
}

/**
 * iOS: the XCUITest-style XML goes through the same source reader, viewport reader, appearance
 * interpreter and keyboard observer the WebDriver-backed iOS devices use, and comes back as an
 * acquisition for the host to present. The viewport is the tree's own window root frame, because
 * that is the box the tree's rects were measured in; `health`'s screen size is not the same claim.
 */
async function captureRevylIosSnapshot(xml: string): Promise<SnapshotRuntimeResult> {
  const { acquireWebDriverIosSnapshot } =
    await import('@agent-device/provider-webdriver/ios-snapshot');
  return acquireWebDriverIosSnapshot(xml);
}

/**
 * Android: the uiautomator dump goes through the same parser the WebDriver-backed Android devices
 * use, including the system-bar subtree labelling, and is presented as a plain snapshot result. The
 * keyboard fact is observed from the tree against the session's screen box, which is the only box
 * Revyl reports; Revyl has no keyboard probe to add to it.
 */
async function captureRevylAndroidSnapshot(
  xml: string,
  viewport: SnapshotViewportSize | undefined,
): Promise<SnapshotRuntimeResult> {
  const { parseWebDriverAndroidSnapshotNodes } =
    await import('@agent-device/provider-webdriver/android-snapshot');
  const { nodes, keyboard } = acquireProviderKeyboard({
    nodes: parseWebDriverAndroidSnapshotNodes(xml),
    viewport: viewport === undefined ? null : { x: 0, y: 0, ...viewport },
  });
  return {
    backend: REVYL_SNAPSHOT_CHANNEL.android,
    producer: 'appium-source',
    nodes,
    keyboard,
    ...(viewport === undefined ? {} : { viewport }),
  } satisfies SnapshotRuntimeResult;
}
