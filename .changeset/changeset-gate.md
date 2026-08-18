---
"@tamga/sdk": patch
---

CI now fails a pull request that changes the package without declaring a release intent.

Versioning here reads `.changeset/*.md` files rather than commit messages, so a PR that omits
one publishes nothing and does so silently — that happened once already. The new check makes the
omission visible; when a change genuinely needs no release, `pnpm changeset --empty` records that
decision explicitly. No package code changed.
