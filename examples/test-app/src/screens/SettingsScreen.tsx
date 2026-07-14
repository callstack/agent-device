import {
  Alert,
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { ActionButton, InlineBadge, ScreenTitle, SectionCard, ToggleRow } from '../components';
import { useAppColors, type AppColors } from '../theme';

export interface SettingsScreenProps {
  diagnosticsExpanded: boolean;
  diagnosticsLoading: boolean;
  diagnosticsState: 'idle' | 'ready' | 'error';
  notificationsEnabled: boolean;
  reducedMotionEnabled: boolean;
  onOpenAccessorySetup: () => void;
  onLoadDiagnostics: () => void;
  onRetryDiagnostics: () => void;
  onSetNotificationsEnabled: (value: boolean) => void;
  onSetReducedMotionEnabled: (value: boolean) => void;
  onToggleDiagnostics: () => void;
  onConfirmReset: () => void;
}

export function SettingsScreen(props: SettingsScreenProps) {
  const colors = useAppColors();
  const styles = createStyles(colors);

  function showResetAlert() {
    Alert.alert(
      'Reset Agent Device Tester?',
      'This clears cart, favorites, validation messages, and diagnostic states so the next workflow starts from a known baseline.',
      [
        {
          style: 'cancel',
          text: 'Cancel reset',
        },
        {
          style: 'destructive',
          text: 'Confirm reset',
          onPress: props.onConfirmReset,
        },
      ],
      {
        cancelable: true,
      },
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <ScreenTitle
        badge="Debug"
        subtitle="Toggles, accordion content, loading states, retryable error banners, and native alerts."
        title="Settings"
        testID="settings-title"
      />

      <SectionCard
        subtitle="Open the physical iOS AccessorySetupUI verification fixture."
        title="Accessory setup"
      >
        <ActionButton
          label="Open accessory setup lab"
          onPress={props.onOpenAccessorySetup}
          testID="open-accessory-setup-lab"
        />
      </SectionCard>

      <SectionCard subtitle="Simple switch rows for durable selectors." title="Preferences">
        <ToggleRow
          description="Disabled notifications should remain visible in plain snapshots."
          label="Push notifications"
          onValueChange={props.onSetNotificationsEnabled}
          testID="toggle-notifications"
          value={props.notificationsEnabled}
        />
        <ToggleRow
          description="Useful when a test needs one more switch state without changing screens."
          label="Reduced motion"
          onValueChange={props.onSetReducedMotionEnabled}
          testID="toggle-reduced-motion"
          value={props.reducedMotionEnabled}
        />
      </SectionCard>

      <SectionCard
        subtitle="Expand this section to surface long-form text and status details."
        title="Diagnostics"
      >
        <Pressable
          accessibilityLabel={props.diagnosticsExpanded ? 'Hide diagnostics' : 'Show diagnostics'}
          accessibilityRole="button"
          accessibilityState={{ expanded: props.diagnosticsExpanded }}
          onPress={props.onToggleDiagnostics}
          style={({ pressed }) => [styles.accordionButton, pressed ? styles.pressed : null]}
          testID="toggle-diagnostics"
        >
          <Text style={styles.accordionLabel}>
            {props.diagnosticsExpanded ? 'Hide diagnostics' : 'Show diagnostics'}
          </Text>
        </Pressable>

        {props.diagnosticsExpanded ? (
          <View style={styles.diagnosticsBody} testID="diagnostics-body">
            <Text style={styles.diagnosticsText}>Build: expo-sdk-56 / lab-fixture-1</Text>
            <Text style={styles.diagnosticsText}>API mode: mock network with retry simulation</Text>
            <Text style={styles.diagnosticsText}>
              Device target hint: use this accordion for get-text and exists assertions
            </Text>
          </View>
        ) : null}

        {props.diagnosticsLoading ? (
          <View style={styles.loadingRow} testID="diagnostics-loading">
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.diagnosticsText}>Loading diagnostics...</Text>
          </View>
        ) : null}

        {props.diagnosticsState === 'ready' ? (
          <View style={styles.statusRow} testID="diagnostics-ready">
            <InlineBadge label="Ready" tone="success" />
            <Text style={styles.diagnosticsText}>Last probe passed in 182 ms.</Text>
          </View>
        ) : null}

        {props.diagnosticsState === 'error' ? (
          <View style={styles.errorBox} testID="diagnostics-error">
            <InlineBadge label="Error" tone="danger" />
            <Text style={styles.errorText}>
              Catalog service timed out. Retry to restore the success state.
            </Text>
            <ActionButton
              kind="secondary"
              label="Retry diagnostics"
              onPress={props.onRetryDiagnostics}
              testID="retry-diagnostics"
            />
          </View>
        ) : null}

        <View style={styles.actionStack}>
          <ActionButton
            label="Load diagnostics"
            onPress={props.onLoadDiagnostics}
            testID="load-diagnostics"
          />
          <ActionButton
            kind="secondary"
            label="Reset lab state"
            onPress={showResetAlert}
            testID="reset-lab"
          />
        </View>
      </SectionCard>
    </ScrollView>
  );
}

function createStyles(colors: AppColors) {
  return StyleSheet.create({
    content: {
      paddingBottom: 28,
    },
    accordionButton: {
      backgroundColor: colors.cardStrong,
      borderColor: colors.line,
      borderRadius: 4,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: 14,
      paddingVertical: 14,
    },
    accordionLabel: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '700',
    },
    diagnosticsBody: {
      gap: 8,
    },
    diagnosticsText: {
      color: colors.text,
      fontSize: 14,
      lineHeight: 21,
    },
    loadingRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 10,
    },
    statusRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 10,
    },
    errorBox: {
      backgroundColor: colors.cardStrong,
      borderColor: colors.danger,
      borderRadius: 4,
      borderWidth: StyleSheet.hairlineWidth,
      gap: 10,
      padding: 14,
    },
    errorText: {
      color: colors.text,
      fontSize: 14,
      lineHeight: 21,
    },
    actionStack: {
      gap: 10,
    },
    pressed: {
      opacity: 0.85,
    },
  });
}
