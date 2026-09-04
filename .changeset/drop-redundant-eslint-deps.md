---
"@tamga/sdk": patch
---

Drop the redundant direct devDependencies on `@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser`. `eslint.config.js` only ever used the `typescript-eslint` meta-package, which already ships both, so the two direct entries only produced duplicate Dependabot PRs. No change to the published package.
