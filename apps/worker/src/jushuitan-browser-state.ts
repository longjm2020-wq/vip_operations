import type { BrowserContext } from "@playwright/test";
import { z } from "zod";
import { isJushuitanOrigin } from "../../../packages/contracts/src/jushuitan-inventory.js";
import {
  decryptSecret,
  encryptSecret,
} from "../../api/src/modules/analytics/secrets.js";
const entry = z.object({
  name: z.string().max(512),
  value: z.string().max(128 * 1024),
});
const schema = z.object({
  cookies: z
    .array(
      z.object({
        name: z.string(),
        value: z.string(),
        domain: z.string(),
        path: z.string(),
        expires: z.number(),
        httpOnly: z.boolean(),
        secure: z.boolean(),
        sameSite: z.enum(["Strict", "Lax", "None"]),
      }),
    )
    .max(1000),
  origins: z
    .array(
      z.object({ origin: z.string(), localStorage: z.array(entry).max(1000) }),
    )
    .max(30),
  sessionStorage: z
    .array(z.object({ origin: z.string(), entries: z.array(entry).max(1000) }))
    .max(30)
    .default([]),
});
export function jstOnlyState(input: unknown) {
  const s = schema.parse(input);
  return {
    cookies: s.cookies.filter((c) =>
      isJushuitanOrigin("https://" + c.domain.replace(/^\./, "")),
    ),
    origins: s.origins.filter((o) => isJushuitanOrigin(o.origin)),
    sessionStorage: s.sessionStorage.filter((o) => isJushuitanOrigin(o.origin)),
  };
}
export function encryptJstState(input: unknown, actorId: string) {
  const text = JSON.stringify({
    purpose: "jst-browser-session-v1",
    actorId,
    state: jstOnlyState(input),
  });
  if (Buffer.byteLength(text) > 1024 * 1024)
    throw Error("聚水潭登录会话过大，请重新登录");
  return encryptSecret(text);
}
export function decryptJstState(value: string, actorId: string) {
  try {
    const s = JSON.parse(decryptSecret(value));
    if (s.purpose !== "jst-browser-session-v1" || s.actorId !== actorId)
      throw Error();
    return jstOnlyState(s.state);
  } catch {
    throw Error("已保存的聚水潭会话不可用，请重新登录");
  }
}
export async function collectJstState(context: BrowserContext) {
  const sessions = new Map<
    string,
    { origin: string; entries: { name: string; value: string }[] }
  >();
  for (const page of context.pages())
    for (const frame of page.frames()) {
      if (frame.isDetached() || !isJushuitanOrigin(frame.url())) continue;
      const origin = new URL(frame.url()).origin;
      const entries = await frame
        .evaluate((expected) => {
          if (location.origin !== expected) return null;
          try {
            return Object.keys(sessionStorage).map((name) => ({
              name,
              value: sessionStorage.getItem(name)!,
            }));
          } catch {
            // Embedded sandbox pages can deny storage access. Their storage is
            // unavailable for restoration too; the fresh-context probe still has
            // to prove that the authenticated inventory session is complete.
            return null;
          }
        }, origin)
        .catch((error: unknown) => {
          if (
            frame.isDetached() ||
            (error instanceof Error &&
              /Execution context was destroyed|Frame was detached/.test(
                error.message,
              ))
          )
            return null;
          throw error;
        });
      if (entries) sessions.set(origin, { origin, entries });
    }
  return jstOnlyState({
    ...(await context.storageState()),
    sessionStorage: [...sessions.values()],
  });
}
export async function restoreJstState(
  context: BrowserContext,
  state: ReturnType<typeof jstOnlyState>,
) {
  await context.addInitScript((sessions) => {
    const session = sessions.find((s) => s.origin === location.origin);
    if (session)
      for (const item of session.entries)
        if (sessionStorage.getItem(item.name) === null)
          sessionStorage.setItem(item.name, item.value);
  }, state.sessionStorage);
}
