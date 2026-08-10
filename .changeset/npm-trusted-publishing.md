---
"@tamga/sdk": patch
---

Switch npm publishing to Trusted Publishing (OIDC) instead of a stored NPM_TOKEN secret. Fixes a release workflow bug where the auto-generated .npmrc expected NODE_AUTH_TOKEN but the workflow only ever set NPM_TOKEN, so CI publishes were running unauthenticated.
