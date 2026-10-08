# Changelog fragments

One small file per change. At release time the files are folded into `CHANGELOG.md` and deleted.

## Why

If every pull request edited the top of `CHANGELOG.md`, any two open pull requests would conflict on those lines even
when they touch no other file in common. With one file per change, two pull requests never collide.

## Adding a fragment

Create `changelog.d/<short-slug>.<category>.md`:

- `<short-slug>` names the change, not the pull request number: lowercase letters, digits and single hyphens
  (`timezone-day-boundary`, not `pr-42`).
- `<category>` is one of `added`, `changed`, `deprecated`, `removed`, `fixed`, `security`. Until the first release
  (`CHANGELOG.md` lists no version yet) every fragment is `added`: nothing released can be fixed or changed
  (`scripts/test/repo-docs.test.mjs` checks it).

The content is exactly one Markdown bullet, written the way it should read in the changelog:

```markdown
- **A short bold sentence that says what changed.** Then the detail: what it was before, what it is now, and what a
  reader has to do differently, if anything. Continuation lines are indented two spaces.
```

Rules (checked by `node scripts/assemble-changelog.mjs --check`, which CI runs):

- The file starts with `- ` and holds one top-level bullet. Two changes mean two files.
- No headings or horizontal rules; the release adds the headings. A `#` line inside a fenced code block is fine.
- Continuation lines are indented by two spaces. Code fences must be closed.
- Plain text only: no control characters, zero-width characters or bidirectional overrides.
- Never put real prompts, paths, project names or log excerpts in a fragment. The changelog is public.

## How a release uses them

`CHANGELOG.md` lists released versions only (`## X.Y.Z - YYYY-MM-DD`). Unreleased changes are the files in this
directory, so there is deliberately no "Unreleased" section to conflict on.

```sh
node scripts/assemble-changelog.mjs --release 0.1.0 --dry-run   # preview the new section, change nothing
node scripts/assemble-changelog.mjs --release 0.1.0             # write it into CHANGELOG.md, delete the fragments
node scripts/assemble-changelog.mjs --verify-release 0.1.0      # gate used by the release workflow
node scripts/assemble-changelog.mjs --print-release 0.1.0       # the release notes text
```

`--release` creates `CHANGELOG.md` if it does not exist yet, refuses to reuse a version, and deletes nothing if any
fragment is invalid. Commit the updated `CHANGELOG.md` and the deletions together with the version bump.
