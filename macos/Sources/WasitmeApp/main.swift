import Foundation
import WasitmeUI

// Entry point. Top-level code in main.swift is implicitly @MainActor in Swift 6.
let options = LaunchOptions.parse(CommandLine.arguments)

// Headless diagnostic: never reaches AppKit, so no window or status item can appear.
if options.selfCheck { SelfCheck.run(options) }

// `--capture DIR` renders offscreen and exits inside AppMain before any status item exists.
AppMain.run(options)
