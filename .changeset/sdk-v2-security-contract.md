---
"@tamga/sdk": minor
---

License-file key derivation replaced with HKDF-SHA256 (the old zero-pad/truncate transform is
removed, not deprecated). Offline license-file format v2: `alg` must end in `+v2`, signed
`meta` claims (iat/exp/jti/kid), `exp` enforced with a 60s clock-skew tolerance. HTTP 429
handling: capped and parsed `Retry-After`, jittered exponential backoff, auto-retry scoped to
`GET` plus the five safe `POST` actions (`validate`, `validate-key`, `check-in`, `check-out`,
`ping`) -- creates are deliberately excluded.

**Compatibility note:** offline license files must be format v2. v1 files are rejected outright
with no fallback path -- this is a real behavioral break for any caller holding a v1-issued
`.lic` file, released as a minor version by deliberate choice rather than because the change is
backward compatible. Treat this note as the actual compatibility warning regardless of the
semver level.
