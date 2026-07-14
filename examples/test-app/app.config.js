const buildRunCacheDir =
  process.env.AGENT_DEVICE_EXPO_BUILD_CACHE_DIR?.trim() || './.expo/build-run-cache';
const accessoryBluetoothName =
  process.env.AGENT_DEVICE_TEST_ACCESSORY_BLUETOOTH_NAME?.trim() || 'Mori';
const accessoryServiceUuid = process.env.AGENT_DEVICE_TEST_ACCESSORY_SERVICE_UUID?.trim();

const accessoryInfoPlist = {
  NSAccessorySetupBluetoothNames: [accessoryBluetoothName],
  NSAccessorySetupSupports: ['Bluetooth'],
  ...(accessoryServiceUuid ? { NSAccessorySetupBluetoothServices: [accessoryServiceUuid] } : {}),
};

module.exports = {
  expo: {
    name: 'Agent Device Tester',
    slug: 'agent-device-test-app',
    scheme: 'agent-device-test-app',
    version: '1.0.0',
    orientation: 'default',
    userInterfaceStyle: 'automatic',
    buildCacheProvider: {
      plugin: 'expo-build-disk-cache',
      options: {
        cacheDir: buildRunCacheDir,
      },
    },
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
