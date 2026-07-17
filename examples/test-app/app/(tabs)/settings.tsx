import { useRouter } from 'expo-router';

import { AppFrame } from '../../src/components';
import { useLabState } from '../../src/lab-state';
import { SettingsScreen } from '../../src/screens/SettingsScreen';

export default function SettingsRoute() {
  const router = useRouter();
  const state = useLabState();

  return (
    <AppFrame>
      <SettingsScreen
        diagnosticsExpanded={state.diagnosticsExpanded}
        diagnosticsLoading={state.diagnosticsLoading}
        diagnosticsState={state.diagnosticsState}
        notificationsEnabled={state.notificationsEnabled}
        onOpenAccessorySetup={() => router.push('/accessory-setup')}
        onOpenInertSurface={() => router.push('/inert')}
        onConfirmReset={state.resetLabState}
        onLoadDiagnostics={state.loadDiagnostics}
        onRetryDiagnostics={state.retryDiagnostics}
        onSetNotificationsEnabled={state.setNotificationsEnabled}
        onSetReducedMotionEnabled={state.setReducedMotionEnabled}
        onToggleDiagnostics={() => state.setDiagnosticsExpanded(!state.diagnosticsExpanded)}
        reducedMotionEnabled={state.reducedMotionEnabled}
      />
    </AppFrame>
  );
}
