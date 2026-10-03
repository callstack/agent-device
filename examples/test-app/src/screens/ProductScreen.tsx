import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { LabProduct } from '../data';
import { ActionButton, InlineBadge, ScreenTitle, SectionCard, TextField } from '../components';
import { useAppColors, type AppColors } from '../theme';

export interface ProductScreenProps {
  detailNote: string;
  isFavorite: boolean;
  onBack: () => void;
  onChangeDetailNote: (value: string) => void;
  onDecreaseQuantity: () => void;
  onIncreaseQuantity: () => void;
  onSave: () => void;
  onToggleFavorite: () => void;
  product: LabProduct;
  quantity: number;
}

export function ProductScreen(props: ProductScreenProps) {
  const colors = useAppColors();
  const styles = createStyles(colors);

  return (
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <ScreenTitle
        badge={props.product.badge}
        subtitle="A focused detail page for back navigation, quantity edits, notes, and save actions."
        testID="product-title"
        title={props.product.name}
      />

      <SectionCard subtitle={props.product.subtitle} title="Product detail">
        <View style={styles.metaRow}>
          <InlineBadge label={props.product.category} tone="info" />
          <Text style={styles.price}>{props.product.price}</Text>
        </View>
        <Text style={styles.description}>
          This detail view is intentionally simple so selectors stay stable while still covering the
          most useful interaction patterns.
        </Text>
        <View style={styles.actionStack}>
          <ActionButton
            kind="secondary"
            label="Back to catalog"
            onPress={props.onBack}
            testID="product-back"
          />
          <ActionButton
            kind="secondary"
            label={props.isFavorite ? 'Remove favorite' : 'Save favorite'}
            onPress={props.onToggleFavorite}
            testID="product-favorite"
          />
        </View>
      </SectionCard>

      <SectionCard
        subtitle="Good for press, get text, and state-change assertions."
        title="Quantity"
      >
        <View style={styles.quantityRow}>
          <ActionButton
            kind="secondary"
            label="Decrease"
            onPress={props.onDecreaseQuantity}
            testID="quantity-decrease"
          />
          <Text style={styles.quantityValue} testID="quantity-value">
            {props.quantity}
          </Text>
          <ActionButton
            kind="secondary"
            label="Increase"
            onPress={props.onIncreaseQuantity}
            testID="quantity-increase"
          />
        </View>
      </SectionCard>

      <SectionCard
        subtitle="Use fill or type depending on whether you want replace or append semantics."
        title="Detail note"
      >
        <TextField
          accessibilityLabel="Product note"
          label="Order note"
          multiline
          onChangeText={props.onChangeDetailNote}
          placeholder="Pack this with the breakfast order."
          testID="product-note"
          value={props.detailNote}
        />
        <ActionButton label="Save to cart" onPress={props.onSave} testID="product-save" />
      </SectionCard>
    </ScrollView>
  );
}

function createStyles(colors: AppColors) {
  return StyleSheet.create({
    content: {
      paddingBottom: 28,
    },
    metaRow: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    price: {
      color: colors.text,
      fontSize: 18,
      fontWeight: '700',
    },
    description: {
      color: colors.text,
      fontSize: 15,
      lineHeight: 22,
    },
    actionStack: {
      gap: 10,
    },
    quantityRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 12,
      justifyContent: 'space-between',
    },
    quantityValue: {
      color: colors.text,
      fontSize: 32,
      fontWeight: '700',
      minWidth: 40,
      textAlign: 'center',
    },
  });
}
