---
"@tamga/sdk": patch
---

Release automation now opens its version PR with a GitHub App token.

Release PRs were previously opened with the default `GITHUB_TOKEN`, which GitHub refuses to let
trigger workflows. CI therefore never reported on the version PR, branch protection blocked it,
and every release needed an admin override. No package code changed.
