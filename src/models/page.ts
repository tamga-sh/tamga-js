/**
 * Offset pagination — the **second** pagination style in this API.
 *
 * The nested sub-resource listings this SDK already calls
 * (`/machines/{id}/components`, `/machines/{id}/processes`,
 * `/licenses/{id}/entitlements`) are hand-written **keyset** queries: `limit` +
 * `page[after]`, no totals, a short page as the only end-of-list signal. See
 * {@link import("../client.js").ListOptions}.
 *
 * The top-level collections — `GET /machines` is the one this SDK exposes — go
 * through the server's shared `list_query` module instead, which is plain
 * `LIMIT`/`OFFSET`: `page[number]` + `page[size]`, and a real
 * {@link OffsetPageMeta} in the response's `meta.page`
 * (`tamga-api/src/shared/list_query.rs`, `PageMeta::into_meta`).
 *
 * The two are not interchangeable, and guessing wrong is silent in both
 * directions: a cursor sent to an offset endpoint is ignored and page one comes
 * back forever, and an offset page number sent to a keyset endpoint is ignored
 * the same way. Which style an endpoint uses is a property of that endpoint,
 * recorded on each method.
 */

/**
 * The `meta.page` object every offset-paginated collection returns.
 *
 * Field names are the server's own (`number`, `size`, `total`, `totalPages`) —
 * note that `totalPages` is camelCase while every sibling is lowercase; that is
 * the server's spelling (`#[serde(rename = "totalPages")]`), not a typo here.
 */
export interface OffsetPageMeta {
  /** 1-based page number, after the server floors it to at least 1. */
  number: number;
  /** Page size, after the server clamps it to `[1, 100]`. */
  size: number;
  /** Rows matching the request's filters — **not** the size of the whole table. */
  total: number;
  /** Ceiling of `total / size`; `0` when `total` is `0`. */
  totalPages: number;
}

/** One page of an offset-paginated collection: the rows plus {@link OffsetPageMeta}. */
export interface OffsetPage<T> {
  /** The rows on this page. */
  items: T[];
  /** Where this page sits in the filtered result set. */
  page: OffsetPageMeta;
}

/**
 * Reads a `meta.page` object off a response, degrading rather than throwing
 * when it is missing or malformed.
 *
 * A list call must not fail because the envelope's bookkeeping changed shape.
 * When `meta.page` cannot be read, the returned meta describes exactly what
 * was received — the requested page and size, `total` set to the row count on
 * this page, and `totalPages` set to `1` — which keeps a `for` loop over
 * `totalPages` terminating instead of spinning.
 *
 * @internal
 */
export function readOffsetPageMeta(
  meta: unknown,
  itemCount: number,
  requestedPage: number,
  requestedSize: number,
): OffsetPageMeta {
  const page = (meta as { page?: unknown } | undefined)?.page;
  if (typeof page !== "object" || page === null) {
    return { number: requestedPage, size: requestedSize, total: itemCount, totalPages: 1 };
  }
  const raw = page as Record<string, unknown>;
  return {
    number: numberOr(raw.number, requestedPage),
    size: numberOr(raw.size, requestedSize),
    total: numberOr(raw.total, itemCount),
    totalPages: numberOr(raw.totalPages, 1),
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
