## What changed

<!-- What this does and why. The diff already shows how. -->

## Related issue

<!-- "Closes #12". For anything beyond a bug fix, please open an issue first. -->

## Checklist

- [ ] Still read-only. Nothing logs in, posts, bids, messages, adds to a cart, or buys.
- [ ] No new polling, prefetching, or parallel fan-out. Request rates stay low.
- [ ] No capture artefact committed. `captures/`, `shots/` and `work/` are untouched.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes. Paste the two summary lines below.
- [ ] Parsing changes stay in `client.ts`; MCP surface changes stay in `server.ts`.
- [ ] If a field was added or renamed, the README tool tables are updated.
- [ ] If something surprising about the site was learned, it is written up in README "Field notes".

## Test output

```
<!-- e.g. RESULT: 42 passed, 0 failed / MCP SMOKE: 14 passed, 0 failed -->
```
