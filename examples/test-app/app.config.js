const accessorySetupConfig = require('./accessory-setup.config.json');

const accessoryInfoPlist = {
  NSAccessorySetupBluetoothServices: [accessorySetupConfig.serviceUuid],
  NSAccessorySetupKitSupports: ['Bluetooth'],
};

module.exports = {
  expo: {
    name: 'Agent Device Tester',
    slug: 'agent-device-test-app',
    scheme: 'agent-device-test-app',
    version: '1.0.0',
    orientation: 'default',
    userInterfaceStyle: 'automatic',
    // Local `expo run:*` caches the native build on disk, keyed by the Expo
    // fingerprint, so a second run with no native change reuses it instead of
    // rebuilding. CI does not rely on this — it builds Release and shares the
    // result through GitHub artifacts (see .github/workflows/test-app-build-cache.yml).
    buildCacheProvider: { plugin: 'expo-build-disk-cache' },
    plugins: ['expo-router'],
    ios: {
      supportsTablet: true,
      bundleIdentifier: 'com.callstack.agentdevicelab',
      infoPlist: accessoryInfoPlist,
    },
    android: {
      package: 'com.callstack.agentdevicelab',
      predictiveBackGestureEnabled: false,
    },
  },
};
