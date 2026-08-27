import type { RunnerLogicalLeaseContext } from './runner-lease-context.ts';

/**
 * Request-scoped options shared across daemon routing and Apple runner adapters.
 *
 * The Apple runner owns its lifecycle and command options; this is only the
 * neutral request vocabulary that a caller may pass to an adapter.
 */
export type AppleRunnerRequestOptions = Readonly<{
  verbose?: boolean;
  logPath?: string;
  traceLogPath?: string;
  requestId?: string;
  runnerLeaseContext?: RunnerLogicalLeaseContext;
  iosXctestrunFile?: string;
  iosXctestDerivedDataPath?: string;
  iosXctestEnvDir?: string;
}>;
