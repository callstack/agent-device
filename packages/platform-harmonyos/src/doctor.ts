import type { DoctorCheck } from '@agent-device/contracts/observability';
import type { HarmonyCommandRunner } from './command-host.ts';

const HARMONY_TOOLCHAIN_PROBE_TIMEOUT_MS = 3_000;

/**
 * The toolchain row `doctor --platform harmonyos` reports. The probe runs over the plugin's host
 * command runner, so the version it reads is the HDC the plugin would spawn — a root outside the
 * host `PATH` still answers its own version.
 */
export async function harmonyToolchainCheck(commands: HarmonyCommandRunner): Promise<DoctorCheck> {
  const hdc = await commands.resolveHdc();
  const result = await commands
    .run(hdc, ['-v'], { allowFailure: true, timeoutMs: HARMONY_TOOLCHAIN_PROBE_TIMEOUT_MS })
    .catch(() => undefined);
  const versionLine = result?.exitCode === 0 ? firstOutputLine(result.stdout) : undefined;
  if (!versionLine) {
    return {
      id: 'toolchain',
      status: 'info',
      summary: 'HarmonyOS toolchain: hdc not found or version check failed.',
      hint: 'Install HarmonyOS Command Line Tools, then add sdk/default/openharmony/toolchains to PATH or set HDC_SDK_PATH.',
      command: 'hdc -v',
      evidence: { hdcVersion: null },
    };
  }
  return {
    id: 'toolchain',
    status: 'pass',
    summary: `HarmonyOS toolchain: ${versionLine}.`,
    evidence: { hdcVersion: versionLine },
  };
}

/** The first non-empty line of a probe's output, the shape every toolchain version prints. */
function firstOutputLine(output: string): string | undefined {
  return output
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
}
