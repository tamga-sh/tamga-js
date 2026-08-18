---
"@tamga/sdk": patch
---

Correct the published documentation and align package metadata.

The README and the doc comments that render on the package page described
behaviour the code no longer has: license-file keys documented as a
zero-pad/truncate transform when they are derived with HKDF-SHA256, and HTTP 429
documented as never returned and unhandled when the transport parses
`Retry-After`, backs off with jitter, and retries every `GET` plus the five safe
`POST` actions. The offline format-v2 compatibility break was undocumented.

Package keywords and the description are now the same set used across every
official SDK. No runtime behaviour changed.
