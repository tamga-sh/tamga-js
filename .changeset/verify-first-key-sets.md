---
"@tamga/sdk": patch
---

Audit D15–D18 and API-patch fallout. `parseApiErrors` accepts a numeric `status`; `TamgaApiError.meta` and `FingerprintTakenError.existingMachineId` expose the machine a post-patch `409 FINGERPRINT_TAKEN` names, and `activateMachine` adopts it with one `GET` before falling back to the license-scoped search; `SigningKeyMissingError`/`SecretKeyMissingError` type the two new `422`s. The license-file `alg` gate now runs before the signature on every entry point, and both key-set verifiers try every held key against the signature before decoding a byte of `enc`; `CheckoutError.reason` (`"signature"` | `"decryption"`) says which check failed. Docs: 19 of 24 validation codes reachable; key set published from account creation.
