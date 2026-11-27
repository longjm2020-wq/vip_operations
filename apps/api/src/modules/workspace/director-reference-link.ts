import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename } from "node:path";
import { z } from "zod";
import {
  browserPublicAddress,
  publicBrowserUrl,
} from "../../../../../packages/contracts/src/public-network.js";
import { directorAssetLimit } from "../../../../../packages/contracts/src/director.js";
import { fail, parse, type Context } from "../../core.js";
import { RAW_VIDEO_BYTES, storeUploadedAgentFile } from "./agent-files.js";
import { readDirectorProject } from "./director.js";
import {
  referencePageMedia,
  shareTextUrl,
  socialWork,
} from "./director-reference-page.js";

const pageLimit = 2 * 1024 * 1024;
const unavailable =
  "未能从链接取得公开视频。若作品需要登录、已失效或仅支持在线播放，请上传可用的视频原文件。";
const shareBody = z.object({ text: z.string().trim().min(1).max(8192) });
const redirects = new Set([301, 302, 303, 307, 308]);

// Keep the URL host for TLS/SNI. Supply the checked IPs directly to the socket,
// use a fresh connection per hop, and never pass account credentials.
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
          "User-Agent": "XUTI-Director/1.0",
        },
        lookup(host, options, callback) {
          lookup(host, { all: true })
            .then((addresses) => {
              if (
                !addresses.length ||
                addresses.some((entry) => !browserPublicAddress(entry.address))
              )
                throw Error("只支持公开网络上的作品。");
              if (options.all) callback(null, addresses);
              else callback(null, addresses[0].address, addresses[0].family);
            })
            .catch((error) => callback(error, "", 0));
        },
      },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
}

function mediaExtension(data: Buffer) {
  if (data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))
    return ".webm";
  if (data.subarray(4, 8).toString() === "ftyp")
    return data.subarray(8, 12).toString() === "qt  " ? ".mov" : ".mp4";
  return "";
}

type ReadUrl = typeof requestPublicUrl;

async function readShareUrl(
  raw: string,
  signal: AbortSignal,
  request: ReadUrl,
  budget: { bytes: number },
) {
  let url = publicBrowserUrl(raw);
  for (let hop = 0; hop <= 4; hop++) {
    signal.throwIfAborted();
    const response = await request(url, signal);
    try {
      const status = response.statusCode ?? 0;
      if (redirects.has(status) && response.headers.location) {
        url = publicBrowserUrl(new URL(response.headers.location, url).href);
        continue;
      }
      if (
        status !== 200 ||
        (response.headers["content-encoding"] &&
          response.headers["content-encoding"] !== "identity")
      )
        throw Error(unavailable);
      const contentType = String(response.headers["content-type"] || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      let limit = /^(text\/|application\/(?:xhtml\+xml|json))/.test(contentType)
        ? pageLimit
        : RAW_VIDEO_BYTES;
      if (
        Number(response.headers["content-length"]) >
        Math.min(limit, budget.bytes)
      )
        throw Error("作品页面或视频超过导入上限，请下载后从本机导入。");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response) {
        signal.throwIfAborted();
        const data: Buffer = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk);
        if (
          !size &&
          data.subarray(0, 128).toString().trimStart().startsWith("<")
        )
          limit = pageLimit;
        size += data.length;
        budget.bytes -= data.length;
        if (size > limit || budget.bytes < 0)
          throw Error("作品页面或视频超过导入上限，请下载后从本机导入。");
        chunks.push(data);
      }
      const content = Buffer.concat(chunks, size);
      return { content, url, ext: mediaExtension(content) };
    } finally {
      response.destroy();
    }
  }
  throw Error(unavailable);
}

export async function downloadDirectorReference(
  text: string,
  request: ReadUrl = requestPublicUrl,
) {
  const url = shareTextUrl(text);
  const signal = AbortSignal.timeout(60_000);
  const budget = { bytes: RAW_VIDEO_BYTES + pageLimit };
  let media = await readShareUrl(url.href, signal, request, budget);
  let title = "";
  if (!media.ext) {
    if (media.content.length > pageLimit) throw Error(unavailable);
    const original = socialWork(url),
      resolved = socialWork(media.url);
    if (
      original &&
      (resolved?.platform !== original.platform ||
        (original.id && resolved.id !== original.id))
    )
      throw Error(unavailable);
    const page = referencePageMedia(media.content.toString("utf8"), media.url);
    title = page.title;
    for (const link of page.urls) {
      signal.throwIfAborted();
      try {
        const candidate = await readShareUrl(link, signal, request, budget);
        if (candidate.ext) {
          media = candidate;
          break;
        }
      } catch {
        /* A public page may publish multiple formats or an expired CDN URL. */
      }
    }
  }
  if (!media.ext) throw Error(unavailable);
  if (!title) {
    const file = basename(media.url.pathname);
    try {
      title = decodeURIComponent(file);
    } catch {
      title = file;
    }
  }
  const safeName = title
    .replace(/\.(mp4|mov|webm)$/i, "")
    .replace(/[\u0000-\u001f\\/:*?"<>|]/g, " ")
    .trim()
    .slice(0, 120);
  return {
    name: (safeName || "作品参考片") + media.ext,
    content: media.content,
  };
}

export async function importDirectorReferenceLink(
  c: Context,
  id: string,
  body: unknown,
) {
  const { text } = parse(shareBody, body);
  const project = await readDirectorProject(c, id);
  if (project.assets.length >= directorAssetLimit)
    fail("DIRECTOR_ASSET_LIMIT", "项目素材已满，请移出素材或新建项目。", 409);
  const incoming = await downloadDirectorReference(text).catch(
    (error: unknown) => {
      const msg =
        error instanceof Error &&
        /^(请粘贴|作品链接须|作品页面或视频超过)/.test(error.message)
          ? error.message
          : unavailable;
      return fail("DIRECTOR_REFERENCE_LINK", msg, 400);
    },
  );
  return storeUploadedAgentFile(c, incoming, true);
}
