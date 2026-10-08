## What and why

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] Tests added or updated, and `npm test` passes
- [ ] `node scripts/check-no-network.mjs` passes (no network, no new dependency, no new process spawning)
- [ ] Test data is 100% synthetic. Nothing was copied, sliced or "anonymised" from real session logs
- [ ] Nothing stores or prints prompt/response text, tool input/output, file paths, project names, git branches or secrets
- [ ] Timestamps are never assumed to be in order and no duration can be negative
- [ ] Changelog fragment added in `changelog.d/` (or this change needs none: say why)
- [ ] Docs and comments I touched say what the code does (links and anchors resolve: `node --test scripts/test/doc-links.test.mjs`)
- [ ] I did not edit `engine/src/types.ts` (the shared contract). If it has to change, I opened an issue first

## Notes for the reviewer

<!-- Anything surprising, trade-offs, or things you could not test. -->
