/**
 * Artifact resource model — the uploaded build behind a {@link
 * import("./release.js").Release}.
 *
 * Field set ground-truthed against the server's own serializer
 * (`tamga-api/src/features/artifacts/serializer.rs`, `ArtifactAttributes`).
 *
 * ⚠️ **The wire names are camelCase *except* the two timestamps.** The server
 * declares `#[serde(rename_all = "camelCase")]` on `ArtifactAttributes` and
 * then renames both timestamps back to bare `created`/`updated` with explicit
 * `#[serde(rename = ...)]` attributes (`serializer.rs:20,34-37`). So `redirect_url`
 * really is `redirectUrl` on the wire, while `created_at`/`updated_at` are
 * **not** `createdAt`/`updatedAt`. An SDK that applies the camelCase rule
 * uniformly ends up with two permanently `undefined` timestamps. This is the
 * same split `releases` has, and it is modeled as the server emits it rather
 * than normalized — a normalizer here would be a second, drifting source of
 * truth for the wire format.
 *
 * ## What is reachable with a license key, and what is not
 *
 * `artifact.read` and `artifact.download` are in `Role::LicenseToken`'s default
 * permission set (`tamga-api/src/shared/authz/mod.rs:264-265`), so the three
 * read/download routes this SDK models are callable by an embedded client. The
 * create/update/delete/upload verbs are **not** in that set, so this SDK models
 * no write path for artifacts — nothing it could send would be authorized.
 */

/** The `artifacts` JSON:API resource: `{ id, type, attributes }`. */
export interface Artifact {
  /** UUIDv7 artifact ID. */
  id: string;
  /** Always `"artifacts"`. */
  type: "artifacts";
  attributes: ArtifactAttributes;
}

/**
 * Attributes of an {@link Artifact}.
 *
 * Every `Option<T>` on the server serializes as `null` when unset — **except**
 * {@link redirectUrl}, which carries `skip_serializing_if = "Option::is_none"`
 * and is therefore omitted from the body entirely rather than sent as `null`.
 * That is why it is the one optional property here and the rest are nullable.
 */
export interface ArtifactAttributes {
  /** File name as uploaded, e.g. `"myapp-1.4.2-darwin-arm64.dmg"`. */
  filename: string;
  /**
   * File type/extension, e.g. `"dmg"`. Matched **exactly** by the upgrade
   * check's `filetype` filter — see
   * {@link import("../client.js").UpgradeCheckOptions.filetype}.
   */
  filetype: string | null;
  /** Size in **bytes** (unlike a machine's `memory`/`disk`, which are megabytes). */
  filesize: number | null;
  /** Caller-supplied content digest, for verifying the downloaded bytes. */
  checksum: string | null;
  /** Target platform, e.g. `"darwin"`. Matched exactly, like {@link filetype}. */
  platform: string | null;
  /** Target architecture, e.g. `"arm64"`. */
  arch: string | null;
  /** Detached signature over the artifact, when the publisher supplied one. */
  signature: string | null;
  /** Server-side lifecycle status, e.g. `"UPLOADED"`. */
  status: string;
  /**
   * Presigned storage URL — populated **only** on the download action, and only
   * when it was asked for with `redirect=false`. Absent from every list and
   * show response (`skip_serializing_if = "Option::is_none"`).
   *
   * ⚠️ **Fetch this URL with no credentials.** It is a short-lived presigned URL
   * to an object store that is not the Tamga API and has no business seeing a
   * Tamga credential. {@link import("../client.js").TamgaClient.getArtifactDownloadUrl}
   * returns it precisely so the caller can make that request itself, as a plain
   * `fetch(url)`.
   */
  redirectUrl?: string;
  /** Arbitrary publisher-set metadata. */
  metadata: Record<string, unknown>;
  /** Creation timestamp — bare `created`, not `createdAt`. See this module's doc. */
  created: string;
  /** Last-updated timestamp — bare `updated`, not `updatedAt`. See this module's doc. */
  updated: string;
}

/**
 * What {@link import("../client.js").TamgaClient.getArtifactDownloadUrl}
 * resolves to: the artifact resource the server returned, plus its
 * {@link ArtifactAttributes.redirectUrl} lifted out as a non-optional `url`
 * so the caller does not have to re-check a property the call already
 * guarantees.
 */
export interface ArtifactDownloadUrl {
  /** The artifact, exactly as the download action serialized it. */
  artifact: Artifact;
  /**
   * The short-lived presigned storage URL. Fetch it with **no** credentials —
   * see {@link ArtifactAttributes.redirectUrl}.
   */
  url: string;
}
