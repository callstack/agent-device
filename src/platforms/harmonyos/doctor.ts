import type { DoctorCheck } from '@agent-device/contracts/observability';
import { commandFirstLine } from '../toolchain-probe.ts';

export async function harmonyToolchainCheck(): Promise<DoctorCheck> {
  const versionLine = await commandFirstLine('hdc', ['-v']);
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
