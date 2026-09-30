import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// Isolated S3 protocol fixture. Never contacts the configured production bucket.
export async function imageStore() {
  const objects = new Map<string, Buffer>();
  let reads = 0, unavailable = false;
  const server = createServer(async (req, res) => {
    const key = new URL(req.url!, "http://localhost").pathname;
    if (unavailable) { res.writeHead(503); res.end(); return; }
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
      res.writeHead(200, { ETag: '"test-etag"' }); res.end();
    } else if (req.method === "GET" && objects.has(key)) {
      reads++; res.writeHead(200, { "Content-Type": "image/png" }); res.end(objects.get(key));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  Object.assign(process.env, {
    AWS_ENDPOINT_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    AWS_S3_BUCKET_NAME: "isolated-test-images", AWS_ACCESS_KEY_ID: "test-access", AWS_SECRET_ACCESS_KEY: "test-secret", AWS_DEFAULT_REGION: "us-east-1",
  });
  return { objects, reads: () => reads, setUnavailable: (value: boolean) => { unavailable = value; }, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
