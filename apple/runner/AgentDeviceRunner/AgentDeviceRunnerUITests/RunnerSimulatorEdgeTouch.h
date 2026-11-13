#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <TargetConditionals.h>

NS_ASSUME_NONNULL_BEGIN

#if TARGET_OS_IOS && TARGET_OS_SIMULATOR

// Dispatches one touch that UIKit marks as a screen-edge touch, so
// UIScreenEdgePanGestureRecognizer and the navigation back gesture can begin.
// XCTest synthesized touches never carry the digitizer edge mask that UIKit reads.
@interface RunnerSimulatorEdgeTouch : NSObject

// Resolves everything the touch needs before its contact: the display that hosts the app
// (`resolvedWindow`'s display, or the sole screen when it is nil, as for XCTest synthesis), the
// IOKit HID entry points, and that display's touchscreen sender. Returns nil with `failure` set
// when any of them is missing; nothing has been sent then.
+ (nullable instancetype)prepareWithApplication:(id)application
                                 resolvedWindow:(id _Nullable)resolvedWindow
                                        failure:(NSString * _Nullable __autoreleasing * _Nonnull)failure
  NS_SWIFT_NAME(prepare(application:resolvedWindow:failure:));

- (instancetype)init NS_UNAVAILABLE;

// Runs one contact. `samples` is the ordered { x, y, offsetMs } path of the contact in portrait
// screen points, and `screenSize` is that screen's portrait size in points. The call returns after
// the contact lifts. Returns nil on success, or the reason the touch could not be dispatched.
// `touchDown` is YES once the contact went down, so a failure with it NO reached nothing.
- (NSString * _Nullable)dispatchSamples:(NSArray<NSDictionary<NSString *, NSNumber *> *> *)samples
                             screenSize:(CGSize)screenSize
                              touchDown:(BOOL *)touchDown
  NS_SWIFT_NAME(dispatch(samples:screenSize:touchDown:));

@end

#endif

NS_ASSUME_NONNULL_END
