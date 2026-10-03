export const PRODUCT_CATEGORIES = ['All', 'Starter Kits', 'Produce', 'Bakery', 'Pantry'] as const;

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

export interface LabProduct {
  badge: string;
  category: Exclude<ProductCategory, 'All'>;
  id: string;
  name: string;
  price: string;
  subtitle: string;
}

export const LAB_PRODUCTS: LabProduct[] = [
  {
    id: 'citrus-kit',
    name: 'Citrus Starter Kit',
    category: 'Starter Kits',
    price: '$12',
    subtitle: 'A bright bundle for quick search, detail, and quantity flows.',
    badge: 'Popular',
  },
  {
    id: 'morning-box',
    name: 'Morning Prep Box',
    category: 'Starter Kits',
    price: '$18',
    subtitle: 'Tests multi-step navigation with badges and action buttons.',
    badge: 'New',
  },
  {
    id: 'avocado-stack',
    name: 'Avocado Stack',
    category: 'Produce',
    price: '$7',
    subtitle: 'Short card copy with favorite and add-to-cart actions.',
    badge: 'Fresh',
  },
  {
    id: 'pepper-mix',
    name: 'Pepper Mix',
    category: 'Produce',
    price: '$9',
    subtitle: 'Useful for filters, scroll, and selector durability checks.',
    badge: 'Crisp',
  },
  {
    id: 'herb-bundle',
    name: 'Herb Bundle',
    category: 'Produce',
    price: '$6',
    subtitle: 'A compact row for visible-text and existence assertions.',
    badge: 'Seasonal',
  },
  {
    id: 'pretzel-bites',
    name: 'Pretzel Bites',
    category: 'Bakery',
    price: '$8',
    subtitle: 'Helps exercise off-screen discovery and scoped snapshots.',
    badge: 'Snack',
  },
  {
    id: 'sourdough-loaf',
    name: 'Sourdough Loaf',
    category: 'Bakery',
    price: '$11',
    subtitle: 'Works well for favorite toggles and detail page assertions.',
    badge: 'Warm',
  },
  {
    id: 'berry-tart',
    name: 'Berry Tart',
    category: 'Bakery',
    price: '$14',
    subtitle: 'A longer list item to force scrolling on smaller devices.',
    badge: 'Sweet',
  },
  {
    id: 'tea-tins',
    name: 'Tea Tins',
    category: 'Pantry',
    price: '$10',
    subtitle: 'Good target for search debounce and cart state updates.',
    badge: 'Calm',
  },
  {
    id: 'olive-jar',
    name: 'Olive Jar',
    category: 'Pantry',
    price: '$13',
    subtitle: 'A stable card for replay maintenance and selector exercises.',
    badge: 'Classic',
  },
  {
    id: 'noodle-pack',
    name: 'Noodle Pack',
    category: 'Pantry',
    price: '$15',
    subtitle: 'Works well for detail notes and quantity edits.',
    badge: 'Fast',
  },
  {
    id: 'seasonal-footer',
    name: 'Seasonal Footer Pick',
    category: 'Pantry',
    price: '$16',
    subtitle: 'Placed last on purpose so scroll-into-view flows have a durable target.',
    badge: 'Scroll Target',
  },
];
