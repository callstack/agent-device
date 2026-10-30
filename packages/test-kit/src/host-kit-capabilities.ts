/**
 * The real host-kit capabilities a package suite takes as its host defaults, under the names the
 * Apple runner host port uses for them. A suite that must not import host-kit itself (the runner
 * port is the one place its package reaches host-kit) assembles its host from these and from its own
 * explicit adapters, so retry, lock, process and request-cancellation semantics stay genuine.
 *
 * Loaded on demand: the test-kit entry is imported by suites that mock host-kit modules, and a static
 * import of every capability would make those mocks incomplete.
 */
export async function loadRealHostKitCapabilities() {
  const [command, diagnostics, file, processModule, request, retry, runtimeSlots, version] =
    await Promise.all([
      import('@agent-device/host-kit/command'),
      import('@agent-device/host-kit/diagnostics'),
      import('@agent-device/host-kit/file'),
      import('@agent-device/host-kit/process'),
      import('@agent-device/host-kit/request'),
      import('@agent-device/host-kit/retry'),
      import('@agent-device/host-kit/runtime-slots'),
      import('@agent-device/host-kit/version'),
    ]);
  return {
    runCmdStreaming: command.runCmdStreaming,
    runCmdBackground: command.runCmdBackground,
    requireExecSuccess: command.requireExecSuccess,
    isCommandTimeoutError: command.isCommandTimeoutError,
    commandDeveloperDir: command.commandDeveloperDir,
    emitDiagnostic: diagnostics.emitDiagnostic,
    withDiagnosticTimer: diagnostics.withDiagnosticTimer,
    retryWithPolicy: retry.retryWithPolicy,
    isEnvTruthy: retry.isEnvTruthy,
    deadlineFromTimeoutMs: (timeoutMs: number, nowMs?: number) =>
      retry.Deadline.fromTimeoutMs(timeoutMs, nowMs),
    isProcessAlive: processModule.isProcessAlive,
    isProcessGroupAlive: processModule.isProcessGroupAlive,
    readProcessStartTime: processModule.readProcessStartTime,
    readProcessCommand: processModule.readProcessCommand,
    signalPidsBestEffort: processModule.signalPidsBestEffort,
    signalProcessGroupBestEffort: processModule.signalProcessGroupBestEffort,
    classifyOwnerLiveness: processModule.classifyOwnerLiveness,
    readHostCpuArchSync: processModule.readHostCpuArchSync,
    findProjectRoot: version.findProjectRoot,
    readVersion: version.readVersion,
    acquireProcessLock: file.acquireProcessLock,
    withProcessLock: file.withProcessLock,
    publishFileSync: file.publishFileSync,
    emitRequestProgress: request.emitRequestProgress,
    getRequestSignal: request.getRequestSignal,
    isRequestCanceled: request.isRequestCanceled,
    runnerRuntimeSlot: runtimeSlots.runtimeSlot,
  } as const;
}

/** The real host command runner, for a suite adapter that runs one genuine tool (such as `plutil`). */
export async function runRealHostCommand(
  ...args: Parameters<typeof import('@agent-device/host-kit/command').runCmd>
) {
  const { runCmd } = await import('@agent-device/host-kit/command');
  return await runCmd(...args);
}

/** Keeps a daemon deadline on the request's cancellation signal until its work settles. */
export async function withRequestDeadline(
  ...args: Parameters<typeof import('@agent-device/host-kit/request').withRequestDeadline>
) {
  const { withRequestDeadline: run } = await import('@agent-device/host-kit/request');
  return await run(...args);
}
