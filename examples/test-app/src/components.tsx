import type { ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppColors, type AppColors } from './theme';

export function ScreenTitle(props: {
  title: string;
  subtitle: string;
  badge?: string;
  testID?: string;
}) {
  const colors = useAppColors();
  const styles = createStyles(colors);

  return (
    <View style={styles.header} testID={props.testID}>
      <View style={styles.headerText}>
        <Text style={styles.title}>{props.title}</Text>
        <Text style={styles.subtitle}>{props.subtitle}</Text>
      </View>
      {props.badge ? <InlineBadge label={props.badge} tone="accent" /> : null}
    </View>
  );
}

export function SectionCard(props: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  tone?: 'base' | 'accent' | 'danger';
  testID?: string;
}) {
  const colors = useAppColors();
  const styles = createStyles(colors);

  return (
    <View
      style={[
        styles.card,
        props.tone === 'accent' ? styles.cardAccent : null,
        props.tone === 'danger' ? styles.cardDanger : null,
      ]}
      testID={props.testID}
    >
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>{props.title}</Text>
        {props.subtitle ? <Text style={styles.cardSubtitle}>{props.subtitle}</Text> : null}
      </View>
      {props.children}
    </View>
  );
}

export function ActionButton(props: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger';
  testID?: string;
}) {
  const colors = useAppColors();
  const styles = createStyles(colors);

  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.button,
        props.kind === 'secondary' ? styles.buttonSecondary : null,
        props.kind === 'danger' ? styles.buttonDanger : null,
        pressed ? styles.buttonPressed : null,
      ]}
      testID={props.testID}
    >
      <Text
        style={[
          styles.buttonLabel,
          props.kind === 'secondary' ? styles.buttonLabelSecondary : null,
          props.kind === 'danger' ? styles.buttonLabelDanger : null,
        ]}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

export function ChoiceChip(props: {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const colors = useAppColors();
  const styles = createStyles(colors);

  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.chip,
        props.selected ? styles.chipSelected : null,
        pressed ? styles.buttonPressed : null,
      ]}
      testID={props.testID}
    >
      <Text style={[styles.chipLabel, props.selected ? styles.chipLabelSelected : null]}>
        {props.label}
      </Text>
    </Pressable>
  );
}

export function ToggleRow(props: {
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  description?: string;
  testID?: string;
}) {
  const colors = useAppColors();
  const styles = createStyles(colors);

  return (
    <View style={styles.toggleRow} testID={props.testID}>
      <View style={styles.toggleText}>
        <Text style={styles.toggleLabel}>{props.label}</Text>
        {props.description ? (
          <Text style={styles.toggleDescription}>{props.description}</Text>
        ) : null}
      </View>
      <Switch
        accessibilityLabel={props.label}
        accessibilityRole="switch"
        accessibilityState={{ checked: props.value }}
        ios_backgroundColor={colors.lineStrong}
        onValueChange={props.onValueChange}
        thumbColor={props.value ? colors.accent : colors.card}
        trackColor={{ false: colors.lineStrong, true: colors.accentSoft }}
        value={props.value}
      />
    </View>
  );
}

export function TextField(
  props: TextInputProps & {
    label: string;
    testID?: string;
  },
) {
  const { accessibilityLabel, label, multiline, style, testID, ...inputProps } = props;
  const colors = useAppColors();
  const styles = createStyles(colors);

  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        {...inputProps}
        accessibilityLabel={accessibilityLabel ?? label}
        multiline={multiline}
        placeholderTextColor={colors.textSoft}
        style={[styles.fieldInput, multiline ? styles.fieldInputMultiline : null, style]}
        testID={testID}
      />
    </View>
  );
}

export function InlineBadge(props: {
  label: string;
  tone: 'accent' | 'success' | 'info' | 'neutral' | 'danger';
}) {
  const colors = useAppColors();
  const styles = createStyles(colors);

  return (
    <View
      style={[
        styles.badge,
        props.tone === 'accent' ? styles.badgeAccent : null,
        props.tone === 'success' ? styles.badgeSuccess : null,
        props.tone === 'info' ? styles.badgeInfo : null,
        props.tone === 'danger' ? styles.badgeDanger : null,
      ]}
    >
      <Text style={[styles.badgeLabel, props.tone === 'danger' ? styles.badgeLabelDanger : null]}>
        {props.label}
      </Text>
    </View>
  );
}

export function AppFrame(props: { children: ReactNode }) {
  const colors = useAppColors();
  const insets = useSafeAreaInsets();
  const styles = createStyles(colors);

  return (
    <View
      style={[
        styles.frame,
        {
          paddingBottom: Math.max(insets.bottom, 12),
          paddingTop: Math.max(insets.top, 12),
        },
      ]}
    >
      {props.children}
    </View>
  );
}

export function ToastViewport(props: { message: string }) {
  const colors = useAppColors();
  const insets = useSafeAreaInsets();
  const styles = createStyles(colors);

  return (
    <View
      pointerEvents="none"
      style={[
        styles.toastViewport,
        {
          bottom: Math.max(insets.bottom, 16),
        },
      ]}
    >
      <View style={styles.toast} testID="global-toast">
        <Text style={styles.toastLabel}>{props.message}</Text>
      </View>
    </View>
  );
}

function createStyles(colors: AppColors) {
  return StyleSheet.create({
    header: {
      alignItems: 'flex-start',
      flexDirection: 'row',
      gap: 12,
      justifyContent: 'space-between',
      marginBottom: 24,
      paddingBottom: 20,
      borderBottomColor: colors.line,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    headerText: {
      flex: 1,
      gap: 6,
    },
    title: {
      color: colors.text,
      fontSize: 32,
      fontWeight: '500',
      letterSpacing: 0,
      lineHeight: 36,
    },
    subtitle: {
      color: colors.textSoft,
      fontSize: 15,
      lineHeight: 23,
    },
    card: {
      backgroundColor: colors.card,
      borderColor: colors.line,
      borderRadius: 4,
      borderWidth: StyleSheet.hairlineWidth,
      gap: 14,
      marginBottom: 12,
      padding: 16,
    },
    cardAccent: {
      borderColor: colors.accentSoft,
    },
    cardDanger: {
      backgroundColor: colors.cardStrong,
      borderColor: colors.danger,
    },
    cardHeader: {
      gap: 6,
    },
    cardTitle: {
      color: colors.text,
      fontSize: 21,
      fontWeight: '500',
      letterSpacing: 0,
      lineHeight: 25,
    },
    cardSubtitle: {
      color: colors.textSoft,
      fontSize: 14,
      lineHeight: 20,
    },
    button: {
      alignItems: 'center',
      backgroundColor: colors.text,
      borderColor: colors.text,
      borderRadius: 4,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: 16,
      paddingVertical: 13,
    },
    buttonSecondary: {
      backgroundColor: 'transparent',
      borderColor: colors.lineStrong,
    },
    buttonDanger: {
      backgroundColor: colors.danger,
      borderColor: colors.danger,
    },
    buttonPressed: {
      opacity: 0.85,
    },
    buttonLabel: {
      color: colors.surface,
      fontSize: 15,
      fontWeight: '600',
    },
    buttonLabelSecondary: {
      color: colors.text,
    },
    buttonLabelDanger: {
      color: colors.dangerContrast,
    },
    chip: {
      backgroundColor: 'transparent',
      borderColor: colors.line,
      borderRadius: 4,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    chipSelected: {
      backgroundColor: colors.text,
      borderColor: colors.text,
    },
    chipLabel: {
      color: colors.text,
      fontSize: 14,
      fontWeight: '600',
    },
    chipLabelSelected: {
      color: colors.surface,
    },
    toggleRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 12,
      justifyContent: 'space-between',
      borderTopColor: colors.line,
      borderTopWidth: StyleSheet.hairlineWidth,
      paddingTop: 14,
    },
    toggleText: {
      flex: 1,
      gap: 4,
    },
    toggleLabel: {
      color: colors.text,
      fontSize: 16,
      fontWeight: '600',
    },
    toggleDescription: {
      color: colors.textSoft,
      fontSize: 13,
      lineHeight: 18,
    },
    field: {
      gap: 8,
    },
    fieldLabel: {
      color: colors.text,
      fontSize: 14,
      fontWeight: '700',
    },
    fieldInput: {
      backgroundColor: colors.field,
      borderColor: colors.line,
      borderRadius: 4,
      borderWidth: StyleSheet.hairlineWidth,
      color: colors.text,
      fontSize: 16,
      minHeight: 52,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    fieldInputMultiline: {
      minHeight: 110,
      textAlignVertical: 'top',
    },
    badge: {
      alignSelf: 'flex-start',
      backgroundColor: 'transparent',
      borderColor: colors.line,
      borderRadius: 4,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    badgeAccent: {
      borderColor: colors.accentSoft,
    },
    badgeSuccess: {
      backgroundColor: colors.cardStrong,
    },
    badgeInfo: {
      backgroundColor: colors.cardStrong,
    },
    badgeDanger: {
      backgroundColor: colors.danger,
    },
    badgeLabel: {
      color: colors.text,
      fontSize: 12,
      fontWeight: '600',
    },
    badgeLabelDanger: {
      color: colors.dangerContrast,
    },
    frame: {
      backgroundColor: colors.surface,
      flex: 1,
      paddingHorizontal: 18,
    },
    toastViewport: {
      left: 16,
      position: 'absolute',
      right: 16,
    },
    toast: {
      backgroundColor: colors.cardStrong,
      borderColor: colors.lineStrong,
      borderRadius: 4,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    toastLabel: {
      color: colors.text,
      fontSize: 14,
      fontWeight: '700',
      textAlign: 'center',
    },
  });
}
