import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
const destination = path.resolve("dist/packages/aigc-engine");
await mkdir(destination, { recursive: true });
await cp(path.resolve("packages/aigc-engine"), destination, {
  recursive: true,
});
