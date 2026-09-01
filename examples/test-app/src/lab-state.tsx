import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { LAB_PRODUCTS, type ProductCategory } from './data';
import type { CheckoutFormState } from './screens/FormScreen';

const initialFormState: CheckoutFormState = {
  name: '',
  email: '',
  phone: '',
  imeCaptureTarget: '',
  notes: '',
  shipping: 'Delivery',
  payment: 'Card',
  subscribe: true,
  agree: false,
};

interface ProductDraft {
  note: string;
  quantity: number;
}

interface LabStateContextValue {
  activeCategory: ProductCategory;
  addToCart: (productId: string, quantity?: number) => void;
  cartCount: number;
  cartCounts: Record<string, number>;
  catalogProducts: typeof LAB_PRODUCTS;
  decreaseProductQuantity: (productId: string) => void;
  detailDrafts: Record<string, ProductDraft>;
  diagnosticsExpanded: boolean;
  diagnosticsLoading: boolean;
  diagnosticsState: 'idle' | 'ready' | 'error';
  dismissNotice: () => void;
  favoriteIds: string[];
  form: CheckoutFormState;
  formErrors: string[];
  increaseProductQuantity: (productId: string) => void;
  isOnline: boolean;
  isRefreshing: boolean;
  lastSyncLabel: string;
  loadDiagnostics: () => void;
  noticeVisible: boolean;
  notificationsEnabled: boolean;
  reducedMotionEnabled: boolean;
  refreshMetrics: () => void;
  resetForm: () => void;
  resetLabState: () => void;
  retryDiagnostics: () => void;
  saveProductToCart: (productId: string) => void;
  searchDraft: string;
  setActiveCategory: (value: ProductCategory) => void;
  setDiagnosticsExpanded: (value: boolean) => void;
  setIsOnline: (value: boolean) => void;
  setNotificationsEnabled: (value: boolean) => void;
  setProductNote: (productId: string, value: string) => void;
  setReducedMotionEnabled: (value: boolean) => void;
  setSearchDraft: (value: string) => void;
  submitOrder: () => void;
  submittedSummary: string | null;
  toastMessage: string | null;
  toggleFavorite: (productId: string) => void;
  updateForm: <K extends keyof CheckoutFormState>(field: K, value: CheckoutFormState[K]) => void;
}

const LabStateContext = createContext<LabStateContextValue | null>(null);

export function LabStateProvider(props: { children: ReactNode }) {
  const [detailDrafts, setDetailDrafts] = useState<Record<string, ProductDraft>>({});
  const [searchDraft, setSearchDraft] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<ProductCategory>('All');
  const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
  const [cartCounts, setCartCounts] = useState<Record<string, number>>({});
  const [noticeVisible, setNoticeVisible] = useState(true);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastSyncLabel, setLastSyncLabel] = useState('Never');
  const [form, setForm] = useState<CheckoutFormState>(initialFormState);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [submittedSummary, setSubmittedSummary] = useState<string | null>(null);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [reducedMotionEnabled, setReducedMotionEnabled] = useState(false);
  const [diagnosticsExpanded, setDiagnosticsExpanded] = useState(false);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [diagnosticsState, setDiagnosticsState] = useState<'idle' | 'ready' | 'error'>('idle');

  useEffect(() => {
    const timeout = setTimeout(() => {
      setSearchQuery(searchDraft.trim().toLowerCase());
    }, 320);

    return () => clearTimeout(timeout);
  }, [searchDraft]);

  useEffect(() => {
    if (toastMessage === null) return undefined;

    const timeout = setTimeout(() => {
      setToastMessage(null);
    }, 2200);

    return () => clearTimeout(timeout);
  }, [toastMessage]);

  const catalogProducts = LAB_PRODUCTS.filter((product) => {
    const matchesCategory = activeCategory === 'All' || product.category === activeCategory;
    const matchesQuery =
      searchQuery.length === 0 ||
      product.name.toLowerCase().includes(searchQuery) ||
      product.subtitle.toLowerCase().includes(searchQuery);

    return matchesCategory && matchesQuery;
  });

  const cartCount = Object.values(cartCounts).reduce(
    (sum: number, count: number) => sum + count,
    0,
  );

  function showToast(message: string) {
    setToastMessage(message);
  }

  function getProductDraft(productId: string): ProductDraft {
    return detailDrafts[productId] ?? { note: '', quantity: 1 };
  }

  function toggleFavorite(productId: string) {
    let nextAdded = false;

    setFavoriteIds((current) => {
      if (current.includes(productId)) {
        return current.filter((entry) => entry !== productId);
      }

      nextAdded = true;
      return [...current, productId];
    });

    showToast(nextAdded ? 'Saved favorite' : 'Removed favorite');
  }

  function addToCart(productId: string, quantity = 1) {
    setCartCounts((current) => ({
      ...current,
      [productId]: (current[productId] ?? 0) + quantity,
    }));
    showToast('Cart updated');
  }

  function setProductNote(productId: string, value: string) {
    setDetailDrafts((current) => ({
      ...current,
      [productId]: {
        ...(current[productId] ?? { note: '', quantity: 1 }),
        note: value,
      },
    }));
  }

  function increaseProductQuantity(productId: string) {
    setDetailDrafts((current) => ({
      ...current,
      [productId]: {
        ...(current[productId] ?? { note: '', quantity: 1 }),
        quantity: (current[productId]?.quantity ?? 1) + 1,
      },
    }));
  }

  function decreaseProductQuantity(productId: string) {
    setDetailDrafts((current) => ({
      ...current,
      [productId]: {
        ...(current[productId] ?? { note: '', quantity: 1 }),
        quantity: Math.max(1, (current[productId]?.quantity ?? 1) - 1),
      },
    }));
  }

  function saveProductToCart(productId: string) {
    addToCart(productId, getProductDraft(productId).quantity);
  }

  function resetLabState() {
    setDetailDrafts({});
    setSearchDraft('');
    setSearchQuery('');
    setActiveCategory('All');
    setFavoriteIds([]);
    setCartCounts({});
    setNoticeVisible(true);
    setIsOnline(true);
    setIsRefreshing(false);
    setLastSyncLabel('Never');
    setForm(initialFormState);
    setFormErrors([]);
    setSubmittedSummary(null);
    setNotificationsEnabled(true);
    setReducedMotionEnabled(false);
    setDiagnosticsExpanded(false);
    setDiagnosticsLoading(false);
    setDiagnosticsState('idle');
    showToast('Agent Device Tester reset');
  }

  function refreshMetrics() {
    setIsRefreshing(true);

    setTimeout(() => {
      setIsRefreshing(false);
      setLastSyncLabel('Synced just now');
      showToast('Metrics refreshed');
    }, 1200);
  }

  function loadDiagnostics() {
    setDiagnosticsLoading(true);
    setDiagnosticsState('idle');

    setTimeout(() => {
      setDiagnosticsLoading(false);
      setDiagnosticsState('error');
      showToast('Diagnostics failed');
    }, 1100);
  }

  function retryDiagnostics() {
    setDiagnosticsLoading(true);

    setTimeout(() => {
      setDiagnosticsLoading(false);
      setDiagnosticsState('ready');
      showToast('Diagnostics recovered');
    }, 900);
  }

  function updateForm<K extends keyof CheckoutFormState>(field: K, value: CheckoutFormState[K]) {
    setForm((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function resetForm() {
    setForm(initialFormState);
    setFormErrors([]);
    setSubmittedSummary(null);
    showToast('Form cleared');
  }

  function submitOrder() {
    const nextErrors: string[] = [];

    if (form.name.trim().length === 0) nextErrors.push('Full name is required.');
    if (!form.email.includes('@')) nextErrors.push('A valid email is required.');
    if (!form.agree) nextErrors.push('Order confirmation must be checked.');

    setFormErrors(nextErrors);

    if (nextErrors.length > 0) {
      setSubmittedSummary(null);
      showToast('Form needs attention');
      return;
    }

    setSubmittedSummary(
      `${form.name} chose ${form.shipping.toLowerCase()} with ${form.payment.toLowerCase()} payment.`,
    );
    showToast('Order submitted');
  }

  return (
    <LabStateContext.Provider
      value={{
        activeCategory,
        addToCart,
        cartCount,
        cartCounts,
        catalogProducts,
        decreaseProductQuantity,
        detailDrafts,
        diagnosticsExpanded,
        diagnosticsLoading,
        diagnosticsState,
        dismissNotice: () => setNoticeVisible(false),
        favoriteIds,
        form,
        formErrors,
        increaseProductQuantity,
        isOnline,
        isRefreshing,
        lastSyncLabel,
        loadDiagnostics,
        noticeVisible,
        notificationsEnabled,
        reducedMotionEnabled,
        refreshMetrics,
        resetForm,
        resetLabState,
        retryDiagnostics,
        saveProductToCart,
        searchDraft,
        setActiveCategory,
        setDiagnosticsExpanded,
        setIsOnline,
        setNotificationsEnabled,
        setProductNote,
        setReducedMotionEnabled,
        setSearchDraft,
        submitOrder,
        submittedSummary,
        toastMessage,
        toggleFavorite,
        updateForm,
      }}
    >
      {props.children}
    </LabStateContext.Provider>
  );
}

export function useLabState(): LabStateContextValue {
  const value = useContext(LabStateContext);

  if (value === null) {
    throw new Error('useLabState must be used within LabStateProvider.');
  }

  return value;
}
