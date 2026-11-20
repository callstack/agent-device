import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type ComponentType,
  type RefObject,
} from 'react';
import {
  Animated,
  Image,
  Platform,
  Pressable,
  Text,
  View,
  type GestureResponderEvent,
} from 'react-native';
import {
  Directions,
  FlingGestureHandler,
  Gesture,
  GestureDetector,
  PanGestureHandler,
  PinchGestureHandler,
  RotationGestureHandler,
  State,
  type FlingGestureHandlerStateChangeEvent,
  type PanGestureHandlerGestureEvent,
  type PanGestureHandlerStateChangeEvent,
  type PinchGestureHandlerGestureEvent,
  type PinchGestureHandlerStateChangeEvent,
  type RotationGestureHandlerGestureEvent,
  type RotationGestureHandlerStateChangeEvent,
  type ScrollView,
} from 'react-native-gesture-handler';

import { SymbolView } from 'expo-symbols';

// NASA photograph AS17-148-22727 (public domain), bundled so the lab needs no network.
import gestureImage from '../../assets/gesture-earth.jpg';
import { SectionCard } from '../components';
import { useAppColors } from '../theme';
import { createGestureLabStyles } from './gesture-lab-styles';
import { disableDevelopmentGestureInterceptors } from './gesture-lab-dev-menu';

type TransformState = {
  offsetX: number;
  offsetY: number;
  rotation: number;
  scale: number;
};

type GestureCounts = {
  fling: number;
  twoPointerPan: number;
};

/** A multi-tap round ends when the last contact lifts; it reports the most contacts held at once. */
type MultiTapState = {
  rounds: number;
  lastRoundContacts: number;
};

const panDurationBucketMs = 400;

/**
 * The reorder handle arms only after this hold: a touch that moves first scrolls the page.
 */
const reorderHoldArmMs = 600;
const reorderRowHeightPx = 48;
const initialReorderOrder = ['Alpha', 'Beta', 'Gamma'];

type AndroidTouchStart = TransformState & {
  angle: number;
  centroidX: number;
  centroidY: number;
  span: number;
};

const initialTransform: TransformState = {
  offsetX: 0,
  offsetY: 0,
  rotation: 0,
  scale: 1,
};

const initialCounts: GestureCounts = {
  fling: 0,
  twoPointerPan: 0,
};
const initialMultiTap: MultiTapState = { rounds: 0, lastRoundContacts: 0 };
const minScale = 0.5;
const maxScale = 2;

type PageScrollRef = RefObject<ComponentRef<typeof ScrollView> | null>;

export function GestureLab(props: { pageScrollRef: PageScrollRef }) {
  const colors = useAppColors();
  const styles = createGestureLabStyles(colors);
  const [canaryReady, setCanaryReady] = useState(false);
  const [transform, setTransform] = useState<TransformState>(initialTransform);
  const [counts, setCounts] = useState<GestureCounts>(initialCounts);
  const [dragCompleted, setDragCompleted] = useState(false);
  const [reorderOrder, setReorderOrder] = useState<string[]>(initialReorderOrder);
  const [reorderHoldActivated, setReorderHoldActivated] = useState(false);
  const [reorderLastDy, setReorderLastDy] = useState(0);
  const [reorderDrag, setReorderDrag] = useState<{ label: string; dy: number } | null>(null);
  const reorderPreview = reorderDrag
    ? movedBy(reorderOrder, reorderDrag.label, Math.round(reorderDrag.dy / reorderRowHeightPx))
    : reorderOrder;
  const [panDurationStatus, setPanDurationStatus] = useState('pending');
  const [multiTap, setMultiTap] = useState<MultiTapState>(initialMultiTap);
  const multiTapRoundContactsRef = useRef(0);
  const multiTapActiveTouchesRef = useRef(new Set<number>());
  const transformRef = useRef<TransformState>(initialTransform);
  const gestureStartRef = useRef<TransformState>(initialTransform);
  const panDurationStartRef = useRef<number | undefined>(undefined);
  const androidTouchStartRef = useRef<AndroidTouchStart | undefined>(undefined);
  const legacyFlingDownRef = useRef(null);
  const legacyFlingLeftRef = useRef(null);
  const legacyFlingRightRef = useRef(null);
  const legacyFlingUpRef = useRef(null);
  const legacyPanRef = useRef(null);
  const legacyPinchRef = useRef(null);
  const legacyRotationRef = useRef(null);
  const activeTransformHandlerTagsRef = useRef(new Set<number>());

  useEffect(() => {
    void disableDevelopmentGestureInterceptors()
      .catch(() => undefined)
      .finally(() => setCanaryReady(true));
  }, []);

  function updateTransform(nextTransform: TransformState) {
    transformRef.current = nextTransform;
    setTransform(nextTransform);
  }

  function beginTransformGesture(handlerTag: number) {
    const activeHandlerTags = activeTransformHandlerTagsRef.current;
    if (activeHandlerTags.size === 0) {
      gestureStartRef.current = transformRef.current;
    }
    activeHandlerTags.add(handlerTag);
  }

  function endTransformGesture(handlerTag: number) {
    activeTransformHandlerTagsRef.current.delete(handlerTag);
  }

  function handlePan(translationX: number, translationY: number) {
    const start = gestureStartRef.current;
    updateTransform({
      ...transformRef.current,
      offsetX: clamp(start.offsetX + translationX, -72, 72),
      offsetY: clamp(start.offsetY + translationY, -56, 56),
    });
  }

  function handlePinch(scale: number) {
    const start = gestureStartRef.current;
    updateTransform({
      ...transformRef.current,
      scale: clamp(start.scale * scale, minScale, maxScale),
    });
  }

  function handleRotation(rotation: number) {
    const start = gestureStartRef.current;
    updateTransform({
      ...transformRef.current,
      rotation: start.rotation + rotation,
    });
  }

  function handleFling() {
    setCounts((current) => ({ ...current, fling: current.fling + 1 }));
  }

  function handleTwoPointerPan() {
    setCounts((current) => ({
      ...current,
      twoPointerPan: current.twoPointerPan + 1,
    }));
  }

  function handleLegacyTransformStateChange(
    event:
      | PanGestureHandlerStateChangeEvent
      | PinchGestureHandlerStateChangeEvent
      | RotationGestureHandlerStateChangeEvent,
  ) {
    if (event.nativeEvent.state === State.BEGAN) {
      beginTransformGesture(event.nativeEvent.handlerTag);
    } else if (
      event.nativeEvent.state === State.END ||
      event.nativeEvent.state === State.FAILED ||
      event.nativeEvent.state === State.CANCELLED
    ) {
      endTransformGesture(event.nativeEvent.handlerTag);
    }
  }

  function handleLegacyFling(event: FlingGestureHandlerStateChangeEvent) {
    if (event.nativeEvent.state === State.ACTIVE) handleFling();
  }

  function handleAndroidTouchStart(event: GestureResponderEvent) {
    const [first, second] = event.nativeEvent.touches;
    if (!first || !second) return;
    androidTouchStartRef.current = {
      ...transformRef.current,
      angle: Math.atan2(second.pageY - first.pageY, second.pageX - first.pageX),
      centroidX: (first.pageX + second.pageX) / 2,
      centroidY: (first.pageY + second.pageY) / 2,
      span: Math.hypot(second.pageX - first.pageX, second.pageY - first.pageY),
    };
  }

  function handleAndroidTouchMove(event: GestureResponderEvent) {
    const start = androidTouchStartRef.current;
    const [first, second] = event.nativeEvent.touches;
    if (!start || !first || !second) return;
    const centroidX = (first.pageX + second.pageX) / 2;
    const centroidY = (first.pageY + second.pageY) / 2;
    const span = Math.hypot(second.pageX - first.pageX, second.pageY - first.pageY);
    const angle = Math.atan2(second.pageY - first.pageY, second.pageX - first.pageX);
    updateTransform({
      offsetX: clamp(start.offsetX + centroidX - start.centroidX, -72, 72),
      offsetY: clamp(start.offsetY + centroidY - start.centroidY, -56, 56),
      rotation: start.rotation + normalizedRadians(angle - start.angle),
      scale: clamp(start.scale * (span / start.span), minScale, maxScale),
    });
  }

  const twoPointerPanGesture = Gesture.Pan()
    .averageTouches(true)
    .minPointers(2)
    .maxPointers(2)
    .minDistance(4)
    .runOnJS(true)
    .onStart(handleTwoPointerPan);
  // A manual gesture sees every native touch without competing with the transform recognizers.
  // Touches are tracked by id because a lifting touch may still be listed in the up event.
  const multiTapGesture = Gesture.Manual()
    .runOnJS(true)
    .onTouchesDown((event) => {
      const active = multiTapActiveTouchesRef.current;
      // A first contact starts a new round, so a lift this handler never saw cannot wedge it.
      if (event.allTouches.length === event.changedTouches.length) {
        active.clear();
        multiTapRoundContactsRef.current = 0;
      }
      for (const touch of event.changedTouches) active.add(touch.id);
      multiTapRoundContactsRef.current = Math.max(multiTapRoundContactsRef.current, active.size);
    })
    .onTouchesUp((event) => {
      const active = multiTapActiveTouchesRef.current;
      for (const touch of event.changedTouches) active.delete(touch.id);
      if (active.size > 0) return;
      const contacts = multiTapRoundContactsRef.current;
      multiTapRoundContactsRef.current = 0;
      setMultiTap((current) => ({ rounds: current.rounds + 1, lastRoundContacts: contacts }));
    })
    .onTouchesCancelled(() => {
      multiTapActiveTouchesRef.current.clear();
      multiTapRoundContactsRef.current = 0;
    });
  const holdDragGesture = Gesture.Pan()
    .activateAfterLongPress(500)
    .minDistance(10)
    .runOnJS(true)
    .onEnd((event, completed) => {
      if (completed && Math.hypot(event.translationX, event.translationY) > 60) {
        setDragCompleted(true);
      }
    });
  const legacyFlingRefs = [
    legacyFlingLeftRef,
    legacyFlingRightRef,
    legacyFlingUpRef,
    legacyFlingDownRef,
  ];
  const panDurationGesture = Gesture.Pan()
    .minPointers(1)
    .maxPointers(1)
    .runOnJS(true)
    .simultaneousWithExternalGesture(
      twoPointerPanGesture,
      legacyPanRef,
      legacyPinchRef,
      legacyRotationRef,
      ...legacyFlingRefs,
    )
    .onBegin(() => {
      panDurationStartRef.current = Date.now();
    })
    // `onEnd` only fires after the recognizer reached ACTIVE. `onFinalize` would also run for a
    // failed or cancelled pan, allowing a long-lived non-gesture to satisfy the duration canary.
    .onEnd(() => {
      const start = panDurationStartRef.current;
      panDurationStartRef.current = undefined;
      if (start === undefined) return;
      const durationMs = Date.now() - start;
      const bucket =
        durationMs >= panDurationBucketMs
          ? `>=${panDurationBucketMs}ms`
          : `<${panDurationBucketMs}ms`;
      setPanDurationStatus(bucket);
    });

  const androidTransformTarget = (
    <FlingGestureHandler
      direction={Directions.LEFT}
      onHandlerStateChange={handleLegacyFling}
      ref={legacyFlingLeftRef}
      simultaneousHandlers={[legacyPanRef, legacyPinchRef, legacyRotationRef]}
    >
      <FlingGestureHandler
        direction={Directions.RIGHT}
        onHandlerStateChange={handleLegacyFling}
        ref={legacyFlingRightRef}
        simultaneousHandlers={[legacyPanRef, legacyPinchRef, legacyRotationRef]}
      >
        <FlingGestureHandler
          direction={Directions.UP}
          onHandlerStateChange={handleLegacyFling}
          ref={legacyFlingUpRef}
          simultaneousHandlers={[legacyPanRef, legacyPinchRef, legacyRotationRef]}
        >
          <FlingGestureHandler
            direction={Directions.DOWN}
            onHandlerStateChange={handleLegacyFling}
            ref={legacyFlingDownRef}
            simultaneousHandlers={[legacyPanRef, legacyPinchRef, legacyRotationRef]}
          >
            <RotationGestureHandler
              onGestureEvent={(event: RotationGestureHandlerGestureEvent) =>
                handleRotation(event.nativeEvent.rotation)
              }
              onHandlerStateChange={handleLegacyTransformStateChange}
              ref={legacyRotationRef}
              simultaneousHandlers={[legacyPanRef, legacyPinchRef, ...legacyFlingRefs]}
            >
              <PinchGestureHandler
                onGestureEvent={(event: PinchGestureHandlerGestureEvent) =>
                  handlePinch(event.nativeEvent.scale)
                }
                onHandlerStateChange={handleLegacyTransformStateChange}
                ref={legacyPinchRef}
                simultaneousHandlers={[legacyPanRef, legacyRotationRef, ...legacyFlingRefs]}
              >
                <PanGestureHandler
                  avgTouches
                  maxPointers={2}
                  minDist={4}
                  minPointers={2}
                  onGestureEvent={(event: PanGestureHandlerGestureEvent) =>
                    handlePan(event.nativeEvent.translationX, event.nativeEvent.translationY)
                  }
                  onHandlerStateChange={handleLegacyTransformStateChange}
                  ref={legacyPanRef}
                  simultaneousHandlers={[legacyPinchRef, legacyRotationRef, ...legacyFlingRefs]}
                >
                  <View
                    accessibilityLabel="Transform gesture target"
                    style={styles.androidTransformTarget}
                    testID="transform-gesture-target"
                  />
                </PanGestureHandler>
              </PinchGestureHandler>
            </RotationGestureHandler>
          </FlingGestureHandler>
        </FlingGestureHandler>
      </FlingGestureHandler>
    </FlingGestureHandler>
  );

  const rotationDegrees = Math.round((transform.rotation * 180) / Math.PI);
  const statusLabel = `x ${Math.round(transform.offsetX)}, y ${Math.round(
    transform.offsetY,
  )}, scale ${transform.scale.toFixed(2)}, rotate ${rotationDegrees}`;
  const panChanged = Math.abs(transform.offsetX) > 1 || Math.abs(transform.offsetY) > 1;
  const pinchChanged = Math.abs(transform.scale - 1) > 0.01;
  const rotateChanged = rotationDegrees !== 0;
  const changeStatusLabel = `pan changed ${panChanged ? 'yes' : 'no'}, pinch changed ${
    pinchChanged ? 'yes' : 'no'
  }, rotate changed ${rotateChanged ? 'yes' : 'no'}`;

  const targetView = (
    <View
      accessibilityLabel="Gesture test image"
      onTouchEnd={
        Platform.OS === 'android' ? () => (androidTouchStartRef.current = undefined) : undefined
      }
      onTouchMove={Platform.OS === 'android' ? handleAndroidTouchMove : undefined}
      onTouchStart={Platform.OS === 'android' ? handleAndroidTouchStart : undefined}
      style={styles.target}
      testID="gesture-target"
    >
      <Image
        accessibilityIgnoresInvertColors
        accessibilityLabel="Gesture test image"
        resizeMode="cover"
        source={gestureImage}
        style={[
          styles.image,
          {
            transform: [
              { translateX: transform.offsetX },
              { translateY: transform.offsetY },
              { scale: transform.scale },
              { rotate: `${rotationDegrees}deg` },
            ],
          },
        ]}
        testID="gesture-target-image"
      />
      {androidTransformTarget}
      <GestureDetector gesture={twoPointerPanGesture}>
        <View
          accessibilityLabel="Exact two-pointer pan target"
          style={styles.twoPointerTarget}
          testID="two-pointer-pan-target"
        />
      </GestureDetector>
    </View>
  );

  return (
    <SectionCard
      subtitle={`Image target for pan, pinch, rotate, and fling. ${changeStatusLabel}`}
      testID="gesture-lab-card"
      title="Gesture lab"
    >
      <View style={styles.dragRow} testID="drag-gesture-fixture">
        <GestureDetector gesture={holdDragGesture}>
          <Pressable
            accessibilityLabel="Drag source"
            accessibilityRole="button"
            onPress={() => undefined}
            style={styles.dragEndpoint}
            testID="drag-source"
          >
            <SymbolView
              name={{ ios: 'hand.draw', android: 'drag_pan', web: 'drag_pan' }}
              size={18}
              tintColor={colors.text}
            />
            <Text style={styles.dragEndpointLabel}>Source</Text>
          </Pressable>
        </GestureDetector>
        <Pressable
          accessibilityLabel="Drag destination"
          accessibilityRole="button"
          onPress={() => undefined}
          style={styles.dragEndpoint}
          testID="drag-destination"
        >
          <SymbolView
            name={{ ios: 'scope', android: 'target', web: 'target' }}
            size={18}
            tintColor={colors.text}
          />
          <Text style={styles.dragEndpointLabel}>Destination</Text>
        </Pressable>
      </View>
      <Text style={styles.metric} testID="drag-gesture-status">
        drag completed {dragCompleted ? 'yes' : 'no'}
      </Text>

      {Platform.OS === 'ios' ? (
        <GestureDetector gesture={panDurationGesture}>{targetView}</GestureDetector>
      ) : (
        targetView
      )}

      <View style={styles.metrics} testID="gesture-metrics">
        <Text style={styles.metric} testID="gesture-canary-ready">
          gesture canary {canaryReady ? 'ready' : 'preparing'}
        </Text>
        <Text style={styles.metric} testID="gesture-transform-status">
          {statusLabel}
        </Text>
        <Text style={styles.metric} testID="gesture-fling-status">
          fling {counts.fling}
        </Text>
        <Text style={styles.metric} testID="gesture-two-pointer-pan-status">
          two-pointer pan activations {counts.twoPointerPan}
        </Text>
        <Text style={styles.metric} testID="gesture-multi-tap-status">
          multi-tap rounds {multiTap.rounds}, last round contacts {multiTap.lastRoundContacts}
        </Text>
        <Text style={styles.metric} testID="gesture-pan-duration-status">
          pan duration {panDurationStatus}
        </Text>
        <Text style={styles.metric} testID="gesture-change-status">
          {changeStatusLabel}
        </Text>
      </View>

      <GestureDetector gesture={multiTapGesture}>
        <View
          accessibilityLabel="Multi-finger tap target"
          accessible
          style={styles.multiTapTarget}
          testID="multi-tap-target"
        >
          <SymbolView
            name={{ ios: 'hand.tap', android: 'touch_app', web: 'touch_app' }}
            size={36}
            tintColor={colors.textSoft}
          />
          <Text style={styles.metric}>Tap here with 2 to 5 fingers</Text>
        </View>
      </GestureDetector>

      <View style={{ height: reorderOrder.length * reorderRowHeightPx }} testID="reorder-list">
        {initialReorderOrder.map((label) => (
          <ReorderRow
            dragDy={reorderDrag?.label === label ? reorderDrag.dy : null}
            index={reorderPreview.indexOf(label)}
            key={label}
            label={label}
            onDrag={(dy) => {
              setReorderLastDy(dy);
              setReorderDrag({ label, dy });
            }}
            onDragEnd={() => setReorderDrag(null)}
            onDrop={(dy) =>
              setReorderOrder((current) =>
                movedBy(current, label, Math.round(dy / reorderRowHeightPx)),
              )
            }
            onHoldActivated={() => {
              setReorderHoldActivated(true);
              setReorderDrag({ label, dy: 0 });
            }}
            pageScrollRef={props.pageScrollRef}
            startIndex={reorderOrder.indexOf(label)}
          />
        ))}
      </View>
      <Text style={styles.metric} testID="reorder-status">
        reorder order {reorderOrder.join(',')}
      </Text>
      <Text style={styles.metric} testID="reorder-hold">
        reorder hold activated {reorderHoldActivated ? 'yes' : 'no'}
      </Text>
      <Text style={styles.metric} testID="reorder-last-dy">
        reorder last dy {Math.round(reorderLastDy)}
      </Text>
    </SectionCard>
  );
}

/**
 * One reorderable row. The handle is a labelled button, so it carries an @ref; it starts
 * dragging only after a hold and then keeps the touch from the page scroll view. While it is
 * dragged the row lifts and follows the touch, and the other rows slide to the order a release
 * would commit. The rows keep their place in the view tree and move by transform only: moving
 * the dragged row's view mid-drag would cancel the touch.
 */
function ReorderRow(props: {
  /** The drag travel while this row is the one being dragged, otherwise null. */
  dragDy: number | null;
  /** Where the row sits in the order a release would commit. */
  index: number;
  label: string;
  pageScrollRef: PageScrollRef;
  /** Where the row sat when the drag started. */
  startIndex: number;
  onDrag: (dy: number) => void;
  /** The touch is over, whether or not it became a drag. */
  onDragEnd: () => void;
  onDrop: (dy: number) => void;
  onHoldActivated: () => void;
}) {
  const colors = useAppColors();
  const styles = createGestureLabStyles(colors);
  const dragging = props.dragDy !== null;
  const offsetY = useRef(new Animated.Value(props.index * reorderRowHeightPx)).current;
  const lift = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (props.dragDy !== null) {
      offsetY.setValue(
        clamp(
          props.startIndex * reorderRowHeightPx + props.dragDy,
          0,
          (initialReorderOrder.length - 1) * reorderRowHeightPx,
        ),
      );
      return;
    }
    Animated.spring(offsetY, {
      bounciness: 4,
      speed: 20,
      toValue: props.index * reorderRowHeightPx,
      useNativeDriver: true,
    }).start();
  }, [offsetY, props.dragDy, props.index, props.startIndex]);

  useEffect(() => {
    Animated.spring(lift, { toValue: dragging ? 1 : 0, useNativeDriver: true }).start();
  }, [dragging, lift]);

  // The drag re-renders this row on every move. The gesture is built once and reads the
  // current callbacks through a ref, so a re-render never reconfigures the native handler.
  const callbacks = useRef(props);
  callbacks.current = props;
  const { pageScrollRef } = props;
  const handleGesture = useMemo(
    () =>
      Gesture.Pan()
        .activateAfterLongPress(reorderHoldArmMs)
        .runOnJS(true)
        // The builder types this ref as a component type; at runtime it takes the scroll view instance.
        .blocksExternalGesture(pageScrollRef as unknown as RefObject<ComponentType | null>)
        .onStart(() => callbacks.current.onHoldActivated())
        .onUpdate((event) => callbacks.current.onDrag(event.translationY))
        .onEnd((event, completed) => {
          if (completed) callbacks.current.onDrop(event.translationY);
        })
        .onFinalize(() => callbacks.current.onDragEnd()),
    [pageScrollRef],
  );

  return (
    <Animated.View
      style={[
        styles.reorderRow,
        dragging && styles.reorderRowDragging,
        {
          transform: [
            { translateY: offsetY },
            { scale: lift.interpolate({ inputRange: [0, 1], outputRange: [1, 1.03] }) },
          ],
        },
      ]}
    >
      {/* The handle leads the row: the dev client's floating Tools button covers the right edge. */}
      <GestureDetector gesture={handleGesture}>
        <View
          accessibilityLabel={`Reorder ${props.label}`}
          accessibilityRole="button"
          accessible
          collapsable={false}
          style={styles.reorderHandle}
          testID={`reorder-handle-${props.label}`}
        >
          <SymbolView
            name={{ ios: 'line.3.horizontal', android: 'drag_handle', web: 'drag_handle' }}
            size={18}
            tintColor={colors.textSoft}
          />
        </View>
      </GestureDetector>
      <Text style={styles.reorderLabel} testID={`reorder-label-${props.label}`}>
        {props.label}
      </Text>
    </Animated.View>
  );
}

/** `order` with `label` moved `steps` places, stopping at either end. */
function movedBy(order: readonly string[], label: string, steps: number): string[] {
  const from = order.indexOf(label);
  const next = order.filter((entry) => entry !== label);
  next.splice(clamp(from + steps, 0, order.length - 1), 0, label);
  return next;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizedRadians(value: number): number {
  if (value > Math.PI) return value - Math.PI * 2;
  if (value < -Math.PI) return value + Math.PI * 2;
  return value;
}
