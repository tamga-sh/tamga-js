---
"@tamga/sdk": minor
---

Correct two `Policy` type declarations that could not describe any policy the server can serve. Both are breaking at the type level and neither changes a single byte of runtime behaviour — nothing that compiled against 0.3.x and worked stops working; code that only *appeared* to work stops compiling.

**`CheckInInterval` now reads `"daily" | "weekly" | "monthly" | "yearly"`**, replacing the noun spellings `"day" | "week" | "month" | "year"`. The `policies.check_in_interval` column carries a `CHECK` constraint admitting only the adverbial forms, and `policies::enums::CHECK_IN_INTERVALS` repeats it, so the old union matched nothing that could be stored. Comparing the field against `"day"` is now `TS2367` ("no overlap"); assigning `"week"` to a `CheckInInterval` is now `TS2322`. Both diagnostics point at code that was already reading a value the server never sends.

⚠️ Knowing the cadence still does not tell you when a check-in is due. The server's own overdue calculation matches on the same noun spellings its database rejects, so every configured cadence falls through to a 30-day default and `check_in_interval_count` is discarded with it — a `"daily"` policy is enforced at thirty days. That defect is upstream (`tamga-api-internal#3`) and no SDK can correct it. Read `require_check_in` to decide whether to call `checkIn`; treat `check_in_interval` as configuration, not as a deadline.

**`PolicyAttributes.max_memory` and `PolicyAttributes.max_disk` are removed.** Both limits exist on the server's policy model and are genuinely enforced — during validation and at machine create — but the policy serializer never emits them, so neither property could ever be populated by `getPolicy` or `getLicensePolicy`. They were declared as optional and documented as "always `undefined`", which only invited callers to branch on a value that never arrives. Reading either is now `TS2339`; including either in a policy-attributes object literal is now `TS2353`. The two limits remain observable exactly where they always were: as `TOO_MUCH_MEMORY`/`TOO_MUCH_DISK` on a failed validation, or `MEMORY_LIMIT_EXCEEDED`/`DISK_LIMIT_EXCEEDED` on a refused machine create.

Held back from the 0.3.x patch line deliberately: on a `0.x` package a minor is not picked up by a `^0.3` range, so this ships behind the correctness fixes in 0.3.4 rather than in front of them.
