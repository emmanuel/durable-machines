# API Consistency: Future Work

Deferred improvements identified during the API consistency audit (March 2026).

## Shared admin server package

`gateway/src/admin.ts` and `worker/src/admin.ts` are byte-identical (~42 lines).
Extract to an internal shared package if maintenance burden grows or they need
to diverge. Currently cross-referenced with comments.

## Barrel export snapshot tests

`import * from pkg` + `expect(Object.keys(API)).toMatchSnapshot()` to catch
accidental export additions/removals. Valuable for public API stability.
