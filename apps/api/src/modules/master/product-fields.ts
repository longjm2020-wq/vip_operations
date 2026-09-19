import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  db,
  rows,
  one,
  Tx,
  Row,
} from "../../../../../packages/database/src/index.js";
import { Context, command, parse, fail, audit } from "../../core.js";
export const customValues = z
  .record(
    z.string().regex(/^f[a-f0-9]{32}$/),
    z.union([
      z.string().max(1000),
      z.number().finite().min(-1e12).max(1e12),
      z.null(),
    ]),
  )
  .refine((v) => Object.keys(v).length <= 50);
export const productFields = () =>
  rows(db, "SELECT * FROM product_fields ORDER BY created_at,id");
export async function writeProductField(
  c: Context,
  input: unknown,
  id?: string,
) {
  const b = parse(
    z
      .object({
        name: z.string().trim().min(1).max(40),
        type: z.enum(["text", "number", "date", "select"]),
        options: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
        active: z.boolean().default(true),
        expectedUpdatedAt: z.iso.datetime().optional(),
      })
      .strict(),
    input,
  );
  if (
    [
      "序号",
      "款号",
      "商品名称",
      "品类",
      "三级分类",
      "品牌",
      "默认供应商",
      "年份",
      "季节",
      "适穿季节",
      "吊牌价",
      "主图网址",
      "图片",
      "备注",
      "状态",
      "操作",
      "标题字数",
      "吊牌价限价是否达标",
    ].includes(b.name)
  )
    fail("VALIDATION_ERROR", "字段名称与系统字段重复，请换一个名称", 400);
  if (
    b.type === "select" &&
    (!b.options.length || new Set(b.options).size !== b.options.length)
  )
    fail("VALIDATION_ERROR", "单选字段须填写不重复的选项", 400);
  return command(c, "product-fields/" + (id || "new"), b, async (tx) => {
    await rows(tx, "SELECT pg_advisory_xact_lock(91002)::text");
    const old = id
      ? await one(tx, "SELECT * FROM product_fields WHERE id=$1 FOR UPDATE", id)
      : undefined;
    if (id && !old) fail("NOT_FOUND", "字段不存在", 404);
    if (
      old &&
      (!b.expectedUpdatedAt ||
        new Date(old.updated_at).toISOString() !== b.expectedUpdatedAt)
    )
      fail("EDIT_CONFLICT", "字段已更新，请刷新重试");
    if (
      old &&
      (old.type !== b.type ||
        JSON.stringify(old.options) !== JSON.stringify(b.options))
    )
      fail("VALIDATION_ERROR", "已有字段的类型和选项不能改变，请新增字段", 400);
    if (
      !id &&
      (await one(tx, "SELECT count(*)::int AS n FROM product_fields"))!.n >= 50
    )
      fail("VALIDATION_ERROR", "最多支持50个自定义字段", 400);
    const key = id || "f" + randomUUID().replaceAll("-", "");
    const result = id
      ? await one(
          tx,
          "UPDATE product_fields SET name=$2,active=$3,updated_at=now() WHERE id=$1 RETURNING *",
          key,
          b.name,
          b.active,
        )
      : await one(
          tx,
          "INSERT INTO product_fields(id,name,type,options,active) VALUES($1,$2,$3,$4::jsonb,$5) RETURNING *",
          key,
          b.name,
          b.type,
          JSON.stringify(b.options),
          b.active,
        );
    await audit(
      tx,
      c,
      "PRODUCT_FIELD_WRITE",
      "product_field",
      null,
      old || null,
      result,
    );
    return result;
  });
}
export async function validateCustom(tx: Tx, changes: Row, previous: Row = {}) {
  const defs = await rows(tx, "SELECT * FROM product_fields");
  for (const [key, value] of Object.entries(changes)) {
    const f = defs.find((d) => d.id === key && d.active);
    if (!f) fail("VALIDATION_ERROR", "自定义字段不存在或已停用，请刷新", 400);
    if (value === null || value === "") continue;
    if (
      f.builtin &&
      f.type === "number" &&
      typeof value === "number" &&
      value < 0
    )
      fail("VALIDATION_ERROR", f.name + "不能小于0", 400);
    const valid =
      f.type === "number"
        ? typeof value === "number"
        : typeof value === "string" &&
          (f.type === "text" ||
            (f.type === "select" && f.options.includes(value)) ||
            (f.type === "date" &&
              /^\d{4}-\d{2}-\d{2}$/.test(value) &&
              !Number.isNaN(Date.parse(value)) &&
              new Date(value).toISOString().slice(0, 10) === value));
    if (!valid) fail("VALIDATION_ERROR", "请正确填写" + f.name, 400);
  }
  return { ...previous, ...changes };
}
export async function customFilter(
  raw: unknown,
  values: unknown[],
  where: string[],
) {
  let input;
  try {
    input = JSON.parse(String(raw));
  } catch {
    fail("VALIDATION_ERROR", "自定义筛选格式无效", 400);
  }
  const filters = parse(
    z
      .array(
        z
          .object({
            id: z.string().regex(/^f[a-f0-9]{32}$/),
            value: z.string().min(1).max(1000),
          })
          .strict(),
      )
      .max(20),
    input,
  );
  const defs = await productFields();
  for (const f of filters) {
    const definition = defs.find((d) => d.id === f.id && d.active);
    if (!definition) fail("VALIDATION_ERROR", "筛选字段不存在或已停用", 400);
    values.push(f.id);
    const key = "$" + values.length;
    values.push(
      definition.type === "text"
        ? "%" + f.value.replace(/[\\%_]/g, "\\$&") + "%"
        : f.value,
    );
    where.push(
      `(custom_fields->>${key}) ${definition.type === "text" ? "ILIKE" : "="} $${values.length}`,
    );
  }
}
