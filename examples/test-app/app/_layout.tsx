import { Stack } from 'expo-router';
import { ThemeProvider } from 'expo-router/react-navigation';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastViewport } from '../src/components';
import { LabStateProvider, useLabState } from '../src/lab-state';
import { getNavigationTheme, useAppColors } from '../src/theme';

function RootLayoutContent() {
  const colors = useAppColors();
  const { toastMessage } = useLabState();

  return (
    <ThemeProvider value={getNavigationTheme(colors)}>
      <StatusBar style={colors.mode === 'light' ? 'dark' : 'light'} />
      <Stack
        screenOptions={{
          contentStyle: { backgroundColor: colors.surface },
          headerShown: false,
        }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="accessory-setup" />
        <Stack.Screen name="inert" options={{ presentation: 'fullScreenModal' }} />
        <Stack.Screen name="product/[productId]" />
      </Stack>
      {toastMessage ? <ToastViewport message={toastMessage} /> : null}
    </ThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <LabStateProvider>
          <RootLayoutContent />
        </LabStateProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
