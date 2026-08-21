/**
 * `SigningKey` — the `signing-keys` JSON:API resource published by
 * `GET /v1/accounts/{account_id}/signing-keys`.
 *
 * The account's **whole** key history, retired keys included. That inclusion is
 * the entire point of the route: a client holding a `.lic` or `.mach` file
 * signed before the last rotation needs the key its `kid` claim names, and its
 * only other options are to fail verification on an authentic file or to accept
 * any key at all, the second of which defeats signing entirely.
 *
 * Three things about this resource are easy to get wrong.
 *
 * **The resource `id` *is* the `kid`.** It is not a UUID like every other
 * resource in this SDK — the server sets `id` to the key's `kid`
 * (`accounts/serializer.rs`), exactly the value an offline file's `kid` claim
 * carries. Its own serializer comment says so: *"The `kid` doubles as the
 * resource id — it is what an offline file names."* So matching a file to its
 * key needs no local hashing at all on this path;
 * {@link import("../crypto/keyId.js").signingKeyId} exists for the other
 * direction, where a caller embeds a public key in the binary and never calls
 * the API, and as a cross-check here.
 *
 * **`publicKey` is camelCase inside an otherwise snake_case resource.** The
 * server's attribute struct carries no blanket rename; the single field rename
 * on `public_key` is the only exception, and `algorithm`, `status`, `created`
 * and `retired` are all bare. Applying camelCase to the whole resource is as
 * wrong as applying snake_case to all of it.
 *
 * **`retired` is absent, not `null`, while a key is still active.** The server
 * skips the field entirely rather than emitting a null, so it is declared
 * optional here.
 *
 * ## Ed25519 only, today
 *
 * Rotation mints Ed25519 keys and nothing else, so `algorithm` is `"ed25519"`
 * on every key the server currently publishes; the account's RSA and ECDSA
 * signing keys are neither published here nor rotated at all. A `.mach` file
 * signed under an RSA or ECDSA scheme therefore has **no entry here**, and no
 * key set built from this route can verify one — which is why
 * {@link import("../checkout/machineFile.js").verifyMachineFileWithKeySet}
 * refuses them outright rather than appearing to support them.
 *
 * That restriction rests only on what this route serves, and deliberately not
 * on any claim about which key a non-Ed25519 file's `kid` names. `tamga-rust`
 * states that both checkout handlers hash `account.ed25519_public_key`
 * whatever scheme signed the bytes; the 12 server-minted certificates in
 * `test/fixtures/machine-file-v2/` do not show that — they carry four distinct
 * kids, one per scheme, each the hash of that scheme's own public key. The
 * disagreement is pinned by measurement in `test/signing-key-id.spec.ts` and
 * changes nothing here either way.
 *
 * `algorithm` and `status` are deliberately open strings rather than closed
 * unions: an account's key history is not re-issuable, so a future algorithm or
 * status value must decode intact rather than failing the whole response and
 * stranding every file the account has already signed.
 */

/** The `signing-keys` JSON:API resource: `{ id, type, attributes }`. */
export interface SigningKey {
  /**
   * **The `kid`, not a UUID** — the same 16-character lowercase hex string an
   * offline file's `kid` claim carries. See this module's doc comment.
   */
  id: string;
  /** Always `"signing-keys"`. */
  type: "signing-keys";
  attributes: SigningKeyAttributes;
}

/** Attributes of a {@link SigningKey}. */
export interface SigningKeyAttributes {
  /**
   * `"ed25519"` for every key the server publishes today — rotation only ever
   * mints Ed25519 keys. An open string, not a closed union, so a future
   * algorithm decodes rather than failing the whole key set.
   */
  algorithm: string;
  /**
   * The public half, standard base64 of the raw 32 bytes.
   *
   * ⚠️ **Wire name `publicKey`** — the one camelCase field in an otherwise
   * snake_case resource.
   *
   * ⚠️ This string, exactly as it appears here, is what the `kid` is the hash
   * of — not its decoded bytes. See
   * {@link import("../crypto/keyId.js").signingKeyId}.
   */
  publicKey: string;
  /**
   * `"active"` or `"retired"`. An account has at most one active key per
   * algorithm; everything else it has ever signed with stays here as
   * `"retired"` so old files keep verifying. Open string for the same reason
   * as {@link algorithm}.
   *
   * ⚠️ Do **not** filter a key set down to `"active"` keys. Dropping the
   * retired ones reproduces exactly the defect this resource exists to fix:
   * every file signed before the most recent rotation stops verifying.
   */
  status: string;
  /** When the key was created (RFC 3339). */
  created: string;
  /**
   * When the key was retired (RFC 3339). **Absent, not `null`**, while the key
   * is still active — the server skips the field entirely.
   */
  retired?: string;
}
