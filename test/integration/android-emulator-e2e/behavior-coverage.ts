export type AndroidEmulatorBehaviorId =
  | 'android-resource-id-selectors'
  | 'cold-start-deep-link-navigation'
  | 'helper-backed-gesture-recovery'
  | 'home-recents-restoration'
  | 'ime-owned-input-recovery'
  | 'long-list-scroll-recovery'
  | 'maestro-clickable-first-selection'
  | 'orientation-fixture-state'
  | 'push-broadcast-delivery'
  | 'runtime-permission-recovery'
  | 'safe-back-navigation'
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
  'runtime-permission-recovery': {
    assertion:
      'the fixture observes microphone permission granted by its prompt, then denied after Android revocation',
    owner: 'full:lifecycle-system',
  },
  'ime-owned-input-recovery': {
    assertion:
      'the Android IME diagnostic remains reachable after text input and keyboard recovery returns to the app field',
    owner: 'full:lifecycle-system',
  },
  'push-broadcast-delivery': {
    assertion:
      'an Android push broadcast with typed extras is rendered by the fixture after its native receiver records it',
    owner: 'full:lifecycle-system',
  },
  'helper-backed-gesture-recovery': {
    assertion:
      'the Android helper-backed direct gesture flow observes one- and two-pointer motion plus every transform effect',
    owner: 'full:fixture-replays',
  },
  'long-list-scroll-recovery': {
    assertion:
      'fixture traversal reaches the footer, returns to the top, and rediscovers the catalog landmark',
    owner: 'full:fixture-replays',
  },
  'maestro-clickable-first-selection': {
    assertion:
      'one Android helper snapshot exposes two duplicate resource-id nodes and a no-index Maestro tap selects the clickable duplicate first',
    owner: 'smoke:maestro-clickable-first',
  },
  'safe-back-navigation': {
    assertion: 'Back leaves the fixture automation route through normal in-app navigation',
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
