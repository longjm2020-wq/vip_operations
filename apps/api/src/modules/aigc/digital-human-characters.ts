import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import Busboy from "busboy";
import sharp from "sharp";
import type { Studio } from "../../../../../packages/aigc-engine/index.mjs";
import {
  upsertDigitalHumanCharacterSchema,
  type DigitalHumanCharacter,
  type WorkflowCharacterAngle,
} from "../../../../../packages/contracts/src/commerce-talk-workflow.js";
import {
  db,
  one,
  rows,
  type Row,
} from "../../../../../packages/database/src/index.js";
import { fail, parse, type Actor } from "../../core.js";
import { maxAssetBytes } from "./persistence.js";

const assetUrl = (assetId?: string | null) =>
  assetId ? `/api/v1/aigc/assets/${assetId}` : undefined;

const validViewSlots = ["face", "front", "back", "side"] as const;
type ViewSlot = (typeof validViewSlots)[number];

/** 将数据库行转换为前端安全视图 */
export function characterView(row: Row): DigitalHumanCharacter {
  const faceAssetId = (row.face_asset_id as string) || undefined;
  const frontAssetId = (row.front_asset_id as string) || undefined;
  const backAssetId = (row.back_asset_id as string) || undefined;
  const sideAssetId = (row.side_asset_id as string) || undefined;
  return {
    id: String(row.id),
    name: String(row.name),
    persona: String(row.persona || ""),
    faceAssetId,
    frontAssetId,
    backAssetId,
    sideAssetId,
    faceUrl: assetUrl(faceAssetId),
    frontUrl: assetUrl(frontAssetId),
    backUrl: assetUrl(backAssetId),
    sideUrl: assetUrl(sideAssetId),
    voiceId: String(row.voice_id || ""),
    voiceName: String(row.voice_name || ""),
    voiceProvider: String(row.voice_provider || ""),
    voiceModel: String(row.voice_model || ""),
    authorized: Boolean(row.authorized),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** 列出当前账号的全部数字人角色 */
export async function listDigitalHumanCharacters(
  actor: Actor,
): Promise<DigitalHumanCharacter[]> {
  const list = await rows(
    db,
    `SELECT * FROM public.digital_human_characters
     WHERE user_id=$1::bigint
     ORDER BY updated_at DESC
     LIMIT 50`,
    actor.id,
  );
  return list.map(characterView);
}

/** 按 ID 批量加载当前账号的数字人角色 */
export async function loadDigitalHumanCharactersByIds(
  actor: Actor,
  ids: readonly string[],
): Promise<DigitalHumanCharacter[]> {
  const clean = [...new Set(ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id)))];
  if (!clean.length) return [];
  const list = await rows(
    db,
    `SELECT * FROM public.digital_human_characters
     WHERE user_id=$1::bigint AND id = ANY($2::uuid[])`,
    actor.id,
    clean,
  );
  return list.map(characterView);
}

/**
 * 按分镜出镜视角智能挑选该数字人角色的最优视图参考组合（面部 + 对应正/背/侧三视图），
 * 保障跨角度、跨场景出镜时面部特征与身形穿搭高度一致。
 */
export function pickCharacterViewAssetIds(
  character: DigitalHumanCharacter,
  angle: WorkflowCharacterAngle = "auto",
): string[] {
  const { faceAssetId, frontAssetId, backAssetId, sideAssetId } = character;
  let ordered: Array<string | undefined>;
  switch (angle) {
    case "back_turn":
      ordered = [backAssetId, faceAssetId, sideAssetId, frontAssetId];
      break;
    case "side_profile":
      ordered = [sideAssetId, faceAssetId, frontAssetId, backAssetId];
      break;
    case "front_closeup":
      ordered = [faceAssetId, frontAssetId, sideAssetId];
      break;
    case "walking_full":
      ordered = [frontAssetId, faceAssetId, sideAssetId, backAssetId];
      break;
    case "over_shoulder":
      ordered = [sideAssetId, backAssetId, faceAssetId, frontAssetId];
      break;
    case "front_medium":
    case "auto":
    default:
      ordered = [faceAssetId, frontAssetId, sideAssetId, backAssetId];
      break;
  }
  return [...new Set(ordered.filter((id): id is string => Boolean(id)))];
}

/** 将出镜视角枚举转换为精准的影视机位与人物朝向提示词 */
export function characterAnglePromptHint(
  angle: WorkflowCharacterAngle = "auto",
): string {
  switch (angle) {
    case "front_closeup":
      return "正面近景特写，清晰展现面部神态、妆容与领口肩部细节";
    case "front_medium":
      return "正面中景自然站姿或微侧身讲解，展示上半身穿搭版型与手势互动";
    case "side_profile":
      return "45度至90度侧面轮廓机位，立体呈现服装侧身剪裁、腰线与袖型";
    case "back_turn":
      return "背面展示或转身回眸机位，清晰展示背部剪裁设计、后摆垂感与自然回头神态";
    case "walking_full":
      return "全身动态走位跟拍，人物自然行走转身展示服装整体垂坠与下摆飘动";
    case "over_shoulder":
      return "过肩视角或对镜自拍构图，增强第一人称穿搭代入感与真实氛围";
    case "auto":
    default:
      return "根据脚本自然切换机位与人物朝向，避免呆板固定角度";
  }
}

async function ownedCharacter(actor: Actor, id: string): Promise<Row> {
  const row = await one(
    db,
    "SELECT * FROM public.digital_human_characters WHERE id=$1::uuid AND user_id=$2::bigint",
    id,
    actor.id,
  );
  if (!row) fail("CHARACTER_NOT_FOUND", "找不到该数字人角色", 404);
  return row;
}

/** multipart 上传角色的面部 / 正面 / 背面 / 侧面视图 */
async function uploadCharacterView(
  studio: Studio,
  actor: Actor,
  character: Row,
  req: Request,
) {
  const maxBytes = Math.min(maxAssetBytes(), 20 * 1024 * 1024);
  const fields: Record<string, string> = {};
  let uploaded: { filename: string; mime: string; buffer: Buffer } | undefined;

  await new Promise<void>((resolve, reject) => {
    const bb = Busboy({
      headers: req.headers,
      limits: { fileSize: maxBytes, files: 1, fields: 8 },
    });
    bb.on("field", (name, val) => {
      fields[name] = String(val).slice(0, 120);
    });
    bb.on("file", (_name, stream, info) => {
      const chunks: Buffer[] = [];
      let truncated = false;
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("limit", () => {
        truncated = true;
      });
      stream.on("end", () => {
        if (truncated) {
          reject(
            Object.assign(new Error("角色视图图片须小于 20 MB"), {
              statusCode: 413,
            }),
          );
          return;
        }
        uploaded = {
          filename: info.filename || "view.png",
          mime: info.mimeType || "image/png",
          buffer: Buffer.concat(chunks),
        };
      });
    });
    bb.on("error", reject);
    bb.on("finish", resolve);
    req.pipe(bb);
  });

  const slot = fields.slot as ViewSlot;
  if (!validViewSlots.includes(slot)) {
    fail("INVALID_VIEW_SLOT", "无效的视图类型（须为 face / front / back / side）", 400);
  }
  if (!uploaded || !uploaded.buffer.length) {
    fail("EMPTY_FILE", "请上传有效的角色视图图片", 400);
  }

  // 使用 sharp 验证为合法图片并规范方向
  let normalized: Buffer;
  try {
    const meta = await sharp(uploaded.buffer, {
      limitInputPixels: 100_000_000,
    }).metadata();
    if (!meta.format || !["jpeg", "png", "webp"].includes(meta.format)) {
      throw Error("unsupported");
    }
    normalized = await sharp(uploaded.buffer, { limitInputPixels: 100_000_000 })
      .autoOrient()
      .resize({
        width: 2048,
        height: 2048,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
  } catch {
    fail("INVALID_IMAGE", "角色视图须为有效的 JPG、PNG 或 WebP 图片", 400);
  }

  const asset = await studio.store.putAsset({
    buffer: normalized,
    name: `${String(character.name)}-${slot}.png`,
    kind: `character_view_${slot}`,
    mime: "image/png",
    ownerId: actor.id,
    projectId: String(character.id),
    source: `digital-human-character:${character.id}:${slot}`,
  });

  const column =
    slot === "face"
      ? "face_asset_id"
      : slot === "front"
        ? "front_asset_id"
        : slot === "back"
          ? "back_asset_id"
          : "side_asset_id";

  const updated = await one(
    db,
    `UPDATE public.digital_human_characters
     SET ${column}=$2::uuid, updated_at=now()
     WHERE id=$1::uuid RETURNING *`,
    character.id,
    asset.path,
  );
  return { character: characterView(updated!), slot, assetId: asset.path };
}

/** 数字人角色库 REST API 路由处理（挂载于 /api/v1/aigc/commerce-video/characters） */
export async function handleDigitalHumanCharacters(
  studio: Studio,
  actor: Actor,
  suffix: string,
  req: Request,
  res: Response,
  readBody: () => Promise<unknown>,
) {
  if (suffix === "/characters" && req.method === "GET") {
    const characters = await listDigitalHumanCharacters(actor);
    return res.json({ characters });
  }

  if (suffix === "/characters" && req.method === "POST") {
    const input = parse(upsertDigitalHumanCharacterSchema, await readBody());
    const id = randomUUID();
    const created = await one(
      db,
      `INSERT INTO public.digital_human_characters
       (id, user_id, name, persona, voice_id, voice_name, voice_provider, voice_model, authorized)
       VALUES ($1::uuid, $2::bigint, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      id,
      actor.id,
      input.name,
      input.persona,
      input.voiceId,
      input.voiceName,
      input.voiceProvider,
      input.voiceModel,
      input.authorized,
    );
    return res.status(201).json({ character: characterView(created!) });
  }

  const match = /^\/characters\/([a-f0-9-]{36})(?:\/(views))?$/i.exec(suffix);
  if (!match) return res.status(404).json({ error: "找不到该数字人角色接口" });

  const [, characterId, sub] = match;
  const character = await ownedCharacter(actor, characterId);

  if (sub === "views" && req.method === "POST") {
    return res
      .status(201)
      .json(await uploadCharacterView(studio, actor, character, req));
  }

  if (!sub && req.method === "PATCH") {
    const input = parse(
      upsertDigitalHumanCharacterSchema.partial(),
      await readBody(),
    );
    const updated = await one(
      db,
      `UPDATE public.digital_human_characters
       SET name=COALESCE($2, name),
           persona=COALESCE($3, persona),
           voice_id=COALESCE($4, voice_id),
           voice_name=COALESCE($5, voice_name),
           voice_provider=COALESCE($6, voice_provider),
           voice_model=COALESCE($7, voice_model),
           authorized=COALESCE($8, authorized),
           updated_at=now()
       WHERE id=$1::uuid RETURNING *`,
      character.id,
      input.name ?? null,
      input.persona ?? null,
      input.voiceId ?? null,
      input.voiceName ?? null,
      input.voiceProvider ?? null,
      input.voiceModel ?? null,
      input.authorized ?? null,
    );
    return res.json({ character: characterView(updated!) });
  }

  if (!sub && req.method === "DELETE") {
    await db.$executeRawUnsafe(
      "DELETE FROM public.digital_human_characters WHERE id=$1::uuid AND user_id=$2::bigint",
      character.id,
      actor.id,
    );
    return res.json({ deleted: true });
  }

  return res.status(405).json({ error: "不支持此操作" });
}
