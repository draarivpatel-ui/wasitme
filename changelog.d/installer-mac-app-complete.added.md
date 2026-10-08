- **The installer builds the whole Mac app.** It builds the app package's `WasitmeApp` executable and assembles a bundle
  with what `macos/scripts/build-app.sh` ships: the Control Center page, the bundled IBM Plex fonts and their licence,
  the app icon and the current SDK stamp (for the macOS 26 look). A source without a built Control Center page gets one
  built in a scratch copy when TypeScript is there; otherwise the app step stops with the fix instead of installing an
  app that only shows a placeholder.
