import type { CommandFlags } from '@agent-device/contracts/command';
import type {
  CaptureSnapshotInput,
  SnapshotRuntimeExecution,
} from '@agent-device/contracts/platform';
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
    /**
     * Web rect captures request bounds explicitly. Lands here with the selector capture path,
     * its first consumer; `snapshot`/`diff` pass nothing and are unaffected.
     */
    includeRects?: boolean;
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
      includeRects: params.includeRects,
      surface,
    },
    execution: runtimeExecutionFromContext(context),
  };
}

/**
 * Projects the runner execution metadata a platform operation needs out of a resolved command
 * context. Every request-bound operation — capture and element read alike — must forward the
 * SAME set: dropping a field silently strips request id, log/trace paths, XCUITest overrides, or
 * runner lease context, so the operation still answers but runs unconfigured and its diagnostics
 * land nowhere. One projection means a new field reaches every operation at once and cannot be
 * forgotten at one call site.
 */
export function runtimeExecutionFromContext(
  context: Readonly<{
    requestId?: string;
    verbose?: boolean;
    logPath?: string;
    traceLogPath?: string;
    iosXctestrunFile?: string;
    iosXctestDerivedDataPath?: string;
    iosXctestEnvDir?: string;
    runnerLeaseContext?: SnapshotRuntimeExecution['runnerLeaseContext'];
  }>,
): SnapshotRuntimeExecution {
  return {
    requestId: context.requestId,
    verbose: context.verbose,
    logPath: context.logPath,
    traceLogPath: context.traceLogPath,
    iosXctestrunFile: context.iosXctestrunFile,
    iosXctestDerivedDataPath: context.iosXctestDerivedDataPath,
    iosXctestEnvDir: context.iosXctestEnvDir,
    runnerLeaseContext: context.runnerLeaseContext,
  };
}
