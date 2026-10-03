import { Keyboard, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  ActionButton,
  ChoiceChip,
  InlineBadge,
  ScreenTitle,
  SectionCard,
  TextField,
} from '../components';
import { useAppColors, type AppColors } from '../theme';

export interface CheckoutFormState {
  agree: boolean;
  email: string;
  imeCaptureTarget: string;
  name: string;
  notes: string;
  payment: 'Card' | 'Cash';
  phone: string;
  shipping: 'Delivery' | 'Pickup';
  subscribe: boolean;
}

export interface FormScreenProps {
  errors: string[];
  form: CheckoutFormState;
  onChange: <K extends keyof CheckoutFormState>(field: K, value: CheckoutFormState[K]) => void;
  onReset: () => void;
  onSubmit: () => void;
  submittedSummary: string | null;
}

function CheckboxRow(props: {
  label: string;
  value: boolean;
  onPress: () => void;
  testID: string;
}) {
  const colors = useAppColors();
  const styles = createStyles(colors);

  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: props.value }}
      onPress={props.onPress}
      style={({ pressed }) => [styles.checkboxRow, pressed ? styles.pressed : null]}
      testID={props.testID}
    >
      <View style={[styles.checkbox, props.value ? styles.checkboxChecked : null]}>
        <Text style={styles.checkboxMark}>{props.value ? 'X' : ''}</Text>
      </View>
      <Text style={styles.checkboxLabel}>{props.label}</Text>
    </Pressable>
  );
}

export function FormScreen(props: FormScreenProps) {
  const colors = useAppColors();
  const styles = createStyles(colors);

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <ScreenTitle
        badge="Validation"
        subtitle="Text inputs, choice groups, checkbox state, multiline notes, and submit feedback."
        testID="form-title"
        title="Checkout form"
      />

      {props.errors.length > 0 ? (
        <SectionCard
          subtitle="These messages should disappear after a valid submit."
          testID="form-errors"
          title="Validation errors"
          tone="danger"
        >
          {props.errors.map((error) => (
            <Text key={error} style={styles.errorText}>
              {error}
            </Text>
          ))}
        </SectionCard>
      ) : null}

      {props.submittedSummary ? (
        <SectionCard
          subtitle="This card appears only after a valid submit."
          testID="form-success"
          title="Order summary"
        >
          <InlineBadge label="Submitted" tone="success" />
          <Text style={styles.summaryText}>{props.submittedSummary}</Text>
        </SectionCard>
      ) : null}

      <SectionCard
        subtitle="Use fill for replacement and keyboard dismiss when the next control is blocked."
        title="Contact details"
      >
        <TextField
          accessibilityLabel="Full name"
          label="Full name"
          onChangeText={(value) => props.onChange('name', value)}
          placeholder="Type your full name"
          testID="field-name"
          value={props.form.name}
        />
        <TextField
          accessibilityLabel="Email"
          autoCapitalize="none"
          keyboardType="email-address"
          label="Email"
          onChangeText={(value) => props.onChange('email', value)}
          onSubmitEditing={() => Keyboard.dismiss()}
          placeholder="Type your email"
          returnKeyType="done"
          testID="field-email"
          value={props.form.email}
        />
        <TextField
          accessibilityLabel="Phone"
          keyboardType="phone-pad"
          label="Phone"
          onChangeText={(value) => props.onChange('phone', value)}
          placeholder="+48 555 010 010"
          testID="field-phone"
          value={props.form.phone}
        />
      </SectionCard>

      <SectionCard
        subtitle="A fixture for Android cases where Gboard handwriting owns the focused input."
        testID="android-ime-capture-fixture"
        title="Android IME capture"
      >
        {/* Fixture: static diagnostic copy, not live state. */}
        <TextField
          accessibilityLabel="Android IME target field"
          autoCapitalize="none"
          label="Android IME target field"
          onChangeText={(value) => props.onChange('imeCaptureTarget', value)}
          placeholder="Search term"
          testID="field-ime-capture-target"
          value={props.form.imeCaptureTarget}
        />
        <View style={styles.diagnosticBlock} testID="ime-capture-diagnostic">
          <Text style={styles.diagnosticText}>
            Android fill input was captured by the active keyboard instead of the app field
          </Text>
          <Text style={styles.diagnosticMeta}>
            targetInput id=&quot;field-ime-capture-target&quot;
          </Text>
          <Text style={styles.diagnosticMeta}>
            actualInput packageName=&quot;com.google.android.inputmethod.latin&quot;
            inputMethodOwned=true
          </Text>
        </View>
      </SectionCard>

      <SectionCard
        subtitle="These button groups are stable selector targets."
        title="Delivery choices"
      >
        <View style={styles.choiceRow}>
          <ChoiceChip
            label="Delivery"
            onPress={() => props.onChange('shipping', 'Delivery')}
            selected={props.form.shipping === 'Delivery'}
            testID="shipping-delivery"
          />
          <ChoiceChip
            label="Pickup"
            onPress={() => props.onChange('shipping', 'Pickup')}
            selected={props.form.shipping === 'Pickup'}
            testID="shipping-pickup"
          />
        </View>
        <View style={styles.choiceRow}>
          <ChoiceChip
            label="Card"
            onPress={() => props.onChange('payment', 'Card')}
            selected={props.form.payment === 'Card'}
            testID="payment-card"
          />
          <ChoiceChip
            label="Cash"
            onPress={() => props.onChange('payment', 'Cash')}
            selected={props.form.payment === 'Cash'}
            testID="payment-cash"
          />
        </View>
      </SectionCard>

      <SectionCard
        subtitle="The notes field is intentionally multiline for append-vs-fill tests."
        title="Preferences"
      >
        <TextField
          accessibilityLabel="Delivery notes"
          label="Delivery notes"
          multiline
          onChangeText={(value) => props.onChange('notes', value)}
          placeholder="Leave at the orange counter."
          testID="field-notes"
          value={props.form.notes}
        />
        <CheckboxRow
          label="Email me product updates"
          onPress={() => props.onChange('subscribe', !props.form.subscribe)}
          testID="checkbox-subscribe"
          value={props.form.subscribe}
        />
        <CheckboxRow
          label="I confirm the order details"
          onPress={() => props.onChange('agree', !props.form.agree)}
          testID="checkbox-agree"
          value={props.form.agree}
        />
        <View style={styles.actionStack}>
          <ActionButton label="Submit order" onPress={props.onSubmit} testID="submit-order" />
          <ActionButton
            kind="secondary"
            label="Dismiss keyboard"
            onPress={() => Keyboard.dismiss()}
            testID="dismiss-keyboard"
          />
          <ActionButton
            kind="secondary"
            label="Reset form"
            onPress={props.onReset}
            testID="reset-form"
          />
        </View>
      </SectionCard>
    </ScrollView>
  );
}

function createStyles(colors: AppColors) {
  return StyleSheet.create({
    content: {
      paddingBottom: 28,
    },
    errorText: {
      color: colors.danger,
      fontSize: 15,
      lineHeight: 22,
    },
    summaryText: {
      color: colors.text,
      fontSize: 15,
      lineHeight: 22,
    },
    choiceRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
    },
    diagnosticBlock: {
      backgroundColor: colors.cardStrong,
      borderColor: colors.line,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      gap: 6,
      padding: 12,
    },
    diagnosticMeta: {
      color: colors.textSoft,
      fontFamily: 'monospace',
      fontSize: 12,
      lineHeight: 18,
    },
    diagnosticText: {
      color: colors.text,
      fontSize: 14,
      lineHeight: 20,
    },
    checkboxRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 12,
    },
    checkbox: {
      alignItems: 'center',
      backgroundColor: colors.cardStrong,
      borderColor: colors.line,
      borderRadius: 4,
      borderWidth: StyleSheet.hairlineWidth,
      height: 24,
      justifyContent: 'center',
      width: 24,
    },
    checkboxChecked: {
      backgroundColor: colors.text,
      borderColor: colors.text,
    },
    checkboxMark: {
      color: colors.surface,
      fontSize: 12,
      fontWeight: '700',
    },
    checkboxLabel: {
      color: colors.text,
      flex: 1,
      fontSize: 15,
      lineHeight: 21,
    },
    actionStack: {
      gap: 10,
    },
    pressed: {
      opacity: 0.85,
    },
  });
}
