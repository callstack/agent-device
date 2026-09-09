import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import type { AndroidContractEvidence } from '../android-emulator-e2e/contract-evidence.ts';
import {
  MACOS_LIVE_SCENARIOS,
  type MacOsLiveScenario,
  type MacOsLiveScenarioId,
} from '../macos-e2e/live-scenarios.ts';
import {
  LINUX_COMMAND_EVIDENCE,
  LINUX_COVERAGE_GAP_ISSUE,
  LINUX_REPLAY_EVIDENCE,
  MACOS_COVERAGE_GAP_ISSUE,
  TVOS_COVERAGE_GAP_ISSUE,
  WEB_COVERAGE_GAP_ISSUE,
  WEB_SMOKE_EVIDENCE,
  type RepositoryEvidence,
} from './evidence.ts';

export type PublicCommand = (typeof PUBLIC_COMMANDS)[keyof typeof PUBLIC_COMMANDS];

// The six platform entry shapes. Each keeps exactly the fields its own e2e runner and coverage
// report read today; nothing here is shared between platforms beyond `RepositoryEvidence`,
// because no platform's judgment may be derived from another's.

export type AndroidEmulatorCoverageEntry =
  | { assertion: string; level: 'live'; scenario: string }
  | {
      assertion: string;
      evidence: AndroidContractEvidence;
      level: 'command-contract';
    };

export type IosSimulatorCoverageEntry =
  | {
      assertion: string;
      level: 'live';
      owner: string;
    }
  | {
      assertion: string;
      level: 'command-contract' | 'workflow-live';
      owner: RepositoryEvidence;
    };

export type MacOsPlatformCoverageEntry =
  | {
      assertion: string;
      level: 'live';
      owner: RepositoryEvidence;
      scenario: MacOsLiveScenarioId;
    }
  | {
      assertion: string;
      level: 'command-contract';
      owner: RepositoryEvidence;
    }
  | {
      assertion: string;
      level: 'known-gap';
      trackingIssue: number;
    };

export type TvOsPlatformCoverageEntry =
  | {
      assertion: string;
      level: 'live';
      owner: RepositoryEvidence;
    }
  | {
      assertion: string;
      level: 'command-contract';
      owner: RepositoryEvidence;
    }
  | {
      assertion: string;
      level: 'command-contract';
      owner: RepositoryEvidence;
      admission: 'host-dependent';
    }
  | {
      assertion: string;
      level: 'known-gap';
      trackingIssue: number;
    };

export type WebPlatformCoverageEntry =
  | {
      assertion: string;
      level: 'live' | 'command-contract';
      owner: RepositoryEvidence;
    }
  | {
      assertion: string;
      level: 'known-gap';
      trackingIssue: number;
    };

export type LinuxPlatformCoverageEntry =
  | {
      assertion: string;
      level: 'live' | 'command-contract';
      owner: RepositoryEvidence;
    }
  | {
      assertion: string;
      level: 'known-gap';
      trackingIssue: number;
    };

/** One command's coverage judgment on every platform that classifies the public catalog. */
export type CommandCoverageDeclaration = {
  androidEmulator: AndroidEmulatorCoverageEntry;
  iosSimulator: IosSimulatorCoverageEntry;
  macos: MacOsPlatformCoverageEntry;
  tvos: TvOsPlatformCoverageEntry;
  web: WebPlatformCoverageEntry;
  linux: LinuxPlatformCoverageEntry;
};

export type CoveragePlatform = keyof CommandCoverageDeclaration;

export const androidEmulator = {
  live: (scenario: string, assertion: string): AndroidEmulatorCoverageEntry => ({
    assertion,
    level: 'live',
    scenario,
  }),
  contract: (
    evidence: AndroidContractEvidence,
    assertion: string,
  ): AndroidEmulatorCoverageEntry => ({
    assertion,
    evidence,
    level: 'command-contract',
  }),
};

export const iosSimulator = {
  live: (owner: string, assertion: string): IosSimulatorCoverageEntry => ({
    assertion,
    level: 'live',
    owner,
  }),
  contract: (path: string, test: string, assertion: string): IosSimulatorCoverageEntry => ({
    assertion,
    level: 'command-contract',
    owner: { path, test },
  }),
  workflowLive: (path: string, test: string, assertion: string): IosSimulatorCoverageEntry => ({
    assertion,
    level: 'workflow-live',
    owner: { path, test },
  }),
};

export const macos = {
  live: (scenario: MacOsLiveScenarioId, assertion: string): MacOsPlatformCoverageEntry => ({
    assertion,
    level: 'live',
    owner: macOsLiveScenario(scenario).owner,
    scenario,
  }),
  contract: (path: string, test: string, assertion: string): MacOsPlatformCoverageEntry => ({
    assertion,
    level: 'command-contract',
    owner: { path, test },
  }),
  gap: (assertion: string): MacOsPlatformCoverageEntry => ({
    assertion,
    level: 'known-gap',
    trackingIssue: MACOS_COVERAGE_GAP_ISSUE,
  }),
};

export const tvos = {
  live: (path: string, test: string, assertion: string): TvOsPlatformCoverageEntry => ({
    assertion,
    level: 'live',
    owner: { path, test },
  }),
  contract: (
    path: string,
    test: string,
    assertion: string,
    admission?: 'host-dependent',
  ): TvOsPlatformCoverageEntry => ({
    assertion,
    level: 'command-contract',
    owner: { path, test },
    ...(admission ? { admission } : {}),
  }),
  gap: (assertion: string): TvOsPlatformCoverageEntry => ({
    assertion,
    level: 'known-gap',
    trackingIssue: TVOS_COVERAGE_GAP_ISSUE,
  }),
};

export const web = {
  live: (assertion: string): WebPlatformCoverageEntry => ({
    assertion,
    level: 'live',
    owner: WEB_SMOKE_EVIDENCE,
  }),
  contract: (path: string, test: string, assertion: string): WebPlatformCoverageEntry => ({
    assertion,
    level: 'command-contract',
    owner: { path, test },
  }),
  gap: (assertion: string): WebPlatformCoverageEntry => ({
    assertion,
    level: 'known-gap',
    trackingIssue: WEB_COVERAGE_GAP_ISSUE,
  }),
};

export const linux = {
  replayLive: (assertion: string): LinuxPlatformCoverageEntry => ({
    assertion,
    level: 'live',
    owner: LINUX_REPLAY_EVIDENCE,
  }),
  commandEvidenceLive: (assertion: string): LinuxPlatformCoverageEntry => ({
    assertion,
    level: 'live',
    owner: LINUX_COMMAND_EVIDENCE,
  }),
  contract: (path: string, test: string, assertion: string): LinuxPlatformCoverageEntry => ({
    assertion,
    level: 'command-contract',
    owner: { path, test },
  }),
  gap: (assertion: string): LinuxPlatformCoverageEntry => ({
    assertion,
    level: 'known-gap',
    trackingIssue: LINUX_COVERAGE_GAP_ISSUE,
  }),
};

function macOsLiveScenario(scenarioId: MacOsLiveScenarioId): MacOsLiveScenario {
  const scenario = MACOS_LIVE_SCENARIOS.find((candidate) => candidate.id === scenarioId);
  if (!scenario) throw new Error(`Unknown macOS coverage scenario: ${scenarioId}`);
  return scenario;
}
