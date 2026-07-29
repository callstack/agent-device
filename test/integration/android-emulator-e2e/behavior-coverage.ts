export type AndroidEmulatorBehaviorId =
  | 'android-resource-id-selectors'
  | 'cold-start-deep-link-navigation'
  | 'home-recents-restoration'
  | 'orientation-fixture-state'
  | 'safe-keyboard-dismissal';

type BehaviorCoverageEntry = {
  assertion: string;
  level: 'live';
  owner: string;
};

export const ANDROID_EMULATOR_BEHAVIOR_COVERAGE = {
  'android-resource-id-selectors': {
    assertion: 'fixture test IDs are observed as Android resource IDs before their selectors act',
    level: 'live',
    owner: 'smoke:automation-system',
  },
  'cold-start-deep-link-navigation': {
    assertion: 'cold deep link renders payload and normal navigation returns through Back',
    level: 'live',
    owner: 'smoke:automation-system',
  },
  'home-recents-restoration': {
    assertion:
      'Home and Recents produce distinct Android system evidence before fixture restoration',
    level: 'live',
    owner: 'smoke:automation-system',
  },
  'orientation-fixture-state': {
    assertion:
      'fixture window state observes landscape and portrait after Android rotation commands',
    level: 'live',
    owner: 'smoke:automation-system',
  },
  'safe-keyboard-dismissal': {
    assertion: 'keyboard dismiss hides the IME while Checkout form remains on screen',
    level: 'live',
    owner: 'smoke:form-input',
  },
} as const satisfies Record<AndroidEmulatorBehaviorId, BehaviorCoverageEntry>;
