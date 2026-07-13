import { Alert, ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ActionButton, InlineBadge, ScreenTitle, SectionCard, ToggleRow } from '../components';
import { useAppColors, type AppColors } from '../theme';
import { GestureLab } from './GestureLab';

export interface HomeScreenProps {
  cartCount: number;
  isOnline: boolean;
  isRefreshing: boolean;
  lastSyncLabel: string;
  noticeVisible: boolean;
  onDismissNotice: () => void;
  onOpenCatalog: () => void;
  onOpenForm: () => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
  onSetOnline: (value: boolean) => void;
}

export function HomeScreen(props: HomeScreenProps) {
  const colors = useAppColors();
  const styles = createStyles(colors);

  function showConfirmationAlert() {
    Alert.alert(
      'Confirm catalog refresh',
      'Use this alert for confirm, cancel, and system-alert handling tests. Nothing destructive happens here.',
      [
        {
          style: 'cancel',
          text: 'Keep browsing',
        },
        {
          text: 'Confirm refresh',
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
        badge={`${props.cartCount} in cart`}
        subtitle="An app for testing all the functionality of agent-device."
        title="Agent Device Tester"
        testID="home-title"
      />

      <GestureLab />

      {props.noticeVisible ? (
        <SectionCard
          subtitle="Dismiss this to exercise nearby mutations and compact diff verification."
          title="Release notice"
          tone="accent"
          testID="release-notice"
        >
          <Text style={styles.noticeText}>
            The bakery list was refreshed this morning. Seasonal items moved to the bottom of the
            catalog.
          </Text>
          <ActionButton
            kind="secondary"
            label="Dismiss notice"
            onPress={props.onDismissNotice}
            testID="dismiss-notice"
          />
        </SectionCard>
      ) : null}

      <SectionCard
        subtitle="These actions intentionally branch into different surfaces without leaving the app."
        title="Quick actions"
      >
        <View style={styles.buttonStack}>
          <ActionButton
            label="Browse catalog"
            onPress={props.onOpenCatalog}
            testID="home-open-catalog"
          />
          <ActionButton
            kind="secondary"
            label="Open checkout form"
            onPress={props.onOpenForm}
            testID="home-open-form"
          />
          <ActionButton
            kind="secondary"
            label="Open settings"
            onPress={props.onOpenSettings}
            testID="home-open-settings"
          />
          <ActionButton
            kind="secondary"
            label="Open confirmation alert"
            onPress={showConfirmationAlert}
            testID="home-open-modal"
          />
        </View>
      </SectionCard>

      <SectionCard
        subtitle="Good for wait, get, and state assertions."
        title="Live status"
        testID="home-status-card"
      >
        <View style={styles.row}>
          <Text style={styles.label}>Session health</Text>
          <InlineBadge
            label={props.isOnline ? 'Online' : 'Offline'}
            tone={props.isOnline ? 'success' : 'neutral'}
          />
        </View>
        <ToggleRow
          description="Flip this to simulate a reachable or unreachable session target."
          label="Lab online"
          onValueChange={props.onSetOnline}
          testID="toggle-online"
          value={props.isOnline}
        />
        <View style={styles.row}>
          <Text style={styles.label}>Last sync</Text>
          <Text style={styles.value}>{props.lastSyncLabel}</Text>
        </View>
        {props.isRefreshing ? (
          <View style={styles.loadingRow} testID="metrics-loading">
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.value}>Refreshing metrics...</Text>
          </View>
        ) : (
          <ActionButton
            label="Refresh metrics"
            onPress={props.onRefresh}
            testID="refresh-metrics"
          />
        )}
      </SectionCard>

      <SectionCard
        subtitle="These bullets are stable targets for plain snapshot and get-text flows."
        title="Verification targets"
      >
        <Text style={styles.bullet}>Visible heading with a durable test id.</Text>
        <Text style={styles.bullet}>A dismissible banner for diff snapshots.</Text>
        <Text style={styles.bullet}>A native alert with confirm and cancel actions.</Text>
        <Text style={styles.bullet}>A loading state that becomes a success toast.</Text>
      </SectionCard>
    </ScrollView>
  );
}

function createStyles(colors: AppColors) {
  return StyleSheet.create({
    content: {
      paddingBottom: 28,
    },
    noticeText: {
      color: colors.text,
      fontSize: 15,
      lineHeight: 22,
    },
    buttonStack: {
      gap: 10,
    },
    row: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    label: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '600',
    },
    value: {
      color: colors.textSoft,
      fontSize: 14,
      fontWeight: '600',
    },
    loadingRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 10,
    },
    bullet: {
      color: colors.text,
      fontSize: 15,
      lineHeight: 22,
    },
  });
}
