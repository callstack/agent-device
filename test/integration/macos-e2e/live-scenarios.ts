export type MacOsLiveScenario = {
  id: string;
  owner: {
    path: string;
    test: string;
  };
  syntax: 'replay' | 'provider-command' | 'provider-call-command';
};

export const MACOS_LIVE_SCENARIOS = [
  {
    id: 'replay:system-settings',
    owner: {
      path: 'test/integration/replays/macos/01-system-settings.ad',
      test: 'Dogfood macOS System Settings flow through the replay suite runner.',
    },
    syntax: 'replay',
  },
  {
    id: 'provider:macos-desktop',
    owner: {
      path: 'test/integration/provider-scenarios/macos-desktop.test.ts',
      test: 'Provider-backed integration macOS desktop flow uses semantic host and helper providers',
    },
    syntax: 'provider-command',
  },
  {
    id: 'provider:macos-recording',
    owner: {
      path: 'test/integration/provider-scenarios/macos-recording.test.ts',
      test: 'Provider-backed integration macOS recording uses focused exact runner authority',
    },
    syntax: 'provider-call-command',
  },
] as const satisfies readonly MacOsLiveScenario[];

export type MacOsLiveScenarioId = (typeof MACOS_LIVE_SCENARIOS)[number]['id'];
