// Falsification fixtures for every named benchmark expectation (the
// EXPECTATION_SCORERS registry in ../help-conformance-case-checks.mjs, keyed
// by scripts/__tests__/help-conformance-expectation-falsification.test.ts via
// KNOWN_EXPECTATIONS). "An oracle nobody has seen fail" is exactly what a
// benchmark check can silently rot into — a scorer whose regex or predicate
// stopped matching anything still reports every plan as passing. Each entry
// here proves the opposite: a minimal plan the scorer must accept, and at
// least one plan it must reject. `metamorphic`, where present, is a second
// passing plan built from different domain nouns/values, proving the scorer
// keys on plan shape rather than memorizing the witness's specific content.
//
// Fixtures are plain `commands` arrays — the same shape `extractCommands`
// hands to the scorer pipeline — run through the REAL
// validatePlanCommands/scoreExpectations production path so a fixture cannot
// drift from what the bench itself does with a model's plan.

export type ExpectationWitness = {
  commands: string[];
  allowedExternalCommands?: string[];
};

export type ExpectationCounterexample = ExpectationWitness & {
  id: string;
};

export type ExpectationFixture = {
  passing: ExpectationWitness;
  counterexamples: ExpectationCounterexample[];
  metamorphic?: ExpectationWitness;
};

export const EXPECTATION_FIXTURES: Record<string, ExpectationFixture> = {
  validPlanCommands: {
    passing: {
      commands: [
        'agent-device open com.example.app',
        'agent-device get text @e5',
        'agent-device close',
      ],
    },
    counterexamples: [
      {
        // The @ref/@id-prefix contract is the whole point of "agent-device
        // <verb>"; a bare lifecycle verb silently drops the prefix instead of
        // failing the command, so the plan runs nothing.
        id: 'swallowedLifecyclePrefix',
        commands: ['open com.example.app', 'agent-device close'],
      },
      {
        id: 'unsupportedFlag',
        commands: ['agent-device wait --selector role=button'],
      },
      {
        id: 'unsupportedSelectorCombination',
        commands: ['agent-device is role=button label=Following'],
      },
      {
        id: 'pseudoRef',
        commands: ['agent-device press @<search-ref> --settle'],
      },
      {
        id: 'shellOperator',
        commands: ['agent-device snapshot -i | tee evidence.txt'],
      },
      {
        // get's grammar is (format, ref) in that order; swapping them feeds
        // the ref where "text"/"attrs" is expected.
        id: 'invalidPositionalOrdering',
        commands: ['agent-device get @e5 text'],
      },
    ],
    metamorphic: {
      commands: [
        'agent-device open com.example.other',
        'agent-device get text @e9',
        'agent-device close',
      ],
    },
  },
  fullPrefix: {
    passing: {
      commands: ['agent-device open com.example.app', 'agent-device close'],
    },
    counterexamples: [
      {
        id: 'bareOpenPrefix',
        commands: ['open com.example.app', 'agent-device close'],
      },
      {
        id: 'barePressPrefix',
        commands: ['agent-device open com.example.app', 'press @e5 --settle'],
      },
    ],
    metamorphic: {
      commands: [
        'agent-device open com.example.other',
        'agent-device press @e9 --settle',
        'agent-device close',
      ],
    },
  },
  usesSnapshotI: {
    passing: { commands: ['agent-device snapshot -i'] },
    counterexamples: [
      { id: 'snapshotMissingInteractiveFlag', commands: ['agent-device snapshot'] },
      {
        id: 'noSnapshotCommandAtAll',
        commands: ['agent-device open com.example.app', 'agent-device close'],
      },
    ],
    metamorphic: {
      commands: ['agent-device open com.example.other --foreground', 'agent-device snapshot -i'],
    },
  },
  usesSettleOnMutations: {
    passing: { commands: ['agent-device press @e5 --settle'] },
    counterexamples: [
      { id: 'mutationMissingSettle', commands: ['agent-device press @e5'] },
      // No mutation command present at all is also a fail: the scorer
      // requires evidence of settling, not just the absence of an unsettled
      // mutation.
      {
        id: 'noMutationCommandsPresent',
        commands: ['agent-device snapshot -i', 'agent-device close'],
      },
    ],
    metamorphic: {
      commands: ['agent-device fill label="Email" "qa@example.com" --settle'],
    },
  },
  usesConfidentChaining: {
    passing: {
      commands: [
        'agent-device press label="Search" --settle && agent-device fill label="Search" "query" --settle',
      ],
    },
    counterexamples: [
      {
        id: 'sameStepsWithoutChain',
        commands: [
          'agent-device press label="Search" --settle',
          'agent-device fill label="Search" "query" --settle',
        ],
      },
    ],
    metamorphic: {
      commands: [
        'agent-device press label="Continue" --settle && agent-device fill label="Notes" "groceries" --settle',
      ],
    },
  },
  noWaitStable: {
    passing: { commands: ['agent-device wait text "Sent"'] },
    counterexamples: [{ id: 'usesWaitStable', commands: ['agent-device wait stable'] }],
    metamorphic: { commands: ['agent-device wait text "Welcome back"'] },
  },
  verifiesNamedExpectation: {
    passing: { commands: ['agent-device wait text "Sent"'] },
    counterexamples: [
      {
        id: 'noVerificationCommand',
        commands: ['agent-device press @e5 --settle', 'agent-device close'],
      },
    ],
    metamorphic: { commands: ['agent-device is visible label="Welcome back"'] },
  },
  usesDogfoodEvidence: {
    passing: {
      commands: ['agent-device screenshot --overlay-refs ./dogfood-output/issue.png'],
    },
    counterexamples: [
      {
        id: 'noEvidenceCaptured',
        commands: ['agent-device open com.example.shop', 'agent-device close'],
      },
    ],
    metamorphic: { commands: ['agent-device record start'] },
  },
  usesValidationPrep: {
    passing: {
      commands: ['agent-device doctor', 'pnpm build', 'pnpm clean:daemon'],
      allowedExternalCommands: ['pnpm'],
    },
    counterexamples: [
      {
        // Build after the clean it was supposed to precede proves nothing:
        // clean:daemon must follow the build it validates.
        id: 'cleanBeforeBuild',
        commands: ['pnpm clean:daemon', 'pnpm build'],
        allowedExternalCommands: ['pnpm'],
      },
    ],
    metamorphic: {
      commands: ['pnpm run build:android', 'agent-device doctor', 'pnpm clean:daemon'],
      allowedExternalCommands: ['pnpm'],
    },
  },
  opensAndCloses: {
    passing: {
      commands: ['agent-device open com.example.community', 'agent-device close'],
    },
    counterexamples: [
      {
        // Both verbs present, but merged onto one command line: close is
        // swallowed as an argument to open rather than a separate command.
        id: 'mergedIntoOneCommandLine',
        commands: ['agent-device open com.example.community close'],
      },
    ],
    metamorphic: {
      commands: [
        'agent-device open com.example.other --relaunch',
        'agent-device press @e9 --settle',
        'agent-device close',
      ],
    },
  },
};
