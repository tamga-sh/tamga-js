# Contributing to @tamga/sdk

## Dev setup

This repo uses [pnpm](https://pnpm.io) via [Corepack](https://nodejs.org/api/corepack.html) — do not use plain `npm install`, and do not commit a `package-lock.json`/`yarn.lock`.

```bash
corepack enable   # once per machine, if pnpm isn't shimmed yet
pnpm install
```

Node.js ≥18 is required (see `.nvmrc` / `engines.node` in `package.json`).

## Commands

```bash
pnpm dev             # tsup --watch
pnpm build           # tsup — dual ESM+CJS + .d.ts/.d.cts output
pnpm lint             # eslint src test
pnpm typecheck        # tsc --noEmit
pnpm test             # vitest run
pnpm test:coverage    # vitest run --coverage (80% gate — CI enforces the same bar)
pnpm changeset        # record a changeset for your change (see below)
```

Run a single test file: `pnpm vitest run test/machine-file-ed25519.spec.ts`.

## Ground truth

Field names, endpoint paths, and enum values in this SDK should trace back to the protocol reference (`docs/sdk.md`, generated from the running server) rather than to any implementation plan, which was written before implementation and can be stale or abbreviated. When the two disagree, the server wins; document the divergence in the PR description.

That protocol reference lives in a private repository. If you are an external contributor and need to confirm a wire-format detail, open an issue or ask in the PR — do not guess, and do not link to the private repo from any file that ships to npm.

A completed Rust reference implementation of the same protocol exists at `tamga-rust` (a sibling repo in the `tamga-sdk` family) — useful as a correctness oracle for the crypto-heavy sections (checkout files, offline proof), though this repo never depends on or ports its code directly.

## Workflow

1. **Research first.** Check `tamga-rust`'s equivalent module before writing new logic from scratch — most of the non-obvious wire-format details here (byte-vs-string signing conventions, field ordering, key derivation) were already solved once.
2. **Write tests first (TDD).** New `test/*.spec.ts` files mirror the `src/` layout being tested.
3. **Crypto-touching changes require a security review** before merge — see "Security-sensitive changes" below.
4. **Record a changeset** (`pnpm changeset`) for any user-facing change — this repo uses [Changesets](https://github.com/changesets/changesets) for versioning/changelog generation; a merged PR without one won't trigger a release.
5. Open a PR. CI (`.github/workflows/ci.yml`) runs lint, typecheck, tests with coverage, a full build, and a cross-runtime (Deno/Bun) smoke test against the built output.

## Security-sensitive changes

Any change touching `src/checkout/*.ts`, `src/crypto/*.ts`, or `src/proof.ts` needs sign-off from a security review (see `SECURITY.md`) before merge — these implement a from-scratch reimplementation of the server's offline signature/encryption formats, and a subtle bug here (e.g. verifying a signature against the wrong byte representation) can silently accept forged license/machine files. This is not optional and is not satisfied by a general code review alone.

## Branch & commit conventions

- Branches: `feat/*`, `fix/*`, `chore/*`, `refactor/*`, `docs/*`
- Commits: [Conventional Commits](https://www.conventionalcommits.org/) (`feat: …`, `fix: …`, etc.) — required for Changesets-adjacent tooling and this SDK family's shared release conventions to stay meaningful across repos.

## Branch protection

`main` requires the `ci.yml` workflow's `test` job (lint/typecheck/test/build) **and** its `smoke` job (Deno + Bun) to pass before merge. This is a manual GitHub repository setting (Settings → Branches → Branch protection rules), not something expressed in the workflow YAML itself — confirm it's configured if you're setting up a fresh fork/mirror of this repo.
