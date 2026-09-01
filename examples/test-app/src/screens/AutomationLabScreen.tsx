import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  useWindowDimensions,
  View,
} from 'react-native';
import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from 'expo-audio';
import { requireOptionalNativeModule } from 'expo-modules-core';

import { ActionButton, ScreenTitle, SectionCard } from '../components';
import { useAppColors, type AppColors } from '../theme';

type PushBroadcastLabModule = {
  lastPushBroadcast(): string;
};

const pushBroadcastLab =
  Platform.OS === 'android'
    ? requireOptionalNativeModule<PushBroadcastLabModule>('PushBroadcastLab')
    : null;

export function AutomationLabScreen(props: {
  eventName: string;
  eventPayload: string;
  onContinueToCatalog: () => void;
}) {
  const colors = useAppColors();
  const styles = createStyles(colors);
  const colorScheme = useColorScheme() ?? 'light';
  const dimensions = useWindowDimensions();
  const [appState, setAppState] = useState(AppState.currentState);
  const [lastNonActiveState, setLastNonActiveState] = useState('none');
  const [alertResult, setAlertResult] = useState('none');
  const [lastInput, setLastInput] = useState('none');
  const [longPressCount, setLongPressCount] = useState(0);
  const [maestroSelection, setMaestroSelection] = useState('none');
  const [microphonePermission, setMicrophonePermission] = useState('checking');
  const [lastPushBroadcast, setLastPushBroadcast] = useState('none');
  const [sheetVisible, setSheetVisible] = useState(false);
  const permissionReadGeneration = useRef(0);
  const windowMode = dimensions.width > dimensions.height ? 'landscape' : 'portrait';

  useEffect(() => {
    let mounted = true;
    const refreshMicrophonePermission = () => {
      const generation = ++permissionReadGeneration.current;
      setMicrophonePermission('checking');
      void getRecordingPermissionsAsync()
        .then((permission) => {
          if (mounted && generation === permissionReadGeneration.current) {
            setMicrophonePermission(permission.status);
          }
        })
        .catch(() => {
          if (mounted && generation === permissionReadGeneration.current) {
            setMicrophonePermission('error');
          }
        });
    };
    const refreshPushBroadcast = () => {
      setLastPushBroadcast(pushBroadcastLab?.lastPushBroadcast() ?? 'unavailable');
    };
    refreshMicrophonePermission();
    refreshPushBroadcast();
    const subscription = AppState.addEventListener('change', (nextState) => {
      setAppState(nextState);
      if (nextState !== 'active') setLastNonActiveState(nextState);
      if (nextState === 'active') {
        refreshMicrophonePermission();
        refreshPushBroadcast();
      }
    });
    return () => {
      mounted = false;
      permissionReadGeneration.current += 1;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (alertResult !== 'opened') return;

    // The opened canary is committed before this effect; the smoke step separately waits for native presentation.
    Alert.alert('Automation confirmation', 'Choose either result to update the visible canary.', [
      {
        style: 'cancel',
        text: 'Cancel',
        onPress: () => setAlertResult('cancelled'),
      },
      {
        text: 'OK',
        onPress: () => setAlertResult('accepted'),
      },
    ]);
  }, [alertResult]);

  function showAutomationAlert() {
    setAlertResult('opened');
  }

  async function requestMicrophonePermission() {
    const generation = ++permissionReadGeneration.current;
    setMicrophonePermission('checking');
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (generation === permissionReadGeneration.current) {
        setMicrophonePermission(permission.status);
      }
    } catch {
      if (generation === permissionReadGeneration.current) {
        setMicrophonePermission('error');
      }
    }
  }

  function refreshPushBroadcast() {
    setLastPushBroadcast(pushBroadcastLab?.lastPushBroadcast() ?? 'unavailable');
  }

  return (
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <ScreenTitle
        badge="E2E"
        subtitle="Durable outcomes for simulator commands that need app-visible evidence."
        testID="automation-title"
        title="Automation lab"
      />
      <SectionCard title="Runtime state">
        <StateRow label="Window" testID="automation-window" value={windowMode} />
        <StateRow label="App state" testID="automation-appstate" value={appState} />
        <StateRow
          label="Last non-active"
          testID="automation-last-nonactive"
          value={lastNonActiveState}
        />
        <StateRow label="Appearance" testID="automation-appearance" value={colorScheme} />
      </SectionCard>

      <SectionCard title="App event">
        <StateRow label="Event" testID="automation-event-name" value={props.eventName} />
        <StateRow label="Payload" testID="automation-event-payload" value={props.eventPayload} />
        <ActionButton
          kind="secondary"
          label="Continue to catalog"
          onPress={props.onContinueToCatalog}
          testID="automation-continue-catalog"
        />
        <ActionButton
          kind="secondary"
          label="Open automation sheet"
          onPress={() => setSheetVisible(true)}
          testID="automation-open-sheet"
        />
      </SectionCard>

      {Platform.OS === 'android' ? (
        <SectionCard
          subtitle="The first duplicate is inert; the second duplicate is clickable."
          title="Maestro clickable ordering"
        >
          <View style={styles.maestroTarget} testID="maestro-clickable-first-target">
            <Text style={styles.maestroTargetLabel}>Inert duplicate target</Text>
          </View>
          <Pressable
            accessibilityLabel="Clickable duplicate target"
            accessibilityRole="button"
            onPress={() => setMaestroSelection('clickable')}
            style={({ pressed }) => [styles.maestroTarget, pressed ? styles.pressed : null]}
            testID="maestro-clickable-first-target"
          >
            <Text style={styles.maestroTargetLabel}>Clickable duplicate target</Text>
          </Pressable>
          <Text style={styles.value} testID="maestro-clickable-first-result">
            Maestro selection: {maestroSelection}
          </Text>
        </SectionCard>
      ) : null}

      <SectionCard title="Input canaries">
        <ActionButton
          label="Press canary"
          onPress={() => setLastInput('press')}
          testID="automation-press"
        />
        <Pressable
          accessibilityLabel="Long press canary"
          accessibilityRole="button"
          onLongPress={() => {
            setLastInput('longpress');
            setLongPressCount((count) => count + 1);
          }}
          onPress={() => setLastInput('tap')}
          style={({ pressed }) => [styles.longPressTarget, pressed ? styles.pressed : null]}
          testID="automation-longpress"
        >
          <Text style={styles.longPressLabel}>Hold this control</Text>
        </Pressable>
        <Text style={styles.value} testID="automation-last-input">
          Last input: {lastInput}
        </Text>
        <Text style={styles.value} testID="automation-longpress-count">
          Long presses: {longPressCount}
        </Text>
      </SectionCard>

      <SectionCard title="Native alert">
        <ActionButton
          label="Open automation alert"
          onPress={showAutomationAlert}
          testID="automation-open-alert"
        />
        <Text style={styles.value} testID="automation-alert-result">
          Alert result: {alertResult}
        </Text>
      </SectionCard>

      <SectionCard title="Native permission">
        <ActionButton
          label="Request microphone permission"
          onPress={() => void requestMicrophonePermission()}
          testID="automation-request-microphone"
        />
        <StateRow
          label="Microphone permission"
          testID="automation-microphone-permission"
          value={microphonePermission}
        />
      </SectionCard>

      <SectionCard title="Android push broadcast">
        <ActionButton
          kind="secondary"
          label="Refresh push broadcast"
          onPress={refreshPushBroadcast}
          testID="automation-refresh-push-broadcast"
        />
        <StateRow
          label="Last push broadcast"
          testID="automation-last-push-broadcast"
          value={lastPushBroadcast}
        />
      </SectionCard>

      <Modal
        animationType="slide"
        onRequestClose={() => setSheetVisible(false)}
        presentationStyle="pageSheet"
        visible={sheetVisible}
      >
        <View style={styles.sheet}>
          <Text style={styles.sheetTitle} testID="automation-sheet-title">
            Automation sheet
          </Text>
          <Text style={styles.value}>A deterministic modal presentation for open/close flows.</Text>
          <ActionButton
            label="Close automation sheet"
            onPress={() => setSheetVisible(false)}
            testID="automation-close-sheet"
          />
        </View>
      </Modal>
    </ScrollView>
  );
}

function StateRow(props: { label: string; testID: string; value: string }) {
  const colors = useAppColors();
  const styles = createStyles(colors);
  return (
    <View style={styles.stateRow}>
      <Text style={styles.label}>{props.label}</Text>
      <Text style={styles.value} testID={props.testID}>
        {props.value}
      </Text>
    </View>
  );
}

function createStyles(colors: AppColors) {
  return StyleSheet.create({
    content: {
      paddingBottom: 28,
    },
    label: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '600',
    },
    longPressLabel: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '700',
    },
    longPressTarget: {
      alignItems: 'center',
      borderColor: colors.lineStrong,
      borderRadius: 4,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: 16,
      paddingVertical: 16,
    },
    maestroTarget: {
      alignItems: 'center',
      borderColor: colors.lineStrong,
      borderRadius: 4,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    maestroTargetLabel: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '700',
    },
    pressed: {
      opacity: 0.8,
    },
    stateRow: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    sheet: {
      backgroundColor: colors.surface,
      flex: 1,
      gap: 20,
      padding: 24,
      paddingTop: 48,
    },
    sheetTitle: {
      color: colors.text,
      fontSize: 28,
      fontWeight: '700',
    },
    value: {
      color: colors.textSoft,
      fontSize: 14,
      fontWeight: '600',
    },
  });
}
