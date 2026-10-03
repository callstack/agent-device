Pod::Spec.new do |s|
  s.name           = 'ApplePayLab'
  s.version        = '1.0.0'
  s.summary        = 'Apple Pay sheet fixture for Agent Device Tester'
  s.description    = s.summary
  s.license        = { :type => 'MIT' }
  s.author         = { 'Callstack' => 'opensource@callstack.com' }
  s.homepage       = 'https://github.com/callstack/agent-device'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => 'https://github.com/callstack/agent-device.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'PassKit', 'UIKit'
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
