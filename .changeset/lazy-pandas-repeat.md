---
"@tamga/sdk": patch
---

Model the artifact read and download routes, so an embedded updater can reach
the build a release points at.

They were excluded from every Tamga SDK because `artifact.download` appeared in
no role's permission set — the licensed client fetching its own update was the
route's primary caller and it was a flat `403`. The licence-key role has always
held `artifact.read`, so listing and showing an artifact were reachable, but
metadata you cannot act on is not worth a surface. The server now grants that
role `artifact.download` as well and gates the download on the owning release,
so the whole flow works and is worth modelling.

**New, and additive — no existing signature, type or error kind changed.**

- `listReleaseArtifacts(releaseId, opts?)` — the builds attached to a release,
  keyset-paginated like `listComponents`.
- `getArtifact(artifactId)` — one artifact's metadata, including the `checksum`
  and `signature` an updater verifies downloaded bytes against.
- `getArtifactDownloadUrl(artifactId, opts?)` — resolves a short-lived presigned
  storage URL, with an optional `ttlSeconds`.
- `Artifact` / `ArtifactAttributes` / `ArtifactDownloadUrl` /
  `ArtifactDownloadOptions` types, and the `ARTIFACT_TTL_MIN_SECONDS` /
  `ARTIFACT_TTL_MAX_SECONDS` bounds the server validates against.

Create, update, delete and upload stay unmodelled: those verbs are not in the
licence-key role's permission set, so nothing this SDK could send would be
authorized.

**`getArtifactDownloadUrl` returns a URL rather than bytes, on purpose.** The
route's default answer is a `303 See Other` at the presigned URL, and `fetch`
follows redirects unless told not to. The Fetch standard drops `Authorization`
only when a redirect crosses an *origin*, so a deployment serving path-style
object storage from the API's own origin would receive the licence key verbatim
— measured on Node 22, Deno 2.9 and Bun 1.3. This SDK sends `?redirect=false`
and additionally pins the request to `redirect: "manual"`, so the URL comes back
in the body and a redirect that arrives anyway is thrown rather than chased.
Fetch the URL yourself, with no credentials.

Two more traps this records. `ArtifactAttributes` is `rename_all = "camelCase"`
*and* renames both timestamps back, so the wire names are `redirectUrl` but bare
`created`/`updated` — an SDK applying camelCase uniformly gets two null
timestamps. And a `403` from the download action is not necessarily an auth
problem: the handler enforces the owning release's read gate too, so a `CLOSED`
release refuses its binary even to a caller holding `artifact.download`.
