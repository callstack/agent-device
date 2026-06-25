import { NativeTabs } from 'expo-router/unstable-native-tabs';

import { useLabState } from '../../src/lab-state';
import { useAppColors } from '../../src/theme';

export default function TabsLayout() {
  const colors = useAppColors();
  const { cartCount, diagnosticsState } = useLabState();

  return (
    <NativeTabs
      backgroundColor={colors.tabBar}
      badgeBackgroundColor={colors.accent}
      iconColor={{ default: colors.textSoft, selected: colors.text }}
      labelStyle={{
        default: { color: colors.textSoft, fontSize: 11, fontWeight: '600' },
        selected: { color: colors.text, fontSize: 11, fontWeight: '700' },
      }}
      tintColor={colors.text}
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon md="home" sf="house.fill" />
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="catalog">
        <NativeTabs.Trigger.Icon md="storefront" sf="square.grid.2x2.fill" />
        <NativeTabs.Trigger.Label>Catalog</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Badge hidden={cartCount === 0}>
          {String(cartCount)}
        </NativeTabs.Trigger.Badge>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="form">
        <NativeTabs.Trigger.Icon md="fact_check" sf="doc.text.fill" />
        <NativeTabs.Trigger.Label>Form</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="audio">
        <NativeTabs.Trigger.Icon md="music_note" sf="waveform" />
        <NativeTabs.Trigger.Label>Audio</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Icon md="settings" sf="gearshape.fill" />
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Badge hidden={diagnosticsState !== 'error'}>!</NativeTabs.Trigger.Badge>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
