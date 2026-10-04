# The Telly AR medicine pin (local Expo module). Same shape as the expo-modules-core podspecs.
Pod::Spec.new do |s|
  s.name           = 'TellyAr'
  s.version        = '1.0.0'
  s.summary        = 'Pins a medicine container to its real spot with ARKit.'
  s.description    = s.summary
  s.license        = 'UNLICENSED'
  s.author         = 'Telly'
  s.homepage       = 'https://github.com/ayaangazali/telly'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/ayaangazali/telly.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'ARKit', 'SceneKit', 'AVFoundation'

  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
