import { z } from "zod";
import { VipClient, VipError } from "./client.js";

export const listingService =
  "com.vip.somp.sales.backend.service.SalesVopService";
export const listingMethod = "queryConsignmentBarcodeListingInfo";
export const listingDocumentation = `https://vop.vip.com/home#/api/method/detail/${listingService}-1.0.0/${listingMethod}`;
export const listingRequestSchema = z
  .object({ namespace: z.string().min(1).max(255) })
  .strict();
export const listingStates = [
  "LISTED",
  "UNLISTED",
  "PARTIAL",
  "UNPUBLISHED",
  "NOT_FOUND",
  "UNKNOWN",
] as const;
export const listingCatalogQuerySchema = z.object({
  state: z.enum(listingStates).optional(),
});
const observationSchema = z.object({
  barcode: z.string().min(1).max(1000).nullish(),
  code: z.number().int(),
  listing_status: z.number().int().nullish(),
  last_status_change_type: z.string().max(50).nullish(),
  last_status_change_time: z
    .union([
      z.number().int().nonnegative().safe(),
      z
        .string()
        .regex(/^\d{1,15}$/)
        .transform(Number),
    ])
    .nullish(),
});
export type ListingObservation = {
  barcodeKey: string;
  state: "UNKNOWN" | "LISTED" | "UNLISTED" | "UNPUBLISHED" | "NOT_FOUND";
  resultCode: number | null;
  listingStatus: number | null;
  lastChangeType: string | null;
  lastChangeTime: number | null;
  lastChangedAt: Date | null;
  timeWarning: string | null;
  error: string | null;
};
export const barcodeKey = (value: string) => value.toLowerCase();

/** Correlate by the documented lowercase map key, never by response order. */
export function adaptListingResponse(
  raw: unknown,
  requested: string[],
): ListingObservation[] {
  const object = z.record(z.string().max(1000), z.unknown()).safeParse(raw);
  if (!object.success) throw new VipError("LISTING_RESPONSE_INVALID");
  // The official test tool uses a Thrift success wrapper; HTTP result maps may be direct.
  const map =
    Object.keys(object.data).length === 1 &&
    Object.hasOwn(object.data, "success")
      ? z
          .record(z.string().max(1000), z.unknown())
          .safeParse(object.data.success)
      : object;
  if (!map.success) throw new VipError("LISTING_RESPONSE_INVALID");
  const entries = new Map<string, unknown>();
  for (const [key, value] of Object.entries(map.data)) {
    const normalized = barcodeKey(key);
    if (entries.has(normalized))
      throw new VipError("LISTING_RESPONSE_AMBIGUOUS");
    entries.set(normalized, value);
  }
  return requested.map((barcode) => {
    const key = barcodeKey(barcode);
    const result: ListingObservation = {
      barcodeKey: key,
      state: "UNKNOWN",
      resultCode: null,
      listingStatus: null,
      lastChangeType: null,
      lastChangeTime: null,
      lastChangedAt: null,
      timeWarning: null,
      error: null,
    };
    if (!entries.has(key))
      return { ...result, error: "LISTING_RESULT_MISSING" };
    const parsed = observationSchema.safeParse(entries.get(key));
    if (
      !parsed.success ||
      (parsed.data.barcode && barcodeKey(parsed.data.barcode) !== key)
    )
      return { ...result, error: "LISTING_RECORD_INVALID" };
    const v = parsed.data;
    result.resultCode = v.code;
    if (v.code === 404) return { ...result, state: "NOT_FOUND" };
    if (v.code === 500) return { ...result, state: "UNPUBLISHED" };
    if (v.code !== 200) return { ...result, error: "LISTING_RESULT_REJECTED" };
    if (![0, 1].includes(v.listing_status ?? -1))
      return { ...result, error: "LISTING_RECORD_INVALID" };
    result.listingStatus = v.listing_status!;
    result.state = v.listing_status === 1 ? "LISTED" : "UNLISTED";
    result.lastChangeType = ["LISTED", "UNLISTED"].includes(
      v.last_status_change_type || "",
    )
      ? v.last_status_change_type!
      : null;
    result.lastChangeTime = v.last_status_change_time ?? null;
    // The untranslated official HTTP example specifies milliseconds. Keep the raw value;
    // conflicting/implausible time units must not fabricate a last-change date.
    if (
      result.lastChangeTime &&
      result.lastChangeTime >= 946684800000 &&
      result.lastChangeTime <= Date.now() + 86400000
    )
      result.lastChangedAt = new Date(result.lastChangeTime);
    else if (result.lastChangeTime)
      result.timeWarning = "LISTING_TIME_UNVERIFIED";
    return result;
  });
}

export async function queryListing(
  client: VipClient,
  barcodes: string[],
  accessToken?: string,
) {
  const requested = [...new Set(barcodes)];
  if (
    !requested.length ||
    requested.length > 50 ||
    requested.some((value) => !value || value.length > 1000)
  )
    throw new VipError("LISTING_REQUEST_INVALID");
  const response = await client.call(
    listingService,
    listingMethod,
    {
      req_context: { vendor_code: client.credentials.vendorId },
      barcode_listing_req: { barcode_list: requested },
    },
    accessToken,
  ); // The documented optional token is reused when the current connection has valid authorization.
  return adaptListingResponse(response, requested);
}

export { syncListing } from "./listing-sync.js";
