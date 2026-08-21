/**
 * {@link SigningKeySet} — the trusted Ed25519 keys an offline file is allowed
 * to have been signed by, indexed by the `kid` its claims name.
 *
 * Ground-truthed against `tamga-rust`'s `src/checkout/key_set.rs` (the
 * reference implementation for this SDK family).
 *
 * ## The defect this closes
 *
 * Verifying against one embedded public key collapses two completely different
 * outcomes into one error. A file signed last month, before the account rotated
 * its signing key, is authentic and its license may well still be valid — but
 * it fails against the current key with exactly the error a forgery produces,
 * and the caller has no way to tell "my key set is stale" from "this file was
 * tampered with". The first calls for fetching the key set or shipping an
 * update; the second calls for refusing the customer. A paying customer holding
 * a valid file gets locked out, and the error sends support to the wrong place.
 *
 * ## How the `kid` is used, and why that is safe
 *
 * The `kid` claim lives *inside* the signed payload but is read *before* the
 * signature is checked, which is sound under one rule, and only that rule: it
 * **selects** a key from a set the caller already trusts, and can never
 * **supply** one. A file naming a `kid` this set does not hold is a
 * {@link import("../errors.js").SigningKeyError}; a file naming one it does
 * hold is verified against exactly that key and nothing else.
 *
 * There is deliberately **no "try every key" fallback**. Trying them all would
 * verify the same set of files while destroying the very distinction this
 * module exists for — an unknown-key failure and a forgery would again be
 * indistinguishable, which is the defect, not the fix.
 *
 * This is the same discipline JWS `kid` handling needs, and it is why a
 * `SigningKeySet` can only be built from keys the caller supplies: from the
 * account's published key set
 * ({@link import("../client.js").TamgaClient.getSigningKeySet}) or from public
 * keys embedded in the application binary ({@link SigningKeySet.fromPublicKeys}).
 *
 * ## Ed25519 only
 *
 * Every key the server publishes is Ed25519, and `.lic` files are
 * Ed25519-signed regardless of the license's own `scheme`. A `.mach` file
 * signed under an RSA or ECDSA scheme cannot be verified through this path at
 * all — its key is neither published on the `signing-keys` route nor rotated,
 * so no set built from that route can hold it. See `src/models/signingKey.ts`.
 */

import { CheckoutError, SigningKeyError } from "../errors.js";
import {
  signingKeyId,
  SIGNING_KEY_ID_LENGTH,
  UNBACKFILLED_ACCOUNT_KEY_ID,
} from "../crypto/keyId.js";
import { base64Decode } from "../internal/base64.js";
import type { SigningKey } from "../models/signingKey.js";

/** The algorithm string the server writes for every key it publishes. */
const ED25519_ALGORITHM = "ed25519";

/** Raw Ed25519 public key length, in bytes. */
const ED25519_PUBLIC_KEY_LENGTH = 32;

/**
 * A published key whose resource `id` does not equal the `kid` computed from
 * its own `publicKey`.
 *
 * Reported rather than thrown — see {@link SigningKeySet.mismatches}.
 */
export interface SigningKeyIdMismatch {
  /** The `kid` the server served as the resource `id`. This is what the set indexes by. */
  servedKeyId: string;
  /** The `kid` computed locally from `publicKey` — what the id was expected to be. */
  computedKeyId: string;
  /** The `publicKey` attribute the computation was run over, verbatim. */
  publicKey: string;
}

/**
 * A set of trusted Ed25519 public keys, indexed by `kid`.
 *
 * Build one from the account's published key set with
 * {@link import("../client.js").TamgaClient.getSigningKeySet}, from already
 * fetched resources with {@link SigningKeySet.fromResources}, or from keys
 * embedded in the binary — no network at all — with
 * {@link SigningKeySet.fromPublicKeys}. Then pass it to
 * {@link import("./licenseFile.js").verifyLicenseFileWithKeySet} or
 * {@link import("./machineFile.js").verifyMachineFileWithKeySet}.
 *
 * Immutable once built, and cheap to hold: a rotation *adds* a key rather than
 * invalidating the ones already there, so a cached set only ever goes stale for
 * files signed *after* it was fetched — which is exactly what an
 * `"unknown-key-id"` {@link import("../errors.js").SigningKeyError} names, and
 * the signal to fetch again.
 */
export class SigningKeySet {
  /** `kid` → raw 32-byte public key, in insertion order. */
  private readonly entries: ReadonlyMap<string, Uint8Array>;

  private readonly mismatchList: readonly SigningKeyIdMismatch[];

  private constructor(
    entries: ReadonlyMap<string, Uint8Array>,
    mismatches: readonly SigningKeyIdMismatch[],
  ) {
    this.entries = entries;
    this.mismatchList = mismatches;
  }

  /**
   * Builds a key set from public keys the caller holds, each standard base64 of
   * the raw 32 bytes — the format the server publishes and stores.
   *
   * Each key's `kid` is derived with
   * {@link import("../crypto/keyId.js").signingKeyId}, so this works with no
   * network access at all. It is the path for an application that pins its
   * account's signing keys in its own binary; when the account rotates, ship a
   * build that lists both the new key and every old one, and files issued on
   * either side of the rotation keep verifying.
   *
   * **Strict on purpose**, unlike {@link fromResources}: a key that is not
   * valid base64 of exactly 32 bytes throws
   * {@link import("../errors.js").SigningKeyError} of kind `"invalid-key"`
   * rather than being skipped. A typo in a key pinned in an application binary
   * must fail loudly at startup, not silently produce a set that reports every
   * genuine file as signed by an unknown key, at runtime, in the field.
   *
   * A later duplicate of a `kid` already present is ignored, so listing the
   * same key twice is harmless.
   */
  static fromPublicKeys(publicKeys: Iterable<string>): SigningKeySet {
    const entries = new Map<string, Uint8Array>();
    for (const publicKey of publicKeys) {
      const bytes = decodeEd25519PublicKey(publicKey);
      if (bytes === undefined) {
        throw SigningKeyError.invalidKey(
          `expected standard base64 of exactly ${ED25519_PUBLIC_KEY_LENGTH} bytes`,
        );
      }
      const kid = signingKeyId(publicKey);
      if (!entries.has(kid)) entries.set(kid, bytes);
    }
    return new SigningKeySet(entries, []);
  }

  /**
   * Builds a key set from the account's published key set, as returned by
   * {@link import("../client.js").TamgaClient.listSigningKeys}.
   *
   * **The `kid` is taken from each resource's `id`, which *is* the `kid`** —
   * the server sets it from the same value it writes into a file's claim, so no
   * local hashing decides what this set is indexed by. Computing the id locally
   * is a cross-check here, not a requirement: every resource's `publicKey` is
   * hashed anyway and any disagreement is recorded in {@link mismatches}, which
   * is how a caller notices a key it cannot actually use before a customer
   * does.
   *
   * **Lenient where {@link fromPublicKeys} is strict, and for the opposite
   * reason:** this input is the server's whole key history, and one unusable
   * row — a future non-Ed25519 algorithm, a legacy key that does not decode —
   * must not strand every file the account has already signed. Such entries are
   * skipped; a file naming one surfaces as an `"unknown-key-id"`
   * {@link import("../errors.js").SigningKeyError} with the `kid` in hand.
   * Compare {@link size} against the number of resources fetched if you need to
   * know something was dropped.
   *
   * ⚠️ Retired keys are kept, deliberately. Filtering on
   * `attributes.status === "active"` reintroduces the exact defect this class
   * exists to fix.
   */
  static fromResources(resources: Iterable<SigningKey>): SigningKeySet {
    const entries = new Map<string, Uint8Array>();
    const mismatches: SigningKeyIdMismatch[] = [];

    for (const resource of resources) {
      const { algorithm, publicKey } = resource.attributes;
      if (algorithm.toLowerCase() !== ED25519_ALGORITHM) continue;

      const bytes = decodeEd25519PublicKey(publicKey);
      if (bytes === undefined) continue;

      // The served id is authoritative — it is literally the value the server
      // stamps into the file's `kid` claim. The local computation only gets to
      // raise a hand when the two disagree.
      const computedKeyId = signingKeyId(publicKey);
      if (computedKeyId !== resource.id) {
        mismatches.push({ servedKeyId: resource.id, computedKeyId, publicKey });
      }
      if (!entries.has(resource.id)) entries.set(resource.id, bytes);
    }

    return new SigningKeySet(entries, mismatches);
  }

  /**
   * The raw 32-byte public key this set holds under `kid`, or `undefined`.
   *
   * Matching is exact and case-sensitive: the server emits lowercase hex on
   * both sides, in the resource `id` and in the file's claim alike.
   */
  find(keyId: string): Uint8Array | undefined {
    return this.entries.get(keyId);
  }

  /** Whether this set holds a key under `kid`. */
  has(keyId: string): boolean {
    return this.entries.has(keyId);
  }

  /**
   * How many usable keys the set holds.
   *
   * An empty set is not an error — every verification through it reports
   * `"unknown-key-id"`, which is the honest answer — but it is almost always a
   * sign that the fetch or the embedded key list is wrong.
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * The `kid`s this set can verify against, in insertion order. Worth putting
   * in the log line next to an `"unknown-key-id"` failure — the two together
   * say precisely what the file wanted and what was on hand.
   */
  get keyIds(): readonly string[] {
    return [...this.entries.keys()];
  }

  /**
   * Published keys whose resource `id` disagreed with the `kid` computed from
   * their own `publicKey`, from the most recent {@link fromResources} call.
   * Always empty for a set built by {@link fromPublicKeys}, which derives every
   * id itself and so has nothing to disagree with.
   *
   * Recorded rather than thrown, because the served `id` is the authoritative
   * value — it is what the server stamps into the file's `kid` claim — and
   * rejecting the whole response over a disagreement would strand every file
   * the account ever signed. A non-empty list means one of three things, all
   * worth an alert: this SDK's `kid` computation has drifted from the server's,
   * the server changed how it derives the id, or the response was altered in
   * transit. The affected key still verifies files under its served id.
   */
  get mismatches(): readonly SigningKeyIdMismatch[] {
    return this.mismatchList;
  }
}

/**
 * Decodes a standard-base64 Ed25519 public key to its raw 32 bytes, or
 * `undefined` if it is not valid base64 of exactly that length.
 *
 * Returns rather than throws so the two builders can impose their own,
 * deliberately opposite, policies on a bad key.
 */
function decodeEd25519PublicKey(publicKeyBase64: string): Uint8Array | undefined {
  let bytes: Uint8Array;
  try {
    bytes = base64Decode(publicKeyBase64);
  } catch {
    return undefined;
  }
  return bytes.length === ED25519_PUBLIC_KEY_LENGTH ? bytes : undefined;
}

/**
 * Whether `keyId` is shaped like a `kid` the server emits: exactly
 * {@link import("../crypto/keyId.js").SIGNING_KEY_ID_LENGTH} lowercase hex
 * characters.
 *
 * A claim that fails this is malformed rather than merely unknown, but both are
 * reported as `"unknown-key-id"` — the remedy is the same and the shape of an
 * attacker-supplied string is not worth a second error kind.
 */
export function isWellFormedKeyId(keyId: string): boolean {
  return keyId.length === SIGNING_KEY_ID_LENGTH && /^[0-9a-f]+$/.test(keyId);
}

/**
 * Reads **only** the `kid` claim out of not-yet-verified payload bytes.
 *
 * Deliberately a minimal probe rather than a full payload parse: the one value
 * taken from unverified bytes should be the one value needed to pick a key, and
 * everything else waits until the signature has passed. The full parse, the
 * `meta` shape checks and the `exp` enforcement all still happen afterwards, on
 * the same bytes, once they are authenticated.
 *
 * Shared by both file formats, whose payloads carry the same `meta` block built
 * from the same server-side struct.
 *
 * Not part of the public surface — an internal helper for
 * `src/checkout/licenseFile.ts` and `src/checkout/machineFile.ts`.
 */
export function probeKeyIdClaim(plaintext: Uint8Array): string {
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(plaintext));
  } catch (error) {
    throw CheckoutError.invalidJson(error instanceof Error ? error.message : String(error));
  }
  if (typeof payload !== "object" || payload === null) {
    throw CheckoutError.invalidJson('expected {"data": ..., "meta": {"kid": ...}}');
  }
  const meta = (payload as { meta?: unknown }).meta;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    throw CheckoutError.invalidJson(
      "payload is missing the signed 'meta' claims (this looks like a pre-v2 file)",
    );
  }
  const kid = (meta as { kid?: unknown }).kid;
  if (typeof kid !== "string") {
    throw CheckoutError.invalidJson(
      "payload's signed 'meta' claims carry no 'kid', so no signing key can be selected",
    );
  }
  return kid;
}

/**
 * Selects the trusted public key an offline file's `kid` claim names.
 *
 * The three outcomes a caller has to be able to tell apart all originate here:
 *
 * - the `kid` is in the set → that key, and only that key, is returned;
 * - the `kid` is `SHA-256("")` and the set does not hold it → the issuing
 *   account published no Ed25519 key at all, and no key set will ever verify
 *   the file (`"no-published-signing-key"`);
 * - otherwise → `"unknown-key-id"`, which almost always means a key set that
 *   predates a rotation.
 *
 * The set is consulted **before** the empty-key special case, so a set that
 * genuinely holds that id still wins. The special case only refines the message
 * on a lookup that was going to fail anyway; it never rejects a key the caller
 * supplied.
 *
 * Not part of the public surface — an internal helper for
 * `src/checkout/licenseFile.ts` and `src/checkout/machineFile.ts`.
 */
export function selectSigningKey(
  plaintext: Uint8Array,
  keySet: SigningKeySet,
): { keyId: string; publicKey: Uint8Array } {
  const keyId = probeKeyIdClaim(plaintext);

  const publicKey = keySet.find(keyId);
  if (publicKey !== undefined) return { keyId, publicKey };

  if (keyId === UNBACKFILLED_ACCOUNT_KEY_ID) {
    throw SigningKeyError.noPublishedSigningKey(keyId);
  }
  throw SigningKeyError.unknownKeyId(keyId);
}
