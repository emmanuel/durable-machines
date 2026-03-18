# XState Machine-as-Data Samples

Machine-as-data equivalents of real XState v5 examples, using the `@durable-machines/expr` evaluator for guards and actions.

Each example has two files:
- `*.xstate.json` — XState machine config snapshot (closures noted as `__closure:` or `__assign:` strings)
- `*.machine.json` — Equivalent `MachineDefinition` using expr guards/actions

## Converted Examples

| Example | Pattern | Source |
|---------|---------|--------|
| [toggle](toggle.machine.json) | Binary state | [xstate/examples/toggle](https://github.com/statelyai/xstate/tree/main/examples/toggle) |
| [donut-maker](donut-maker.machine.json) | Parallel states | [xstate/examples/persisted-donut-maker](https://github.com/statelyai/xstate/tree/main/examples/persisted-donut-maker) |
| [counter](counter.machine.json) | Arithmetic assign | [xstate/examples/counter](https://github.com/statelyai/xstate/tree/main/examples/counter) |
| [filling-water](filling-water.machine.json) | Loop + guard | [xstate/examples/workflow-filling-water](https://github.com/statelyai/xstate/tree/main/examples/workflow-filling-water) |
| [credit-check](credit-check.machine.json) | Workflow: invoke + always + timeout | [xstate/examples/workflow-credit-check](https://github.com/statelyai/xstate/tree/main/examples/workflow-credit-check) |
| [college-application](college-application.machine.json) | Event accumulation + compound guard | [xstate/examples/workflow-finalize-college-app](https://github.com/statelyai/xstate/tree/main/examples/workflow-finalize-college-app) |
| [applicant-request](applicant-request.machine.json) | Guarded event transitions | [xstate/examples/workflow-applicant-request](https://github.com/statelyai/xstate/tree/main/examples/workflow-applicant-request) |
| [visa-processing](visa-processing.machine.json) | Event-based + timeout | [xstate/examples/workflow-event-based](https://github.com/statelyai/xstate/tree/main/examples/workflow-event-based) |
| [flight-booker](flight-booker.machine.json) | Multi-step form wizard | [xstate/examples/7guis-flight-booker-react](https://github.com/statelyai/xstate/tree/main/examples/7guis-flight-booker-react) |
| [book-lending](book-lending.machine.json) | Compound states + human wait + retry loop | [xstate/examples/workflow-book-lending](https://github.com/statelyai/xstate/tree/main/examples/workflow-book-lending) |
| [room-readings](room-readings.machine.json) | Timed collection + report loop | [xstate/examples/workflow-accumulate-room-readings](https://github.com/statelyai/xstate/tree/main/examples/workflow-accumulate-room-readings) |
| [purchase-order](purchase-order.machine.json) | Deadline timeout + effects | [xstate/examples/workflow-purchase-order-deadline](https://github.com/statelyai/xstate/tree/main/examples/workflow-purchase-order-deadline) |
| [car-auction](car-auction.machine.json) | Timed bid collection + reduce output | [xstate/examples/workflow-car-auction-bids](https://github.com/statelyai/xstate/tree/main/examples/workflow-car-auction-bids) |
| [tic-tac-toe](tic-tac-toe.machine.json) | Array iteration + board game | [xstate/examples/tic-tac-toe-react](https://github.com/statelyai/xstate/tree/main/examples/tic-tac-toe-react) |
| [todomvc](todomvc.machine.json) | List CRUD + filter/map/merge | [xstate/examples/todomvc-react](https://github.com/statelyai/xstate/tree/main/examples/todomvc-react) |
| [trivia-game](trivia-game.machine.json) | Multi-step game + invoke | [xstate/examples/trivia-game-example](https://github.com/statelyai/xstate/tree/main/examples/trivia-game-example) |
| [timer](timer.machine.json) | Countdown via `after` loop | [xstate/examples/timer](https://github.com/statelyai/xstate/tree/main/examples/timer) |
| [stopwatch](stopwatch.machine.json) | Elapsed time via `after` loop | [xstate/examples/stopwatch](https://github.com/statelyai/xstate/tree/main/examples/stopwatch) |
| [check-inbox](check-inbox.machine.json) | Periodic polling via `after` | [xstate/examples/workflow-check-inbox](https://github.com/statelyai/xstate/tree/main/examples/workflow-check-inbox) |

## Expr Features Demonstrated

| Feature | Examples |
|---------|----------|
| `select` path navigation | All with context |
| `eq`, `gte`, `lt`, `lte` comparisons | credit-check, applicant-request, filling-water, trivia-game, timer |
| `and` compound guards | college-application, flight-booker |
| `or` compound guards | tic-tac-toe |
| `add`, `sub` arithmetic | counter, filling-water, trivia-game, timer, stopwatch |
| `not` negation | trivia-game, todomvc |
| `object` construction | book-lending, todomvc |
| `isNull` null checks | room-readings, tic-tac-toe |
| `if` conditional | tic-tac-toe, todomvc, car-auction |
| `filter` array filtering | todomvc |
| `map` array transformation | tic-tac-toe, todomvc |
| `every` / `some` array predicates | tic-tac-toe |
| `reduce` array aggregation | car-auction |
| `merge` object spread | todomvc |
| `at` array index access | tic-tac-toe |
| `len` length | todomvc |
| `ref` / `$index` bindings | tic-tac-toe, todomvc |
| `fn` builtins | todomvc (`uuid`), `str` (string concatenation) |
| Named guards (`guards:` section) | All except toggle, donut-maker |
| Named actions (`actions:` section) | All except toggle, donut-maker |
| `invoke` with service reference | credit-check, applicant-request, book-lending, room-readings, trivia-game, check-inbox |
| `invoke` with `select` input | credit-check, applicant-request, book-lending, room-readings, college-application |
| `invoke` with `object` input | check-inbox |
| `append` transform | car-auction, todomvc |
| `effects` on entry | purchase-order |
| `after` delayed transitions | filling-water, credit-check, visa-processing, book-lending, purchase-order, car-auction, timer, stopwatch, check-inbox |
| `always` eventless transitions | filling-water, credit-check, college-application, book-lending, tic-tac-toe, trivia-game, timer |
| `durable` wait points | All (where the machine waits for external events) |
| `output` on final state | car-auction |
| Parallel states | donut-maker |
| Compound (nested) states | donut-maker, flight-booker, book-lending, trivia-game, tic-tac-toe |
| `tags` on states | tic-tac-toe |

## Architectural Patterns

### `fromCallback` → `after` delayed transitions

Several XState examples use `fromCallback` actors for periodic scheduling (timer ticks, polling intervals). In durable-machines, this pattern maps to `after` delayed transitions that loop back to the same state:

```json
{
  "running": {
    "after": {
      "1000": { "target": "running", "actions": "tick" }
    }
  }
}
```

Examples: timer, stopwatch, check-inbox.

### `fromPromise` → `invoke` with service reference

XState `fromPromise` actors become named service invocations. The runtime resolves service names to implementations:

```json
{
  "invoke": {
    "src": "checkInboxFunction",
    "onDone": { "target": "next", "actions": "storeResult" }
  }
}
```

Examples: credit-check, book-lending, trivia-game, check-inbox.

### `invoke` with `select` input

Pass context values to invoked actors using expr `select` paths:

```json
{
  "invoke": {
    "src": "processPayment",
    "input": { "select": ["context", "customer"] },
    "onDone": "paid",
    "onError": "failed"
  }
}
```

Examples: credit-check, applicant-request, book-lending, room-readings, college-application.

## Operators Not Yet Demonstrated

The following operators are implemented in `@durable-machines/expr` but not yet used by any sample machine:

| Operator | Description |
|----------|-------------|
| `concat` | Array concatenation (n-ary) |
| `pipe` | Sequential composition with `$` threading |
| `let` | Scoped variable bindings |
| `cond` | Multi-branch conditional |
| `coalesce` | Null-coalescing |
| `mul`, `div` | Multiplication, division |
| `in` | Membership test |
| `neq` | Not-equal comparison |
| `mapVals` | Transform all values in an object |
| `filterKeys` | Filter object keys by predicate |
| `deepSelect` | Recursive path navigation with wildcards |
| `pick` | Select subset of keys from object |
| `multiSelect` | Evaluate multiple expressions into an object |
| `condPath` | Conditional path selection |
| `prepend` | Prepend element to array |
