import { useRef, useState } from 'react';
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { PRODUCT_CATEGORIES, type LabProduct, type ProductCategory } from '../data';
import {
  ActionButton,
  ChoiceChip,
  InlineBadge,
  ScreenTitle,
  SectionCard,
  TextField,
} from '../components';
import { useAppColors, type AppColors } from '../theme';

export interface CatalogScreenProps {
  activeCategory: ProductCategory;
  cart: Record<string, number>;
  favorites: Set<string>;
  products: LabProduct[];
  searchDraft: string;
  onAddToCart: (productId: string) => void;
  onOpenDetails: (productId: string) => void;
  onSearchDraftChange: (value: string) => void;
  onSelectCategory: (value: ProductCategory) => void;
  onToggleFavorite: (productId: string) => void;
}

export function CatalogScreen(props: CatalogScreenProps) {
  const colors = useAppColors();
  const styles = createStyles(colors);
  const lastScrollOffset = useRef(0);
  const [scrollState, setScrollState] = useState<'top' | 'bottom' | 'down' | 'up'>('top');

  function updateScrollState(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const offset = contentOffset.y;
    const previous = lastScrollOffset.current;
    lastScrollOffset.current = offset;
    if (offset <= 4) {
      setScrollState('top');
    } else if (offset + layoutMeasurement.height >= contentSize.height - 4) {
      setScrollState('bottom');
    } else if (offset > previous + 4) {
      setScrollState('down');
    } else if (offset < previous - 4) {
      setScrollState('up');
    }
  }

  return (
    <ScrollView
      bounces={false}
      contentContainerStyle={styles.content}
      onScroll={updateScrollState}
      scrollEventThrottle={16}
      showsVerticalScrollIndicator={false}
      // Pins the scroll-state line (child index 1) so every state it reports stays on screen.
      // Android accessibility snapshots carry on-screen nodes only, so a canary that scrolls
      // away can only ever be read as "top" — the state it holds before anything scrolls.
      stickyHeaderIndices={[1]}
    >
      <ScreenTitle
        badge={`${props.products.length} results`}
        subtitle="Search, filter, scroll, favorite, and drill into detail without extra dependencies."
        title="Catalog"
        testID="catalog-title"
      />
      <Text style={styles.scrollState} testID="catalog-scroll-state">
        Catalog scroll: {scrollState}
      </Text>

      <SectionCard subtitle="Search updates after a short debounce." title="Search">
        <TextField
          accessibilityLabel="Search products"
          label="Find a product"
          onChangeText={props.onSearchDraftChange}
          placeholder="Try: tart, kit, loaf"
          testID="catalog-search"
          value={props.searchDraft}
        />
        <View style={styles.chipRow}>
          {PRODUCT_CATEGORIES.map((category) => (
            <ChoiceChip
              key={category}
              label={category}
              onPress={() => props.onSelectCategory(category)}
              selected={props.activeCategory === category}
              testID={`category-${category.toLowerCase().replace(/\s+/g, '-')}`}
            />
          ))}
        </View>
      </SectionCard>

      {props.products.map((product) => {
        const favoriteLabel = props.favorites.has(product.id) ? 'Saved' : 'Save';
        const cartCount = props.cart[product.id] ?? 0;

        return (
          <SectionCard
            key={product.id}
            subtitle={product.subtitle}
            title={product.name}
            testID={`product-card-${product.id}`}
          >
            <View style={styles.metaRow}>
              <InlineBadge label={product.badge} tone="info" />
              <Text style={styles.price}>{product.price}</Text>
            </View>
            <View style={styles.metaRow}>
              <Pressable
                accessibilityLabel={`${favoriteLabel} ${product.name}`}
                accessibilityRole="button"
                accessibilityState={{ selected: props.favorites.has(product.id) }}
                onPress={() => props.onToggleFavorite(product.id)}
                style={({ pressed }) => [styles.favoritePill, pressed ? styles.pressed : null]}
                testID={`favorite-${product.id}`}
              >
                <Text style={styles.favoriteLabel}>{favoriteLabel}</Text>
              </Pressable>
              <Text style={styles.cartCount}>In cart: {cartCount}</Text>
            </View>
            <View style={styles.buttonRow}>
              <ActionButton
                kind="secondary"
                label="View details"
                onPress={() => props.onOpenDetails(product.id)}
                testID={`details-${product.id}`}
              />
              <ActionButton
                label="Add to cart"
                onPress={() => props.onAddToCart(product.id)}
                testID={`add-${product.id}`}
              />
            </View>
          </SectionCard>
        );
      })}

      <SectionCard
        subtitle="This footer card sits at the end of the list to force scroll-into-view on smaller screens."
        title="Seasonal footer target"
        testID="catalog-footer"
      >
        <Text style={styles.footerText}>
          If your run reaches this card, you already exercised long-list navigation. The durable
          text here is "Seasonal footer target".
        </Text>
      </SectionCard>
    </ScrollView>
  );
}

function createStyles(colors: AppColors) {
  return StyleSheet.create({
    content: {
      paddingBottom: 28,
    },
    chipRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
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
    scrollState: {
      color: colors.textSoft,
      fontSize: 13,
      fontWeight: '600',
    },
    favoritePill: {
      backgroundColor: 'transparent',
      borderColor: colors.line,
      borderRadius: 4,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    favoriteLabel: {
      color: colors.text,
      fontSize: 13,
      fontWeight: '700',
    },
    cartCount: {
      color: colors.textSoft,
      fontSize: 13,
      fontWeight: '600',
    },
    buttonRow: {
      gap: 10,
    },
    footerText: {
      color: colors.text,
      fontSize: 15,
      lineHeight: 22,
    },
    pressed: {
      opacity: 0.85,
    },
  });
}
