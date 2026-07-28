export type IosSimulatorBehaviorId =
  | 'background-foreground-resume'
  | 'cold-start-deep-link-navigation'
  | 'host-focus-preservation'
  | 'interrupted-system-ui-flow'
  | 'long-list-scroll-recovery'
  | 'modal-open-close'
  | 'permission-state-recovery'
  | 'text-entry-keyboard-lifecycle';

type BehaviorCoverageEntry =
  | {
      assertion: string;
      level: 'live';
      owner: string;
    }
  | {
      assertion: string;
      level: 'workflow-live';
      owner: { path: string; test: string };
    };

/**
 * Cross-command mobile usage patterns requested by #320. Command ownership
 * remains exhaustive in coverage-manifest.ts; this table prevents that
 * command-level view from hiding missing end-to-end journeys.
 */
export const IOS_SIMULATOR_BEHAVIOR_COVERAGE = {
  'cold-start-deep-link-navigation': {
    assertion: 'a terminated fixture opens a deep route, renders payload, and navigates back',
    level: 'live',
    owner: 'smoke:automation-input',
  },
  'text-entry-keyboard-lifecycle': {
    assertion:
      'fill opens the keyboard, before/after pixels prove dismissal, and type appends text',
    level: 'live',
    owner: 'smoke:form-input',
  },
  'background-foreground-resume': {
    assertion: 'Home backgrounds the fixture and its persisted transition survives foregrounding',
    level: 'live',
    owner: 'full:lifecycle-system',
  },
  'modal-open-close': {
    assertion: 'a native page-sheet modal opens structurally and closes through its control',
    level: 'live',
    owner: 'smoke:automation-input',
  },
  'permission-state-recovery': {
    assertion:
      'microphone reset, grant, denial, and second reset produce exact app-observed states',
    level: 'live',
    owner: 'full:lifecycle-system',
  },
  'interrupted-system-ui-flow': {
    assertion: 'Home and app switcher expose distinct system pixels before fixture restoration',
    level: 'live',
    owner: 'full:lifecycle-system',
  },
  'long-list-scroll-recovery': {
    assertion: 'direction, bottom footer, reverse movement, and top rediscovery are all observed',
    level: 'live',
    owner: 'full:fixture-replays',
  },
  'host-focus-preservation': {
    assertion:
      'when the hosted runner can establish a Finder canary, it remains frontmost across simulator automation',
    level: 'workflow-live',
    owner: {
      path: '.github/workflows/ios.yml',
      test: 'Assert simulator automation preserved host focus',
    },
  },
} as const satisfies Record<IosSimulatorBehaviorId, BehaviorCoverageEntry>;
