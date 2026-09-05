import { describe, expect, it } from "vitest";
import {
  parseApiErrors,
  errorFromApiError,
  apiErrorFromResponseBody,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  InternalServerErrorException,
  KeyTakenError,
  FingerprintTakenError,
  PidTakenError,
  CheckInNotRequiredError,
  TtlInvalidError,
  LicenseNotEncryptedError,
  LicenseKeyMissingError,
  SchemeNotSupportedError,
  DatasetInvalidError,
  SigningKeyMissingError,
  SecretKeyMissingError,
  ApiError,
  TamgaParseError,
} from "../src/errors.js";

describe("parseApiErrors", () => {
  it("parses a representative JSON:API error envelope", () => {
    const errors = parseApiErrors({
      errors: [
        {
          id: "01926b3e-0000-7000-8000-000000000000",
          status: "404",
          code: "NOT_FOUND",
          title: "Not Found",
          detail: "The requested license was not found",
        },
      ],
    });
    expect(errors).toEqual([{ status: 404, code: "NOT_FOUND", detail: "The requested license was not found" }]);
  });

  it("lifts source.pointer to the top level", () => {
    const errors = parseApiErrors({
      errors: [
        {
          id: "e1",
          status: "422",
          code: "DATASET_INVALID",
          title: "Unprocessable Entity",
          detail: "dataset must be an object",
          source: { pointer: "/meta/dataset" },
        },
      ],
    });
    expect(errors[0]?.pointer).toBe("/meta/dataset");
  });

  it("throws TamgaParseError for a non-JSON:API-shaped body", () => {
    expect(() => parseApiErrors({ notErrors: [] })).toThrow(TamgaParseError);
    expect(() => parseApiErrors(null)).toThrow(TamgaParseError);
    expect(() => parseApiErrors("a string")).toThrow(TamgaParseError);
  });

  it("accepts a numeric status — the shape the API patch's 422s use", () => {
    // Written as a JSON number on purpose; the pre-patch server sends "422".
    const errors = parseApiErrors({
      errors: [
        {
          id: "01926b3e-0000-7000-8000-000000000000",
          status: 422,
          code: "SIGNING_KEY_MISSING",
          title: "Unprocessable Entity",
          detail: "the account has no Ed25519 signing key",
        },
      ],
    });
    expect(errors).toEqual([
      { status: 422, code: "SIGNING_KEY_MISSING", detail: "the account has no Ed25519 signing key" },
    ]);
  });

  it("copies meta when it is a plain object and drops it otherwise", () => {
    // The wire shape the API patch specifies on a same-license conflict:
    // `status` is the JSON:API STRING "409", `meta.machineId` the holder.
    const [named] = parseApiErrors({
      errors: [
        {
          id: "e1",
          status: "409",
          code: "FINGERPRINT_TAKEN",
          title: "Conflict",
          detail: "already activated",
          meta: { machineId: "m-existing" },
        },
      ],
    });
    expect(named?.meta).toEqual({ machineId: "m-existing" });

    const [notAnObject] = parseApiErrors({
      errors: [
        {
          id: "e1",
          status: "409",
          code: "FINGERPRINT_TAKEN",
          title: "Conflict",
          detail: "x",
          meta: ["no"],
        },
      ],
    });
    expect(notAnObject?.meta).toBeUndefined();
    expect("meta" in (notAnObject as object)).toBe(false);
  });
});

describe("errorFromApiError", () => {
  const build = (code: string) => ({ status: 0, code, detail: "" });

  it("maps fixed-status codes to their typed variants", () => {
    expect(errorFromApiError(build("NOT_FOUND"))).toBeInstanceOf(NotFoundError);
    expect(errorFromApiError(build("UNAUTHORIZED"))).toBeInstanceOf(UnauthorizedError);
    expect(errorFromApiError(build("FORBIDDEN"))).toBeInstanceOf(ForbiddenError);
    expect(errorFromApiError(build("INTERNAL_SERVER_ERROR"))).toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it("maps per-endpoint 409 conflict codes", () => {
    expect(errorFromApiError(build("KEY_TAKEN"))).toBeInstanceOf(KeyTakenError);
    expect(errorFromApiError(build("FINGERPRINT_TAKEN"))).toBeInstanceOf(FingerprintTakenError);
    expect(errorFromApiError(build("PID_TAKEN"))).toBeInstanceOf(PidTakenError);
  });

  it("maps per-endpoint 422 validation codes", () => {
    expect(errorFromApiError(build("CHECK_IN_NOT_REQUIRED"))).toBeInstanceOf(CheckInNotRequiredError);
    expect(errorFromApiError(build("TTL_INVALID"))).toBeInstanceOf(TtlInvalidError);
    expect(errorFromApiError(build("LICENSE_NOT_ENCRYPTED"))).toBeInstanceOf(LicenseNotEncryptedError);
    expect(errorFromApiError(build("LICENSE_KEY_MISSING"))).toBeInstanceOf(LicenseKeyMissingError);
    expect(errorFromApiError(build("SCHEME_NOT_SUPPORTED"))).toBeInstanceOf(SchemeNotSupportedError);
    expect(errorFromApiError(build("DATASET_INVALID"))).toBeInstanceOf(DatasetInvalidError);
  });

  it("maps an unrecognized code to the generic ApiError, preserving the code", () => {
    // 429 TOO_MANY_REQUESTS deliberately has no dedicated subclass: the
    // transport retries it transparently (src/transport.ts::doFetch), so by
    // the time one reaches the caller the retry budget is already spent and
    // what to do next is the caller's policy call.
    const mapped = errorFromApiError(build("TOO_MANY_REQUESTS"));
    expect(mapped).toBeInstanceOf(ApiError);
    expect(mapped.code).toBe("TOO_MANY_REQUESTS");
  });

  it("matcher helpers key on code, not detail", () => {
    const a = errorFromApiError({ status: 404, code: "NOT_FOUND", detail: "detail A" });
    const b = errorFromApiError({ status: 404, code: "NOT_FOUND", detail: "detail B (changed wording)" });
    expect(a.code).toBe(b.code);
    expect(a).toBeInstanceOf(NotFoundError);
    expect(b).toBeInstanceOf(NotFoundError);
  });

  it("maps the API patch's two new 422 codes", () => {
    expect(errorFromApiError(build("SIGNING_KEY_MISSING"))).toBeInstanceOf(SigningKeyMissingError);
    expect(errorFromApiError(build("SECRET_KEY_MISSING"))).toBeInstanceOf(SecretKeyMissingError);
  });

  it("exposes the conflicting machine id a FINGERPRINT_TAKEN names, and only a string one", () => {
    const named = errorFromApiError({
      status: 409,
      code: "FINGERPRINT_TAKEN",
      detail: "already activated",
      meta: { machineId: "m-existing" },
    }) as FingerprintTakenError;
    expect(named).toBeInstanceOf(FingerprintTakenError);
    expect(named.existingMachineId).toBe("m-existing");

    const bare = errorFromApiError({ status: 409, code: "FINGERPRINT_TAKEN", detail: "elsewhere" });
    expect((bare as FingerprintTakenError).existingMachineId).toBeUndefined();

    const notAString = errorFromApiError({
      status: 409,
      code: "FINGERPRINT_TAKEN",
      detail: "x",
      meta: { machineId: 42 },
    });
    expect((notAString as FingerprintTakenError).existingMachineId).toBeUndefined();
  });
});

describe("apiErrorFromResponseBody", () => {
  it("maps the first error in the envelope", () => {
    const err = apiErrorFromResponseBody(404, {
      errors: [{ id: "e", status: "404", code: "NOT_FOUND", title: "x", detail: "gone" }],
    });
    expect(err).toBeInstanceOf(NotFoundError);
  });

  it("falls back to a synthetic ApiError for a non-JSON:API body (e.g. a proxy error page)", () => {
    const err = apiErrorFromResponseBody(502, "<html>Bad Gateway</html>");
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(502);
    expect(err.code).toBe("UNKNOWN");
  });

  it("falls back to a synthetic ApiError for an empty errors array", () => {
    const err = apiErrorFromResponseBody(500, { errors: [] });
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("UNKNOWN");
  });
});
