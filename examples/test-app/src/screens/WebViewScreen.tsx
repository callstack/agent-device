import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

import { useAppColors, type AppColors } from '../theme';
import { WEBVIEW_ACCESSIBILITY_FIXTURE } from '../webview-accessibility-fixture';

const SITES = [
  { key: 'fixture', label: 'Fixture', source: { html: WEBVIEW_ACCESSIBILITY_FIXTURE } },
  { key: 'callstack', label: 'Callstack', source: { uri: 'https://www.callstack.com/' } },
  { key: 'vercel', label: 'Vercel', source: { uri: 'https://vercel.com/' } },
  { key: 'hacker-news', label: 'Hacker News', source: { uri: 'https://news.ycombinator.com/' } },
  { key: 'reddit', label: 'Reddit', source: { uri: 'https://www.reddit.com/' } },
  {
    key: 'w3c-forms',
    label: 'W3C forms',
    source: { uri: 'https://www.w3.org/WAI/tutorials/forms/' },
  },
  {
    key: 'wikipedia',
    label: 'Wikipedia',
    source: { uri: 'https://en.wikipedia.org/wiki/Accessibility' },
  },
] as const;

type Site = (typeof SITES)[number];
type LoadState = { kind: 'loading' | 'loaded' } | { kind: 'error'; message: string };

export function WebViewScreen(props: { onClose: () => void }) {
  const colors = useAppColors();
  const insets = useSafeAreaInsets();
  const styles = createStyles(colors);
  const [site, setSite] = useState<Site>(SITES[0]);
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });

  function selectSite(nextSite: Site) {
    if (nextSite.key === site.key) return;
    setSite(nextSite);
    setLoadState({ kind: 'loading' });
  }

  return (
    <View style={[styles.screen, { paddingTop: Math.max(insets.top, 12) }]}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Close WebView accessibility lab"
          accessibilityRole="button"
          onPress={props.onClose}
          style={({ pressed }) => [styles.closeButton, pressed ? styles.pressed : null]}
          testID="close-webview-lab"
        >
          <Text style={styles.closeLabel}>Close</Text>
        </Pressable>
        <View style={styles.heading}>
          <Text style={styles.title}>WebView accessibility</Text>
          <Text style={styles.subtitle}>
            Compare semantic roles exposed by real websites through the native accessibility tree.
          </Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.sitePicker}
        horizontal
        showsHorizontalScrollIndicator={false}
      >
        {SITES.map((candidate) => {
          const selected = candidate.key === site.key;
          return (
            <Pressable
              accessibilityLabel={`Load ${candidate.label}`}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              key={candidate.key}
              onPress={() => selectSite(candidate)}
              style={({ pressed }) => [
                styles.siteButton,
                selected ? styles.siteButtonSelected : null,
                pressed ? styles.pressed : null,
              ]}
              testID={`webview-site-${candidate.key}`}
            >
              <Text style={[styles.siteLabel, selected ? styles.siteLabelSelected : null]}>
                {candidate.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.status} accessibilityLiveRegion="polite">
        <Text style={styles.statusText} testID="webview-status">
          {formatLoadStatus(site.label, loadState)}
        </Text>
        {loadState.kind === 'loading' ? (
          <ActivityIndicator color={colors.accent} size="small" />
        ) : null}
      </View>

      <View style={styles.webViewFrame}>
        <WebView
          allowsBackForwardNavigationGestures
          key={site.key}
          onError={(event) => {
            setLoadState({ kind: 'error', message: event.nativeEvent.description });
          }}
          onHttpError={(event) => {
            const { description, statusCode } = event.nativeEvent;
            setLoadState({
              kind: 'error',
              message: description || `HTTP ${statusCode}`,
            });
          }}
          onLoad={() =>
            setLoadState((current) => (current.kind === 'error' ? current : { kind: 'loaded' }))
          }
          onLoadStart={() => setLoadState({ kind: 'loading' })}
          source={site.source}
          startInLoadingState
          style={styles.webView}
          testID="webview-content"
        />
      </View>
    </View>
  );
}

function formatLoadStatus(siteLabel: string, loadState: LoadState): string {
  switch (loadState.kind) {
    case 'loading':
      return `Loading ${siteLabel}…`;
    case 'loaded':
      return `Loaded ${siteLabel}`;
    case 'error':
      return `Failed to load ${siteLabel}: ${loadState.message}`;
  }
}

function createStyles(colors: AppColors) {
  return StyleSheet.create({
    screen: {
      backgroundColor: colors.surface,
      flex: 1,
    },
    header: {
      alignItems: 'flex-start',
      borderBottomColor: colors.line,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: 14,
      paddingBottom: 14,
      paddingHorizontal: 16,
    },
    closeButton: {
      borderColor: colors.lineStrong,
      borderRadius: 4,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    closeLabel: {
      color: colors.text,
      fontSize: 14,
      fontWeight: '600',
    },
    heading: {
      flex: 1,
      gap: 4,
    },
    title: {
      color: colors.text,
      fontSize: 24,
      fontWeight: '600',
      lineHeight: 28,
    },
    subtitle: {
      color: colors.textSoft,
      fontSize: 13,
      lineHeight: 18,
    },
    sitePicker: {
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    siteButton: {
      alignSelf: 'flex-start',
      borderColor: colors.lineStrong,
      borderRadius: 4,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: 12,
      paddingVertical: 9,
    },
    siteButtonSelected: {
      backgroundColor: colors.text,
      borderColor: colors.text,
    },
    siteLabel: {
      color: colors.text,
      fontSize: 13,
      fontWeight: '600',
    },
    siteLabelSelected: {
      color: colors.surface,
    },
    status: {
      alignItems: 'center',
      borderBottomColor: colors.line,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: 8,
      justifyContent: 'space-between',
      minHeight: 38,
      paddingHorizontal: 16,
      paddingVertical: 8,
    },
    statusText: {
      color: colors.textSoft,
      flex: 1,
      fontSize: 12,
    },
    webViewFrame: {
      flex: 1,
    },
    webView: {
      backgroundColor: colors.surface,
      flex: 1,
    },
    pressed: {
      opacity: 0.75,
    },
  });
}
