import { describe, expect, it } from "vitest";
import { adaptDetail } from "../../apps/api/src/integrations/vip/details.js";

describe("VIP detail image sources", () => {
  it("keeps product pictures separate from shared SPU pictures and displays product pictures first", () => {
    const pink = "https://a.vpimg4.com/pink.jpg";
    const shared = "https://b.vpimg2.com/style.jpg";
    const detail = adaptDetail(
      {
        vendor_id: 1,
        barcode: "000123",
        product_image: ` ${pink};${pink};http://b.vpimg2.com/back.jpg; ;https://unapproved.example/picture.jpg;javascript:alert(1)`,
        spu_image_list: [{ image_url: shared }, { image_url: pink }],
      },
      1,
    );
    expect(detail.barcode).toBe("000123");
    expect(detail.productImages).toEqual([
      pink,
      "https://b.vpimg2.com/back.jpg",
    ]);
    expect(detail.styleImages).toEqual([shared, pink]);
    expect(detail.images).toEqual([
      pink,
      "https://b.vpimg2.com/back.jpg",
      shared,
    ]);
  });

  it("does not treat a SPU picture as a product picture when the product image is absent", () => {
    const shared = "https://a.vpimg4.com/style.jpg";
    const detail = adaptDetail(
      { vendor_id: 1, barcode: "001", spu_image_list: [{ image_url: shared }] },
      1,
    );
    expect(detail.productImages).toEqual([]);
    expect(detail.styleImages).toEqual([shared]);
    expect(detail.images).toEqual([shared]);
    expect(adaptDetail({ vendor_id: 1, barcode: "002" }, 1).images).toEqual([]);
  });
});
