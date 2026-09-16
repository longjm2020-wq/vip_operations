import { beforeEach, expect, it, vi } from "vitest";
const send = vi.hoisted(() => vi.fn());
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = send;
    destroy() {}
  },
  PutObjectCommand: class {
    constructor(public input: unknown) {}
  },
  GetObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));
import {
  storeFiles,
  assertReferences,
} from "../../apps/api/src/modules/projects/storage.js";
import { attachmentsSchema } from "../../packages/contracts/src/project-attachments.js";
const file = {
  id: "51b8a044-786a-4b31-8500-e1c6c58586cd",
  name: "notes.txt",
  type: "text/plain",
  size: 5,
  data: "data:text/plain;base64,aGVsbG8=",
};
beforeEach(() => {
  vi.stubEnv("AWS_S3_BUCKET_NAME", "test");
  vi.stubEnv("AWS_ENDPOINT_URL", "https://example.invalid");
  vi.stubEnv("AWS_ACCESS_KEY_ID", "test");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test");
  send.mockReset();
  send.mockResolvedValue({});
});
it("uploads bytes and stores only a validated immutable reference", async () => {
  const [stored] = await storeFiles([file], "1");
  expect(send.mock.calls[0][0].input.Body.toString()).toBe("hello");
  expect(stored.data).toBe("");
  expect(stored.storageKey).toMatch(/^projects\/1\//);
  expect(attachmentsSchema.safeParse([stored]).success).toBe(true);
  expect(() => assertReferences([stored], [])).toThrow();
  expect(() =>
    assertReferences([{ ...stored, name: "other.txt" }], [stored]),
  ).toThrow();
  expect(() => assertReferences([stored], [stored])).not.toThrow();
  await storeFiles([stored], "2");
  expect(send).toHaveBeenCalledTimes(1);
  const [retry] = await storeFiles([file], "1");
  expect(retry.storageKey).toBe(stored.storageKey);
});
it("fails closed on a bucket upload failure", async () => {
  send.mockRejectedValue(new Error("offline"));
  await expect(storeFiles([file], "1")).rejects.toThrow();
});
it("keeps legacy local files when bucket is not configured", async () => {
  vi.stubEnv("AWS_S3_BUCKET_NAME", "");
  expect(await storeFiles([file], "1")).toEqual([file]);
  expect(send).not.toHaveBeenCalled();
});
