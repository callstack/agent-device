#import <TargetConditionals.h>

#if TARGET_OS_IOS && defined(AGENT_DEVICE_RUNNER_UNIT_TESTS)
#import <UIKit/UIKit.h>

@interface AgentDeviceMaskedTextField : UITextField
@end

@interface AgentDeviceValueReadCountingTextField : AgentDeviceMaskedTextField
@end

@interface AgentDeviceSecureEntryField : UITextField <UIGestureRecognizerDelegate>
// Shows how many deletes and taps the field received.
@property(nonatomic, weak) UILabel *countLabel;
// Refuses the first focus, as a field whose first tap the app consumes does.
@property(nonatomic, assign) BOOL refusesFirstFocus;
// Reports the placeholder as the value while empty, as a React Native secure input does.
@property(nonatomic, assign) BOOL reportsPlaceholderAsValue;
@end

@interface AgentDeviceValueReadCountLabel : UILabel
@property(nonatomic, weak) UITextField *countedField;
@end

@interface AgentDeviceTextEntryWitnessField : UITextField <UITextFieldDelegate, UIGestureRecognizerDelegate>
@end
#endif
