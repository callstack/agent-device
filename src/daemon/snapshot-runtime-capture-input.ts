import type { CommandFlags } from '@agent-device/contracts/command';
import type { CaptureSnapshotInput } from '@agent-device/contracts/platform';
import { contextFromFlags } from './context.ts';
import type { DaemonRequest, SessionState } from './types.ts';

/**
 * The one place a daemon request becomes neutral capture intent. `snapshot` and `diff` build
 * theirs here; a repeated-capture consumer builds one per capture from its own effective flags
 * and scope. One builder is what stops those shapes drifting on which flag reaches the platform.
 */
export function buildRuntimeCaptureInput(
  params: Readonly<{
    flags: CommandFlags | undefined;
    logPath: string;
    meta?: DaemonRequest['meta'];
    session: SessionState | undefined;
    snapshotScope: string | undefined;
  }>,
): CaptureSnapshotInput {
  const { flags, logPath, meta, session, snapshotScope } = params;
  const { appBundleId, trace, surface } = session ?? {};
  const context = contextFromFlags(
    logPath,
    flags,
    appBundleId,
    trace?.outPath,
    meta?.requestId,
    meta,
  );
  return {
    options: {
      appBundleId,
      interactiveOnly: flags?.snapshotInteractiveOnly,
      preferredBackend: flags?.snapshotPreferredBackend,
      depth: flags?.snapshotDepth,
      scope: snapshotScope,
      raw: flags?.snapshotRaw,
      customActions: flags?.snapshotCustomActions,
      includeHiddenContentHints: flags?.snapshotIncludeHiddenContentHints,
      surface,
    },
    execution: {
      requestId: context.requestId,
      verbose: context.verbose,
      logPath: context.logPath,
      traceLogPath: context.traceLogPath,
      iosXctestrunFile: context.iosXctestrunFile,
      iosXctestDerivedDataPath: context.iosXctestDerivedDataPath,
      iosXctestEnvDir: context.iosXctestEnvDir,
      runnerLeaseContext: context.runnerLeaseContext,
    },
  };
}
