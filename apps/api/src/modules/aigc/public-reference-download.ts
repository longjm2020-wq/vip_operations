import { lookup } from "node:dns/promises";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  browserPublicAddress,
  publicBrowserUrl,
} from "../../../../../packages/contracts/src/public-network.js";
import { runMedia } from "../workspace/agent-media.js";
import {
  referencePageMedia,
  shareTextUrl,
  socialWork,
} from "./public-reference-page.js";

const pageLimit = 2 * 1024 * 1024;
const redirects = new Set([301, 302, 303, 307, 308]);
const unavailable =
  "未能从链接取得可读取的公开视频。请从本机上传原视频继续拆解。";
const sizeLimit = "作品页面或视频超过当前导入上限，请裁剪后从本机上传。";
const fail = (message: string, statusCode = 422) =>
  Object.assign(new Error(message), { statusCode });

/** Pin each socket to DNS answers validated for the exact host of the current hop. */
function requestPublicUrl(
  url: URL,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        agent: false,
        signal,
        maxHeaderSize: 32 * 1024,
        headers: {
          Accept: "video/*,text/html,application/octet-stream",
          "Accept-Encoding": "identity",
          "User-Agent": "XUTI-AIGC-Reference/1.0",
        },
        lookup(host, options, callback) {
          lookup(host, { all: true })
            .then((addresses) => {
              if (
                !addresses.length ||
                addresses.some(
                  (address) => !browserPublicAddress(address.address),
                )
              )
                throw fail(unavailable);
              if (options.all) callback(null, addresses);
              else callback(null, addresses[0].address, addresses[0].family);
            })
            .catch((error) => callback(error, "", 0));
        },
      },
      resolve,
    );
    req.once("error", reject);
    req.end();
  });
}

type Format = { extension: string; mime: string; demuxer: "mov" | "matroska" };
const ebmlMagic = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

function videoFormat(data: Buffer): Format | undefined {
  if (data.subarray(0, 4).equals(ebmlMagic))
    return { extension: ".webm", mime: "video/webm", demuxer: "matroska" };
  if (data.toString("ascii", 4, 8) === "ftyp") {
    return data.toString("ascii", 8, 12) === "qt  "
      ? { extension: ".mov", mime: "video/quicktime", demuxer: "mov" }
      : { extension: ".mp4", mime: "video/mp4", demuxer: "mov" };
  }
}

type ReadUrl = typeof requestPublicUrl;
type ReadResult = { url: URL; format: Format } | { url: URL; html: string };
type Transfer = {
  target: string;
  maxBytes: number;
  remainingBytes: number;
  signal: AbortSignal;
  request: ReadUrl;
};

async function readUrl(
  raw: string,
  transfer: Transfer,
  allowPage: boolean,
): Promise<ReadResult> {
  let url = publicBrowserUrl(raw);
  const { signal } = transfer;
  for (let hop = 0; hop <= 4; hop++) {
    signal.throwIfAborted();
    const response = await transfer.request(url, signal);
    try {
      if (
        redirects.has(response.statusCode ?? 0) &&
        response.headers.location
      ) {
        url = publicBrowserUrl(new URL(response.headers.location, url).href);
        continue;
      }
      if (
        response.statusCode !== 200 ||
        (response.headers["content-encoding"] &&
          response.headers["content-encoding"] !== "identity")
      )
        throw fail(unavailable);

      const advertisedSize = Number(response.headers["content-length"]);
      if (
        advertisedSize >
        Math.min(
          Math.max(transfer.maxBytes, pageLimit),
          transfer.remainingBytes,
        )
      )
        throw fail(sizeLimit, 413);

      const reader = response[Symbol.asyncIterator]();
      const initial: Buffer[] = [];
      let initialBytes = 0;
      // Read the container signature even if it spans several network chunks.
      while (initialBytes < 12) {
        const next = await reader.next();
        if (next.done) break;
        const bytes = Buffer.from(next.value);
        if (!bytes.length) continue;
        initial.push(bytes);
        initialBytes += bytes.length;
      }
      const prefix = Buffer.concat(initial);
      const format = videoFormat(prefix);
      const contentType = String(
        response.headers["content-type"] ?? "",
      ).toLowerCase();
      const page =
        allowPage &&
        (/^(text\/|application\/xhtml\+xml)/.test(contentType) ||
          prefix.subarray(0, 128).toString("utf8").trimStart().startsWith("<"));
      if (!format && !page) throw fail(unavailable);
      const limit = format ? transfer.maxBytes : pageLimit;
      if (advertisedSize > Math.min(limit, transfer.remainingBytes))
        throw fail(sizeLimit, 413);

      let size = 0;
      async function* boundedBody() {
        async function* source() {
          yield* initial;
          for (
            let next = await reader.next();
            !next.done;
            next = await reader.next()
          ) {
            yield Buffer.from(next.value);
          }
        }
        for await (const bytes of source()) {
          signal.throwIfAborted();
          size += bytes.length;
          transfer.remainingBytes -= bytes.length;
          if (size > limit || transfer.remainingBytes < 0)
            throw fail(sizeLimit, 413);
          yield bytes;
        }
      }
      if (format) {
        await pipeline(
          boundedBody(),
          createWriteStream(transfer.target, { flags: "wx", mode: 0o600 }),
          { signal },
        );
        return { url, format };
      }
      const html = await Readable.from(boundedBody()).toArray();
      return { url, html: Buffer.concat(html).toString("utf8") };
    } finally {
      response.destroy();
    }
  }
  throw fail(unavailable);
}

function originalFileName(url: URL) {
  const name = url.pathname.split("/").at(-1) || "";
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** Download a bounded public clip directly to the private upload staging path. */
export async function downloadPublicReference(
  text: string,
  target: string,
  maxBytes: number,
  callerSignal: AbortSignal,
  request: ReadUrl = requestPublicUrl,
) {
  let originalUrl: URL;
  try {
    originalUrl = shareTextUrl(text);
  } catch (error) {
    throw fail((error as Error).message, 400);
  }
  const downloadSignal = AbortSignal.any([
    callerSignal,
    AbortSignal.timeout(45_000),
  ]);
  const transfer = {
    target,
    maxBytes,
    remainingBytes: maxBytes + pageLimit,
    signal: downloadSignal,
    request,
  };
  let media: Extract<ReadResult, { format: Format }> | undefined;
  let title = "";
  try {
    const response = await readUrl(originalUrl.href, transfer, true);
    if ("format" in response) media = response;
    else {
      const original = socialWork(originalUrl);
      const resolved = socialWork(response.url);
      if (
        original &&
        (resolved?.platform !== original.platform ||
          !resolved.id ||
          (original.id && original.id !== resolved.id))
      )
        throw fail(unavailable);
      const page = referencePageMedia(response.html, response.url);
      title = page.title;
      let tooLarge = false;
      for (const link of page.urls) {
        downloadSignal.throwIfAborted();
        try {
          const candidate = await readUrl(link, transfer, false);
          if ("format" in candidate) {
            media = candidate;
            break;
          }
        } catch (error) {
          await unlink(target).catch(() => undefined);
          if ((error as { statusCode?: number }).statusCode === 413)
            tooLarge = true;
          if (transfer.remainingBytes <= 0) throw error;
        }
      }
      if (!media && tooLarge) throw fail(sizeLimit, 413);
    }
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 413)
      throw fail(sizeLimit, 413);
    throw fail(unavailable);
  }
  if (!media) throw fail(unavailable);

  // A playable video stream is required. Disable other input formats and URLs.
  try {
    const log = await runMedia(
      [
        "-protocol_whitelist",
        "file,pipe",
        "-f",
        media.format.demuxer,
        "-max_pixels",
        String(4096 * 2160),
        "-threads",
        "1",
        "-i",
        target,
        "-map",
        "0:V:0",
        "-frames:v",
        "1",
        "-an",
        "-f",
        "null",
        "-",
      ],
      callerSignal,
      15_000,
    );
    const parts = log.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
    const seconds =
      parts &&
      Number(parts[1]) * 3600 + Number(parts[2]) * 60 + Number(parts[3]);
    if (!seconds || seconds > 1800) throw new Error("invalid video duration");
  } catch {
    throw fail(
      "参考片需要可解码的视频画面，且时长不超过 30 分钟。请检查原视频后从本机上传。",
    );
  }
  const name =
    (title || originalFileName(media.url))
      .replace(/\.(mp4|mov|webm|m4v)$/i, "")
      .replace(/[\u0000-\u001f\\/:*?"<>|%]/g, " ")
      .trim()
      .slice(0, 110) || "作品参考片";
  return { name: name + media.format.extension, mime: media.format.mime };
}
