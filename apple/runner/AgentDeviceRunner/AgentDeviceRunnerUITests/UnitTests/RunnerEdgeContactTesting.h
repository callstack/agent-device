#import <Foundation/Foundation.h>
#import <TargetConditionals.h>

NS_ASSUME_NONNULL_BEGIN

#if TARGET_OS_IOS && TARGET_OS_SIMULATOR

/// Runs `RunnerDispatchEdgeContact` on a 48 ms path whose HID event constructors fail from the
/// `failingFrame`th hand event on: 0 is the reserved cancel, 1 touch-down, 2 to 4 the moves, 5 the
/// touch-up, and -1 never. Returns each dispatched event in order as `mask`, `touching`, and
/// `restamped` (whether its timestamp was set after it was built).
FOUNDATION_EXPORT NSArray<NSDictionary<NSString *, NSNumber *> *> *RunnerEdgeContactDispatches(
  NSInteger failingFrame,
  NSString * _Nullable * _Nullable failure
);

/// Runs the touchscreen sender selection over fake HID services. Each service is a dictionary of
/// its properties (`PrimaryUsagePage`, `PrimaryUsage`, `Transport`, `displayUUID`) plus
/// `registryID`; an absent key is a missing property. Returns the failure, or nil with `sender` set.
FOUNDATION_EXPORT NSString * _Nullable RunnerTouchscreenSelection(
  NSArray<NSDictionary<NSString *, id> *> *services,
  NSString * _Nullable displayUUID,
  uint64_t *sender
);

#endif

NS_ASSUME_NONNULL_END
