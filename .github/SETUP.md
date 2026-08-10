# CI/CD Setup

Repository secrets required for `.github/workflows/ci.yml` and `.github/workflows/release.yml` to run fully:

| Secret | Used by | Purpose |
|---|---|---|
| `CODECOV_TOKEN` | `ci.yml` (`test` job) | Uploads coverage reports via `codecov/codecov-action@v4`. The step passes `fail_ci_if_error: false`, so a missing/invalid token degrades to "no coverage upload" rather than failing CI outright — but configure it for real coverage tracking. |
| `NPM_TOKEN` | `release.yml` | An npm **automation token** (not a personal token) with publish rights to the `@tamga` scope, used by `changesets/action@v1`'s `publish: pnpm release` step (`changeset publish` → `npm publish --provenance --access public`). |

`GITHUB_TOKEN` is provided automatically by GitHub Actions and does not need to be configured manually; `release.yml` requests `contents: write`, `pull-requests: write`, and `id-token: write` (the last one for npm provenance attestation) via the workflow's `permissions` block.

## Branch protection

Configure on `main` (GitHub → Settings → Branches → Branch protection rules), not expressed in YAML:

- Require the `ci.yml` workflow's `test` job to pass.
- Require the `ci.yml` workflow's `smoke` job (Deno + Bun matrix) to pass.
- Require branches to be up to date before merging.

See `CONTRIBUTING.md` for the full contributor workflow this gates.
