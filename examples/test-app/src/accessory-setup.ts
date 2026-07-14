import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

type AccessorySetupLabModule = {
  showPickerAsync(): Promise<void>;
};

export async function showAccessorySetupPicker(): Promise<void> {
  if (Platform.OS !== 'ios') {
    throw new Error('AccessorySetupKit is available only on iOS.');
  }

  const module = requireOptionalNativeModule<AccessorySetupLabModule>('AccessorySetupLab');
  if (!module) {
    throw new Error('Rebuild the iOS development client to include AccessorySetupLab.');
  }

  await module.showPickerAsync();
}
