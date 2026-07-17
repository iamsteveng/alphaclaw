# AlphaClaw

A management harness for OpenClaw that also bundles the agent's trading-research skills. This glossary covers the domain language those skills share.

## Language

### Trading (existing ecosystem)

**Trading Plan**:
A GBrain page (`type: trading-plan`) holding a ticker's entry, target, and invalidation levels plus exactly one Decision-Mode Label.
_Avoid_: setup, trade idea

**Decision-Mode Label**:
The single field classifying what to do with a Trading Plan right now: `usable-now`, `accumulate`, `extended-wait`, or `broken-action-required`. Defined solely in the `trading-framework` skill.
_Avoid_: status, rating

### Basing Watch

**Basing Watch**:
A per-ticker watch (`type: basing-watch` GBrain page) for a name in a downtrend that is not yet buyable — it has no entry/target/invalidation levels. It exists to detect when the downtrend has stopped, then graduate the ticker into a Trading Plan.
_Avoid_: watchlist entry, pre-plan, stabilization watch

**Big Down Day**:
A daily close 3% or more below the prior close. Ends any Streak.
_Avoid_: sell-off, red day

**Band**:
The ±5% range around the Streak's anchor: the close of the most recent Reset day, or the first day of available history when no Reset has occurred. A close outside the Band — in either direction — ends the Streak.
_Avoid_: range, channel

**Qualifying Day**:
A trading day that is not a Big Down Day and whose close stays inside the Band.

**Streak**:
The count of consecutive Qualifying Days for a watched ticker since the last Reset. On a Reset it restarts at zero, and the Band re-anchors to the Reset day's close. When a ticker is added to a Basing Watch, its Streak is backfilled from recent price history rather than starting at zero.

**Reset**:
The event that ends a Streak: a Big Down Day or a close outside the Band. Returns the watch to `downtrending`.

**Stabilizing**:
The watch state at a Streak of 5 or more: the base is forming — watch closer, no action.
_Avoid_: bottoming

**Base-Confirmed**:
The watch state at a Streak of 10 or more: the downtrend is considered stopped. Triggers Graduation. Never gated by upcoming earnings, but carries an earnings warning when the print is within 7 calendar days (≈5 trading days).
_Avoid_: bottomed, buy signal (buying remains the user's decision)

**Graduation**:
The hand-off at Base-Confirmed: the ticker leaves the Basing Watch (state `graduated`) and the `watchlist-builder` skill force-rebuilds it into a real Trading Plan with levels.
_Avoid_: promotion, conversion
