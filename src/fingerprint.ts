/**
 * Fingerprint canonicalisation — one machine, one seat.
 *
 * ## The defect this fixes
 *
 * A machine's `fingerprint` is stored as `fingerprint TEXT NOT NULL` and is
 * unique per `(license_id, fingerprint)`. There is no length limit, no `CHECK`
 * constraint and no normalisation anywhere on the server. All eight Tamga SDKs
 * sent whatever string the caller handed them, byte for byte. So `"ABC-123"`,
 * `"abc-123"` and `" ABC-123 "` were three machines holding three seats against
 * `policy.max_machines`, and the third one is the common case: a value read out
 * of a file, a command's stdout, or an environment variable, with a trailing
 * newline nobody sees.
 *
 * ## What this deliberately does NOT do
 *
 * **It reads no hardware identifiers.** What identifies a machine is a product
 * decision, not a library's: a cloned VM template shares its identifiers, a
 * container has none, a replaced motherboard changes them, and in a browser
 * there is nothing sane to read at all. No default is right for both a desktop
 * application and a Kubernetes sidecar, and a wrong default here spends a
 * customer's seats. The caller chooses the components; this turns that choice
 * into a stable string.
 *
 * **It does not Unicode-normalise, and that is a constraint rather than an
 * oversight.** JavaScript has `String.prototype.normalize` built in, so adding
 * NFC here would cost nothing *in this port* — which is exactly the problem.
 * NFC needs a new dependency in the Rust and Go SDKs and either ICU or
 * hand-rolled Unicode tables in the C11 one, whose entire selling point is
 * having no dependencies. A rule eight ports cannot implement identically is
 * worse than no rule: it would produce two different fingerprints for one
 * machine depending on which SDK the application happened to be written with,
 * and quietly consume two seats. So values pass through as their UTF-8 bytes,
 * and a caller whose values can arrive in more than one normal form normalises
 * them **before** calling. Do not "improve" this by adding NFC; it would make
 * this SDK the outlier that silently disagrees with the other seven.
 *
 * **It does not case-fold.** Lowercasing a base64 or hex identifier corrupts
 * it, and the `case_preserved` vector pins that `"ABC123"` and `"abc123"` stay
 * different.
 *
 * ## The algorithm
 *
 * ```text
 * component   = label + "=" + ascii_trim(value)
 * canonical   = "tamga-fingerprint-v1" + US + join(US, sort_bytewise(components))
 * fingerprint = lowercase_hex(SHA-256(UTF-8(canonical)))
 * ```
 *
 * `US` is U+001F, the ASCII unit separator, emitted as the single byte `0x1f`.
 * The literal prefix is a domain separator, so a future v2 rule cannot collide
 * with v1.
 *
 * Two steps are easy to get subtly wrong in JavaScript specifically. Only one of
 * them is *observably* wrong, and the difference between the two is worth
 * stating precisely, because it decides what a test can honestly claim.
 *
 * - **The trim is ASCII-only**, which is *not* what `String.prototype.trim`
 *   does. That trims the whole Unicode `White_Space` set — U+00A0, U+2028, the
 *   ideographic space and more — none of which the other seven ports would
 *   strip. Using it would reintroduce exactly the cross-port divergence the
 *   normalisation rule exists to avoid, in a less visible place. This one is
 *   directly observable and is pinned by a test.
 * - **The sort is bytewise over UTF-8**, which is *not* what
 *   `Array.prototype.sort` does — its default comparator orders by UTF-16 code
 *   unit, and the two genuinely disagree above the BMP: U+10000 is the
 *   surrogate pair `0xD800 0xDC00` in UTF-16 but `0xF0 0x90 0x80 0x80` in
 *   UTF-8, so it sorts *before* U+FFFF (`0xFFFF`) by code unit and *after* it
 *   (`0xEF ...`) by byte. {@link compareUtf8} therefore encodes first and
 *   compares bytes.
 *
 *   ⚠️ **But no valid input can tell the two comparators apart here, and a test
 *   claiming otherwise would be claiming something false.** The order between
 *   two components is always decided inside their ASCII prefix, never in the
 *   value: labels are ASCII printable, cannot contain `=`, and duplicates are
 *   rejected — so two distinct components differ either at some label byte, or
 *   at the `=` of whichever label is a prefix of the other, and both are below
 *   `0x80`, where UTF-8 bytes and UTF-16 code units are identical. Measured
 *   exhaustively over 8 732 016 valid pairs built from every one-character
 *   label and 400 two-character labels crossed with astral, BMP-max and
 *   ASCII values: zero divergent orderings.
 *
 *   The bytewise sort stays anyway, for two reasons. It is what the shared
 *   cross-port specification states, so eight implementations agreeing on it
 *   costs nothing and disagreeing later costs a customer's seats. And
 *   `parts.sort()` would only be equivalent *because* of an invariant
 *   established a hundred lines away in {@link validateLabel} — a future v2
 *   that relaxes labels would silently break it. `test/fingerprint.spec.ts`
 *   proves the equivalence is structural rather than asserting a divergence
 *   that cannot occur, and it holds the control case showing the two
 *   comparators really do differ once the ASCII prefix is removed.
 *
 * The vectors in `test/fixtures/fingerprint/fingerprint.json` are shared across
 * all eight SDKs and were generated by an independent SHA-256 implementation —
 * a fixture an SDK produced can only prove that SDK agrees with itself.
 *
 * ## Using it
 *
 * ```ts
 * const fingerprint = computeFingerprint([
 *   { label: "machine-id", value: machineId },
 *   { label: "disk", value: diskSerial },
 * ]);
 * await client.activateMachine(licenseId, fingerprint);
 * ```
 *
 * Pick the components once and keep them stable for the life of an
 * installation: changing the set changes the fingerprint, and a changed
 * fingerprint is a new machine holding a new seat.
 */

import { sha256 } from "@noble/hashes/sha2";

import { FingerprintError } from "./errors.js";

/**
 * One labelled input to a fingerprint.
 *
 * Deliberately a list of these rather than a `Record<string, string>`: a record
 * cannot hold two entries with the same key, so a duplicate label would be
 * silently collapsed by the object literal before this module ever saw it — and
 * a duplicate label is precisely one of the things that must be **rejected**.
 */
export interface FingerprintComponent {
  /**
   * A stable name for what the value is, e.g. `"machine-id"` or `"disk"`.
   *
   * Non-empty, ASCII printable (`0x21`-`0x7E`) and may not contain `=`. Not
   * trimmed — a label is a constant in the calling code, so whitespace in one
   * is a typo rather than dirty input.
   */
  label: string;
  /**
   * The identifier itself.
   *
   * Leading and trailing **ASCII** whitespace is trimmed before validation; the
   * remainder may not contain an ASCII control character. May contain `=`, and
   * may be empty — an empty value is a component that exists and reads empty,
   * which is not the same as an absent one.
   */
  value: string;
}

/**
 * The domain-separator prefix every canonical string starts with.
 *
 * Exported so a caller can recognise one, and so a future `v2` rule is visibly
 * a different string rather than a silent change of meaning.
 */
export const FINGERPRINT_DOMAIN = "tamga-fingerprint-v1";

/**
 * U+001F, the ASCII unit separator — one `0x1f` byte in UTF-8.
 *
 * Written as an escape rather than as the literal character on purpose: a raw
 * control byte in source is invisible in a diff, in review and in most editors.
 */
const SEPARATOR = "\u001f";

/** ASCII whitespace: space, tab, LF, VT, FF, CR. Deliberately not the Unicode set. */
const ASCII_WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d]);

/** Lowest and highest code point allowed in a label — ASCII printable, excluding space. */
const LABEL_MIN_CODE = 0x21;
const LABEL_MAX_CODE = 0x7e;

/** `=`, reserved as the label/value separator and therefore banned in a label. */
const EQUALS_CODE = 0x3d;

/** Highest ASCII control code, and `DELETE` — both rejected inside a value. */
const CONTROL_MAX_CODE = 0x1f;
const DELETE_CODE = 0x7f;

const encoder = new TextEncoder();

/**
 * Trims leading and trailing ASCII whitespace only.
 *
 * `String.prototype.trim` is not usable here: it strips the whole Unicode
 * `White_Space` set, so a value with a leading U+00A0 would be trimmed by this
 * SDK and not by the other seven, producing two fingerprints for one machine.
 * See this module's doc comment.
 */
function asciiTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && ASCII_WHITESPACE.has(value.charCodeAt(start))) start++;
  while (end > start && ASCII_WHITESPACE.has(value.charCodeAt(end - 1))) end--;
  return value.slice(start, end);
}

/**
 * Compares two strings by their UTF-8 bytes, ascending.
 *
 * Not `localeCompare`, which is locale-dependent and would make a machine's
 * identity depend on the machine's locale.
 *
 * Not `a < b` either — that orders by UTF-16 code unit and disagrees with UTF-8
 * byte order above the BMP. On *this* module's inputs the two are provably
 * equivalent, because the label rules confine the deciding byte to ASCII; see
 * this module's doc comment for the measurement. It is written bytewise anyway
 * so that the equivalence is a property of the inputs rather than a dependency
 * of the sort, which is what keeps a future relaxation of the label rules from
 * silently changing the ordering.
 */
function compareUtf8(a: string, b: string): number {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i++) {
    const diff = (left[i] as number) - (right[i] as number);
    if (diff !== 0) return diff;
  }
  // The length tiebreak is unreachable through the public API for the same
  // structural reason the UTF-16 divergence is: one component can only be a
  // byte-prefix of another if the shorter one's `=` lines up with a label
  // character of the longer one, and `=` is banned in labels. Kept because the
  // comparator is a total order on strings, not on this module's inputs only.
  return left.length - right.length;
}

/** Rejects a label that is empty, non-ASCII-printable, or contains `=`. */
function validateLabel(label: string): void {
  if (label.length === 0) throw FingerprintError.emptyLabel();
  for (let i = 0; i < label.length; i++) {
    const code = label.charCodeAt(i);
    if (code === EQUALS_CODE) {
      throw FingerprintError.invalidLabel(label, "'=' is reserved as the label/value separator");
    }
    if (code < LABEL_MIN_CODE || code > LABEL_MAX_CODE) {
      throw FingerprintError.invalidLabel(
        label,
        `only ASCII printable characters (0x21-0x7E) are allowed, found code unit 0x${code.toString(16)} at index ${i}`,
      );
    }
  }
}

/**
 * Rejects an already-trimmed value that still holds an ASCII control character.
 *
 * Rejection rather than stripping is the whole point: silently removing the
 * character would map two different inputs onto one fingerprint, i.e. onto one
 * seat, which is the bug class this module exists to close.
 */
function validateTrimmedValue(label: string, trimmed: string): void {
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code <= CONTROL_MAX_CODE || code === DELETE_CODE) {
      throw FingerprintError.invalidValue(
        label,
        `ASCII control character 0x${code.toString(16)} at index ${i} - control characters are rejected, never stripped`,
      );
    }
  }
}

/**
 * Builds the canonical string a fingerprint is the SHA-256 of, without hashing
 * it.
 *
 * Exported for two reasons: it is what a cross-SDK disagreement is debugged
 * against (two ports that produce different digests can diff this and see
 * *where*), and it is what the shared vectors state alongside each expected
 * digest. Applications should call {@link computeFingerprint}.
 *
 * @throws {FingerprintError} on any input the algorithm cannot represent
 *   exactly — see {@link FingerprintError} for the full list. Nothing is
 *   repaired.
 */
export function canonicalFingerprintString(components: readonly FingerprintComponent[]): string {
  if (components.length === 0) throw FingerprintError.noComponents();

  const seen = new Set<string>();
  const parts: string[] = [];
  for (const { label, value } of components) {
    validateLabel(label);
    if (seen.has(label)) throw FingerprintError.duplicateLabel(label);
    seen.add(label);

    const trimmed = asciiTrim(value);
    validateTrimmedValue(label, trimmed);
    parts.push(`${label}=${trimmed}`);
  }

  parts.sort(compareUtf8);
  return `${FINGERPRINT_DOMAIN}${SEPARATOR}${parts.join(SEPARATOR)}`;
}

/**
 * Canonicalises `components` and returns the fingerprint: SHA-256 of the
 * canonical string's UTF-8 bytes, as 64 lowercase hex characters.
 *
 * Pure and synchronous — backed by `@noble/hashes`, already a dependency, for
 * the same reason `src/crypto/keyId.ts` uses it: `crypto.subtle.digest` would
 * work equally well but is Promise-based, and there is no reason to make
 * computing a machine's identity `async`.
 *
 * Three invariants worth knowing, each pinned by a pair of shared vectors:
 * component order does not matter, surrounding ASCII whitespace does not
 * matter, and **case does** — see this module's doc comment for why the last
 * one is not an oversight.
 *
 * @throws {FingerprintError} on invalid input. Nothing is repaired: a rejected
 *   call means the caller's identifiers are wrong, and guessing at a fix would
 *   quietly merge two machines onto one seat.
 */
export function computeFingerprint(components: readonly FingerprintComponent[]): string {
  const digest = sha256(encoder.encode(canonicalFingerprintString(components)));
  let hex = "";
  for (const byte of digest) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
