/**
 * Release resource model — what the auto-update check answers with.
 *
 * Field set ground-truthed against the server's own serializer
 * (`tamga-api/src/features/releases/serializer.rs`, `ReleaseAttributes`).
 *
 * ⚠️ **This resource's attributes are camelCase**, unlike `licenses`,
 * `machines`, `components`, `processes`, `entitlements` and `policies`, which
 * are all snake_case. The server declares
 * `#[serde(rename_all = "camelCase")]` on `ReleaseAttributes` and then renames
 * the two timestamps back to bare `created`/`updated`. So the wire shape is
 * `productId` — not `product_id` — beside `created`/`updated`. Modeled as the
 * server actually emits it rather than normalized, because a normalizer here
 * would be a second, drifting source of truth for the wire format.
 */

/** The `releases` JSON:API resource: `{ id, type, attributes }`. */
export interface Release {
  /** UUIDv7 release ID. */
  id: string;
  /** Always `"releases"`. */
  type: "releases";
  attributes: ReleaseAttributes;
}

/**
 * Attributes of a {@link Release}.
 *
 * No download URL and no artifact list: the upgrade check answers with the
 * release *record*, and the bytes live behind the separate artifact endpoints.
 * `version` is what an updater compares against; to reach the build itself,
 * pass this release's `id` to
 * {@link import("../client.js").TamgaClient.listReleaseArtifacts} and then
 * resolve a presigned URL with
 * {@link import("../client.js").TamgaClient.getArtifactDownloadUrl}.
 */
export interface ReleaseAttributes {
  /** The owning product's ID — camelCase on the wire, see this module's doc. */
  productId: string;
  /** Optional display name. */
  name: string | null;
  /** The version string this release publishes, e.g. `"1.4.2"`. */
  version: string;
  /** Release channel, e.g. `"stable"`/`"beta"`. */
  channel: string;
  /** Server-side lifecycle status, e.g. `"PUBLISHED"`. */
  status: string;
  /**
   * Optional tag. **Omitted entirely** from the response when unset
   * (`skip_serializing_if = "Option::is_none"`) rather than sent as `null`,
   * hence optional here instead of nullable.
   */
  tag?: string;
  /** Arbitrary caller-set metadata. */
  metadata: Record<string, unknown>;
  /** Creation timestamp — bare `created`, not `createdAt`. */
  created: string;
  /** Last-updated timestamp — bare `updated`, not `updatedAt`. */
  updated: string;
}
