# @tamga/sdk

Official JavaScript/TypeScript SDK for Tamga. Integrate license activation,
offline verification, and machine management into Node.js, Deno, Bun, and
browser applications.

> **Scaffold state:** this repository currently contains project tooling and
> a stub module layout only — no client, transport, or crypto logic is
> implemented yet. See
> [`docs/plans/tamga-js.plan.md`](./docs/plans/tamga-js.plan.md) for the
> remaining implementation tasks and
> [`docs/sdk.md`](https://github.com/tamga-sh/tamga-api/blob/main/docs/sdk.md)
> for the protocol this SDK implements against. The snippet below shows the
> intended shape of the API, not something you can run against a real server
> today.

## Install

```bash
npm install @tamga/sdk
```

Also available via `pnpm add @tamga/sdk` or `yarn add @tamga/sdk`. Published
on the npm registry under the `@tamga` scope (the bare `tamga` name on npm
belongs to an unrelated package).

## Quickstart (illustrative — not yet implemented)

```ts
import { TamgaClient } from "@tamga/sdk";

const client = new TamgaClient({
  accountId: "your-account-id",
  baseUrl: "https://api.tamga.sh",
});

// TODO (docs/plans/tamga-js.plan.md Section C): validate-by-key is not
// implemented yet — this call does not exist on TamgaClient today.
// const result = await client.validateLicenseKey("YOUR-LICENSE-KEY");
// console.log(result.valid, result.code);
```

## Runtime support

Node.js ≥18, Deno, Bun, and browsers (ESM), from a single dual ESM/CJS
build. See `.github/workflows/ci.yml` for the exact runtime matrix this
repo tests against.

## Documentation

- [`docs/plans/tamga-js.plan.md`](./docs/plans/tamga-js.plan.md) — this
  repo's implementation plan (source of truth for scope and task status).
- [`docs/sdk.md`](https://github.com/tamga-sh/tamga-api/blob/main/docs/sdk.md)
  — the Tamga SDK protocol reference this repo implements against, including
  the "Known Server-Side Gaps" section describing what not to build yet.

## License

[MIT](./LICENSE) © Tamga
