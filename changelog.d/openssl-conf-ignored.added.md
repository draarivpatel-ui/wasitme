- **A project cannot hand Node an OpenSSL configuration inside the plugin's hooks and report skill.** Node's OpenSSL
  reads its configuration file from the `OPENSSL_CONF` environment variable before any JavaScript runs and outside the
  permission sandbox; a configuration can name a provider module to load as native code, or simply stop Node. A project
  can set environment variables for its Claude Code sessions, so both scripts now drop `OPENSSL_CONF`,
  `OPENSSL_MODULES` and `OPENSSL_ENGINES`, as they already drop `NODE_OPTIONS` and the other variables Node reads at
  startup.
