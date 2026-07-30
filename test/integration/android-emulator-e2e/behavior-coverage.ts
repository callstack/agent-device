export type AndroidEmulatorBehaviorId =
  | 'android-resource-id-selectors'
  | 'cold-start-deep-link-navigation'
  | 'home-recents-restoration'
  | 'orientation-fixture-state'
  | 'safe-keyboard-dismissal'
  | 'system-ime-keyboard'
  | 'test-ime-restoration'
  | 'test-ime-unicode-input';

type BehaviorCoverageEntry = {
  assertion: string;
  owner: string;
};

export const ANDROID_EMULATOR_BEHAVIOR_COVERAGE = {
  'android-resource-id-selectors': {
    assertion: 'fixture test IDs are observed as Android resource IDs before their selectors act',
    owner: 'smoke:automation-system',
  },
  'cold-start-deep-link-navigation': {
    assertion: 'cold deep link renders payload and normal navigation returns through Back',
    owner: 'smoke:automation-system',
  },
  'home-recents-restoration': {
    assertion:
      'Home and Recents produce distinct Android system evidence before fixture restoration',
    owner: 'smoke:automation-system',
  },
  'orientation-fixture-state': {
    assertion:
      'fixture window state observes landscape and portrait after Android rotation commands',
    owner: 'smoke:automation-system',
  },
  'safe-keyboard-dismissal': {
    assertion: 'keyboard dismiss hides the IME while Checkout form remains on screen',
    owner: 'smoke:keyboard-ime',
  },
  'system-ime-keyboard': {
    assertion: 'visible keyboard belongs to the emulator system IME rather than the test helper',
    owner: 'smoke:keyboard-ime',
  },
  'test-ime-restoration': {
    assertion:
      'closing the form session restores the prior system IME with structured doctor proof',
    owner: 'smoke:form-input',
  },
  'test-ime-unicode-input': {
    assertion: 'the exact test IME package commits a Unicode form value that is read back',
    owner: 'smoke:form-input',
  },
} as const satisfies Record<AndroidEmulatorBehaviorId, BehaviorCoverageEntry>;
