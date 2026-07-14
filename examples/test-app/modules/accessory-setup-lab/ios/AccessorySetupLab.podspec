Pod::Spec.new do |s|
  s.name           = 'AccessorySetupLab'
  s.version        = '1.0.0'
  s.summary        = 'Physical-device AccessorySetupKit fixture for Agent Device Tester'
  s.description    = s.summary
  s.license        = { :type => 'MIT' }
  s.author         = { 'Callstack' => 'opensource@callstack.com' }
  s.homepage       = 'https://github.com/callstack/agent-device'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => 'https://github.com/callstack/agent-device.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AccessorySetupKit', 'CoreBluetooth', 'UIKit'
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
