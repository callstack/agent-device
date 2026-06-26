import { analyzeReactNativeOverlay } from '../../core/react-native-overlay.ts';
import type { SessionState } from '../types.ts';
import { appendDoctorCheck } from './session-doctor-output.ts';
import type { DoctorCheck, DoctorOptions } from './session-doctor-types.ts';

export function appendReactNativeOverlayCheck(
  checks: DoctorCheck[],
  session: SessionState | undefined,
  options: DoctorOptions,
): void {
  const check = reactNativeOverlayCheck(session, options);
  if (check) appendDoctorCheck(checks, check);
}

function reactNativeOverlayCheck(
  session: SessionState | undefined,
  options: DoctorOptions,
): DoctorCheck | undefined {
  if (shouldSkipReactNativeOverlayCheck(session, options)) return undefined;
  if (!session?.snapshot) return missingSnapshotOverlayCheck();

  const overlay = analyzeReactNativeOverlay(session.snapshot.nodes);
  return {
    id: 'rn-overlay',
    status: overlay.detected ? 'warn' : 'pass',
    summary: overlay.detected
      ? `React Native ${overlay.redBox ? 'RedBox' : 'LogBox'} overlay appears in the current snapshot.`
      : 'No React Native overlay detected in the current snapshot.',
    command: overlay.detected ? 'agent-device react-native dismiss-overlay' : undefined,
    evidence: {
      redBox: overlay.redBox,
      dismissTargets: overlay.dismissNodes.length + overlay.collapsedNodes.length,
    },
  };
}

function shouldSkipReactNativeOverlayCheck(
  session: SessionState | undefined,
  options: DoctorOptions,
): boolean {
  return options.kind === 'auto' && !session?.snapshot;
}

function missingSnapshotOverlayCheck(): DoctorCheck {
  return {
    id: 'rn-overlay',
    status: 'info',
    summary: 'No current session snapshot; React Native overlay check skipped.',
    command: 'agent-device snapshot -i',
  };
}
