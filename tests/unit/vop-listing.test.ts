import { describe, expect, it } from "vitest";
import { VipClient } from "../../apps/api/src/integrations/vip/client.js";
import {
  adaptListingResponse,
  queryListing,
} from "../../apps/api/src/integrations/vip/listing.js";

describe("official barcode listing contract", () => {
  it("uses the documented request names without an OAuth token", async () => {
    let body: any;
    let url: URL | undefined;
    const client = new VipClient(
      {
        appKey: "test",
        appSecret: "test-only",
        vendorId: 123,
        requestIp: "127.0.0.1",
      },
      async (input, init) => {
        url = new URL(String(input));
        body = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            returnCode: "0",
            result: { abc: { code: 200, listing_status: 1 } },
          }),
        );
      },
    );
    const [value] = await queryListing(client, ["ABC"]);
    expect(body).toEqual({
      req_context: { vendor_code: 123 },
      barcode_listing_req: { barcode_list: ["ABC"] },
    });
    expect(url?.searchParams.get("method")).toBe(
      "queryConsignmentBarcodeListingInfo",
    );
    expect(url?.searchParams.has("accessToken")).toBe(false);
    expect(value.state).toBe("LISTED");
  });
  it("correlates lowercase keys, preserves leading-zero long barcodes and handles the SDK wrapper", () => {
    const values = adaptListingResponse(
      {
        success: {
          abc: { barcode: "abc", code: 200, listing_status: 0 },
          "0012345678901234567890": { code: 200, listing_status: 1 },
        },
      },
      ["0012345678901234567890", "ABC"],
    );
    expect(values.map((v) => [v.barcodeKey, v.state])).toEqual([
      ["0012345678901234567890", "LISTED"],
      ["abc", "UNLISTED"],
    ]);
  });
  it("does not classify missing, rejected, unpublished or not-found records as offline", () => {
    const values = adaptListingResponse(
      {
        notfound: { code: 404, listing_status: 0 },
        unpublished: { code: 500, listing_status: 0 },
        rejected: { code: 9999, listing_status: 0 },
        bad: { code: 200, listing_status: 9 },
      },
      ["notfound", "unpublished", "rejected", "bad", "missing"],
    );
    expect(values.map((v) => v.state)).toEqual([
      "NOT_FOUND",
      "UNPUBLISHED",
      "UNKNOWN",
      "UNKNOWN",
      "UNKNOWN",
    ]);
    expect(values.slice(2).every((v) => v.error)).toBe(true);
  });
  it("rejects ambiguous case aliases and invalid/mismatched response records", () => {
    expect(() => adaptListingResponse({ ABC: {}, abc: {} }, ["ABC"])).toThrow(
      "LISTING_RESPONSE_AMBIGUOUS",
    );
    expect(() => adaptListingResponse([], ["ABC"])).toThrow(
      "LISTING_RESPONSE_INVALID",
    );
    expect(
      adaptListingResponse(
        { abc: { barcode: "other", code: 200, listing_status: 1 } },
        ["ABC"],
      )[0].error,
    ).toBe("LISTING_RECORD_INVALID");
  });
  it("keeps raw milliseconds and leaves uncertain time units unresolved", () => {
    const now = Date.now() - 1000;
    const values = adaptListingResponse(
      {
        valid: {
          code: 200,
          listing_status: 1,
          last_status_change_time: String(now),
          last_status_change_type: "LISTED",
        },
        ambiguous: {
          code: 200,
          listing_status: 0,
          last_status_change_time: Math.floor(now / 1000),
        },
        never: {
          code: 200,
          listing_status: 0,
          last_status_change_time: 0,
          last_status_change_type: "",
        },
      },
      ["valid", "ambiguous", "never"],
    );
    expect(values[0].lastChangedAt?.getTime()).toBe(now);
    expect(values[0].lastChangeTime).toBe(now);
    expect(values[1].lastChangedAt).toBeNull();
    expect(values[1].timeWarning).toBe("LISTING_TIME_UNVERIFIED");
    expect(values[2].lastChangedAt).toBeNull();
    expect(values[2].lastChangeTime).toBe(0);
  });
  it("discards provider messages and unrelated response fields", () => {
    const value = adaptListingResponse(
      {
        abc: {
          code: 200,
          listing_status: 1,
          message: "private provider text",
          extra: "unused",
        },
      },
      ["ABC"],
    )[0];
    expect(JSON.stringify(value)).not.toContain("private provider text");
    expect(JSON.stringify(value)).not.toContain("unused");
  });
});
