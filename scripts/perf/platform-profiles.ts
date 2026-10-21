import type { PerfConfig } from './config.ts';

// Local-convenience default for ad-hoc Android runs: an AVD name that `boot` can launch. CI
// passes --serial. The iOS suite drives the fixture app instead (see ios-suite.ts).
const DEFAULT_ANDROID_AVD = 'Pixel_9_Pro_XL_API_37';

export type ProfileSelectors = {
  // A row on the Settings root that pushes a large sub-screen (big a11y tree).
  deepScreen: string;
  // The Settings search field (for press/focus; auto-picks a match).
  searchField: string;
  // A selector that uniquely targets the EDITABLE search field (for fill).
  searchFieldEditable: string;
  // A label reliably visible on the Settings root, for get/is (selector form).
  anchorLabel: string;
  // Plain text of the anchor, for wait text / find (not a selector).
  anchorText: string;
};

export type ResolvedProfile = {
  platform: 'android';
  deviceName: string;
  serial?: string;
  platformFlags: string[]; // --platform; applied to every call (only conflicts if it mismatches a locked session)
  selectorFlags: string[]; // device selectors — ONLY on the session-establishing open / selectorless boot
  appTarget: string; // `open` target for Settings
  selectors: ProfileSelectors;
};

export function resolveProfile(cfg: PerfConfig): ResolvedProfile {
  const avdName = cfg.device ?? DEFAULT_ANDROID_AVD;
  const serialFlags = cfg.serial
    ? ['--serial', cfg.serial, '--android-device-allowlist', cfg.serial]
    : [];
  return {
    platform: 'android',
    deviceName: cfg.serial ? `android (${cfg.serial})` : avdName,
    serial: cfg.serial,
    platformFlags: ['--platform', 'android'],
    selectorFlags: ['--device', avdName, ...serialFlags],
    appTarget: 'com.android.settings',
    selectors: {
      deepScreen: 'text="Network & internet"',
      searchField: 'text="Search Settings"',
      searchFieldEditable: 'editable',
      anchorLabel: 'label="Network & internet"',
      anchorText: 'Network & internet',
    },
  };
}
