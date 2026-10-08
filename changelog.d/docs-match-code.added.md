- **The public documents say what the code does.** A fresh-eyes pass checked every command, path, number and rule in the
  README, METHOD, PRIVACY, FORMATS, CONTRACT, SECURITY and CONTRIBUTING against the engine, the installer and the
  calibration artifact. Corrected: a log-format change counts the unknown records and shows them on the Sources page
  (this version raises only the `parser_changed` pause); the hook's sandbox also grants write access to `~/.wasitme`;
  the session-end hook is not asynchronous; a model id may end in `@default`; the store also holds `history/index.json`
  and `history/priors/`; the installer sets only `glancePath` and leaves `showBand` alone; `staleAfterSec` is required;
  the largest example glance is about 7 KB; and the menu item is "Quit wasitme".
