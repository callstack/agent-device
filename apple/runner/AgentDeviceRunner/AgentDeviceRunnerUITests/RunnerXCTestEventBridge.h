#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

// Shared reflection surface for XCTest's private event-synthesis API
// (XCSynthesizedEventRecord / XCPointerEventPath). Both gesture synthesis
// (RunnerSynthesizedGesture) and text-entry synthesis (RunnerSynthesizedTextEntry)
// reflect into this same private API; resolving the part they have in common here
// means a selector rename only has to be found in one place.
//
// Each caller additionally resolves whichever XCSynthesizedEventRecord init
// overload and XCPointerEventPath factory/mutator selectors its own event kind
// needs: gesture uses the 2-arg `initWithName:interfaceOrientation:` plus
// touch-path selectors (`initForTouchAtPoint:offset:`, `moveToPoint:atOffset:`,
// `liftUpAtOffset:`); text entry uses the 1-arg `initWithName:` plus text-input
// selectors (`initForTextInput`, `typeText:atOffset:typingSpeed:shouldRedact:`,
// `typeKey:modifiers:atOffset:`). Those genuinely differ and are resolved by
// each caller on top of this shared core, not forced into one shape here.
typedef struct {
  Class recordClass;  // XCSynthesizedEventRecord
  Class pathClass;  // XCPointerEventPath
  SEL addPathSelector;  // addPointerEventPath: (on recordClass)
  SEL setTargetProcessIDSelector;  // setTargetProcessID: (on recordClass)
  SEL synthesizeSelector;  // synthesizeWithError: (on recordClass)
  SEL processIDSelector;  // processID, read on the XCUIApplication
} RunnerXCTestEventBridge;

typedef NSInteger (*RunnerMsgSendInteger)(id, SEL);
typedef void (*RunnerMsgSendSetInteger)(id, SEL, NSInteger);
typedef void (*RunnerMsgSendAddPath)(id, SEL, id);
typedef BOOL (*RunnerMsgSendSynthesize)(id, SEL, NSError **);

// Resolves the shared core described above against the live XCTest runtime.
// Returns nil and populates `bridge` on success. Returns a non-nil
// "private XCTest <surface> synthesis unavailable: ..." message and leaves
// `bridge` unspecified when a class or selector the private API is expected to
// expose is missing (the API changed, or is unavailable on this OS/Xcode).
// `surface` names the calling feature ("event" or "text") so the message text
// matches what that caller has always reported.
FOUNDATION_EXPORT NSString * _Nullable RunnerResolveXCTestEventBridge(
  id application,
  NSString *surface,
  RunnerXCTestEventBridge *bridge
);

FOUNDATION_EXPORT NSString * _Nullable RunnerRequireClass(
  Class cls,
  NSString *className,
  NSString *surface
);
FOUNDATION_EXPORT NSString * _Nullable RunnerRequireSelector(
  Class cls,
  SEL selector,
  NSString *selectorName,
  NSString *surface
);
FOUNDATION_EXPORT NSString * _Nullable RunnerRequireApplicationSelector(
  id application,
  SEL selector,
  NSString *selectorName,
  NSString *surface
);

// Formats an NSException the way every synthesis @catch block reports failure:
// "<name>: <reason>", falling back to "NSException" / `fallbackReason` when
// either is nil.
FOUNDATION_EXPORT NSString *RunnerFormatXCTestException(
  NSException *exception,
  NSString *fallbackReason
);

NS_ASSUME_NONNULL_END
