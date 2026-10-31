/**
 * The channel↔producer pairs that can actually occur. `xctest` trees come from the local Apple
 * runner, Appium page-source XML, or a cloud provider's AX element tree (Limrun, Revyl, NoMac),
 * and only the runner's output has been through its presentation (clip fold, effective geometry,
 * scope). Logic that assumes those guarantees must key on the producer, never on the channel alone.
 *
 * This table owns both vocabularies: the platform channel (`SnapshotBackend` is its `backend`
 * projection) and the acquisition producer, beside the in-plan `SnapshotCaptureBackend`. Every
 * carrier embeds the pair atomically, so a cross-channel pair does not compile.
 */
export type SnapshotProvenance =
  | {
      backend: 'xctest';
      producer:
        | 'apple-runner'
        | 'simulator-ax-bridge'
        | 'appium-source'
        | 'limrun-ios-tree'
        | 'revyl-ios-tree'
        | 'nomac-ios-tree';
    }
  | { backend: 'android'; producer: 'android-uiautomator' | 'appium-source' }
  | { backend: 'harmonyos-arkui'; producer: 'harmonyos-uitest' }
  | { backend: 'macos-helper'; producer: 'macos-helper' }
  | { backend: 'linux-atspi'; producer: 'linux-atspi' }
  | { backend: 'web'; producer: 'agent-browser' };
