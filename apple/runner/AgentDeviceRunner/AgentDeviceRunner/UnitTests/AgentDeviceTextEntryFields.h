#import <TargetConditionals.h>

#if TARGET_OS_IOS && defined(AGENT_DEVICE_RUNNER_UNIT_TESTS)
#import <UIKit/UIKit.h>

@interface AgentDeviceMaskedTextField : UITextField
@end

@interface AgentDeviceValueReadCountingTextField : AgentDeviceMaskedTextField
@end

@interface AgentDeviceValueReadCountLabel : UILabel
@property(nonatomic, weak) UITextField *countedField;
@end

@interface AgentDeviceTextEntryWitnessField : UITextField <UITextFieldDelegate>
@end
#endif
