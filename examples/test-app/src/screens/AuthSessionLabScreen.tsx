import { useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';

import { AUTH_IDP_DEFAULT_URL } from '../auth-idp-fixture';
import { isAuthSessionLabAvailable, startFixtureSignInSession } from '../auth-session';
import { ActionButton, InlineBadge, ScreenTitle, SectionCard } from '../components';
import { useAppColors, type AppColors } from '../theme';

type SheetStatus = 'idle' | 'presenting' | 'completed' | 'canceled' | 'error' | 'unavailable';

function initialStatus(): SheetStatus {
  return isAuthSessionLabAvailable() ? 'idle' : 'unavailable';
}

export function AuthSessionLabScreen(props: { onBack: () => void }) {
  const colors = useAppColors();
  const styles = createStyles(colors);
  const [status, setStatus] = useState<SheetStatus>(initialStatus);
  const [message, setMessage] = useState('Ready to open the system sign-in sheet.');
  const presenting = useRef(false);

  async function openSheet() {
    if (presenting.current) return;
    presenting.current = true;
    setStatus('presenting');
    setMessage('Sign-in sheet requested.');

    try {
      const callbackUrl = await startFixtureSignInSession(AUTH_IDP_DEFAULT_URL);
      setStatus('completed');
      setMessage(`Signed in: ${callbackUrl}`);
    } catch (error) {
      const canceled =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ERR_AUTH_SESSION_CANCELED';
      setStatus(canceled ? 'canceled' : 'error');
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      presenting.current = false;
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <ScreenTitle
        badge="iOS"
        subtitle="Present the out-of-process web sign-in sheet from one stable test surface."
        testID="auth-session-lab-title"
        title="Sign-in sheet lab"
      />

      <SectionCard
        subtitle="Served over loopback by the fixture identity provider. The page holds fixture values only."
        title="Fixture identity provider"
      >
        <Text selectable style={styles.url} testID="auth-session-idp-url">
          {AUTH_IDP_DEFAULT_URL}
        </Text>
        <Text style={styles.body}>
          iOS hosts the sheet in com.apple.SafariViewService, over this screen and outside the
          app&apos;s process.
        </Text>
      </SectionCard>

      <SectionCard
        subtitle="Snapshot, wait, and selector commands must read and drive the sheet in place."
        title="Sheet"
      >
        <ActionButton label="SIGN IN" onPress={() => void openSheet()} testID="auth-session-open" />
        <Text style={styles.status} testID="auth-session-status">
          {status}
        </Text>
        {status === 'presenting' ? <InlineBadge label="Presenting" tone="accent" /> : null}
        <Text style={styles.body} testID="auth-session-message">
          {message}
        </Text>
      </SectionCard>

      <ActionButton
        kind="secondary"
        label="Back"
        onPress={props.onBack}
        testID="auth-session-back"
      />
    </ScrollView>
  );
}

function createStyles(colors: AppColors) {
  return StyleSheet.create({
    content: {
      gap: 16,
      padding: 20,
    },
    url: {
      color: colors.text,
      fontFamily: 'Menlo',
      fontSize: 13,
    },
    body: {
      color: colors.textSoft,
      fontSize: 14,
    },
    status: {
      color: colors.text,
      fontSize: 16,
      fontWeight: '600',
    },
  });
}
