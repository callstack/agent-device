import { useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';

import accessorySetupConfig from '../../accessory-setup.config.json';
import { showAccessorySetupPicker } from '../accessory-setup';
import { ActionButton, InlineBadge, ScreenTitle, SectionCard } from '../components';
import { useAppColors, type AppColors } from '../theme';

type PickerStatus = 'idle' | 'opening' | 'dismissed' | 'error';

export function AccessorySetupScreen(props: { onBack: () => void }) {
  const colors = useAppColors();
  const styles = createStyles(colors);
  const [status, setStatus] = useState<PickerStatus>('idle');
  const [message, setMessage] = useState('Ready to open the system accessory picker.');

  async function openPicker() {
    setStatus('opening');
    setMessage('Accessory picker requested.');

    try {
      await showAccessorySetupPicker();
      setStatus('dismissed');
      setMessage('Accessory picker dismissed.');
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <ScreenTitle
        badge="iOS 18+"
        subtitle="Launch the out-of-process AccessorySetupUI picker from one stable test surface."
        testID="accessory-setup-title"
        title="Accessory setup lab"
      />

      <SectionCard
        subtitle="The development client is already configured for this service."
        title="Test accessory"
      >
        <Text selectable style={styles.uuid} testID="accessory-service-uuid">
          {accessorySetupConfig.serviceUuid}
        </Text>
        <Text style={styles.body}>
          Advertise this Bluetooth service near the physical iPhone before opening the picker.
        </Text>
      </SectionCard>

      <SectionCard
        subtitle="Use snapshot, wait, and selector click against the system surface."
        title="Picker"
      >
        <ActionButton
          label="Open accessory picker"
          onPress={openPicker}
          testID="open-accessory-picker"
        />
        <InlineBadge
          label={
            status === 'idle'
              ? 'Ready'
              : status === 'opening'
                ? 'Opening'
                : status === 'dismissed'
                  ? 'Dismissed'
                  : 'Error'
          }
          tone={status === 'error' ? 'danger' : status === 'dismissed' ? 'success' : 'accent'}
        />
        <Text
          accessibilityLiveRegion="polite"
          style={status === 'error' ? styles.error : styles.body}
          testID="accessory-picker-status"
        >
          {message}
        </Text>
      </SectionCard>

      <ActionButton
        kind="secondary"
        label="Back to settings"
        onPress={props.onBack}
        testID="accessory-setup-back"
      />
    </ScrollView>
  );
}

function createStyles(colors: AppColors) {
  return StyleSheet.create({
    body: {
      color: colors.text,
      fontSize: 14,
      lineHeight: 21,
    },
    content: {
      paddingBottom: 28,
    },
    error: {
      color: colors.danger,
      fontSize: 14,
      lineHeight: 21,
    },
    uuid: {
      color: colors.text,
      fontFamily: 'monospace',
      fontSize: 13,
      lineHeight: 20,
    },
  });
}
