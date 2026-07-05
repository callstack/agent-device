import { inspectManagedAgentBrowserProcesses } from '../../platforms/web/agent-browser-lifecycle.ts';
import { getManagedAgentBrowserStatus } from '../../platforms/web/agent-browser-tool.ts';
import { appendDoctorCheck } from './session-doctor-output.ts';
import type { DoctorCheck } from './session-doctor-types.ts';

export async function appendWebBrowserLifecycleCheck(
  checks: DoctorCheck[],
  stateDir: string,
): Promise<void> {
  appendDoctorCheck(checks, await webBrowserLifecycleCheck(stateDir));
}

async function webBrowserLifecycleCheck(stateDir: string): Promise<DoctorCheck> {
  const status = getManagedAgentBrowserStatus({ stateDir });
  if (!status.installed) {
    return {
      id: 'web-agent-browser-processes',
      status: 'info',
      summary:
        'Managed web backend is not installed; no agent-device-owned browser processes counted.',
      evidence: { stateDir, installed: false },
    };
  }
  try {
    const summary = await inspectManagedAgentBrowserProcesses(status);
    return {
      id: 'web-agent-browser-processes',
      status: summary.count > 0 ? 'info' : 'pass',
      summary:
        summary.count > 0
          ? `${summary.count} live agent-device-owned Chrome process${summary.count === 1 ? '' : 'es'} detected.`
          : 'No live agent-device-owned Chrome processes detected.',
      evidence: {
        stateDir,
        installed: true,
        count: summary.count,
        pids: summary.pids,
        matchReasons: summary.processes.map((match) => match.reason),
      },
    };
  } catch (error) {
    return {
      id: 'web-agent-browser-processes',
      status: 'info',
      summary: 'Could not inspect live agent-device-owned Chrome processes.',
      hint: 'Run doctor again from a shell with permission to inspect local processes.',
      evidence: { stateDir, error: error instanceof Error ? error.message : String(error) },
    };
  }
}
