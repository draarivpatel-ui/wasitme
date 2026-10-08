/** A command failed after its arguments were fine; `main` prints the message and exits with `code`. (A light module: the
 * CLI entry point checks for it without loading any command.) */
export class CommandFailure extends Error {
  constructor(message: string, readonly code = 1) {
    super(message);
  }
}
