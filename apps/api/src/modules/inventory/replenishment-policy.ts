import {
  db,
  one,
  rows,
  type Tx,
} from "../../../../../packages/database/src/index.js";
import {
  audit,
  command,
  fail,
  parse,
  requirePermission,
  type Context,
} from "../../core.js";
import {
  defaultReplenishmentPolicy,
  replenishmentPolicySchema,
  replenishmentPolicyWriteSchema,
} from "../../../../../packages/contracts/src/inventory-replenishment.js";

export async function replenishmentPolicy(userId?: string, tx: Tx = db) {
  const stored = userId
    ? await one(
        tx,
        "SELECT policy,revision FROM public.inventory_replenishment_policies WHERE user_id=$1::bigint",
        userId,
      )
    : undefined;
  return {
    revision: stored?.revision ?? 0,
    policy: stored
      ? replenishmentPolicySchema.parse(stored.policy)
      : { ...defaultReplenishmentPolicy },
  };
}

export async function saveReplenishmentPolicy(c: Context, input: unknown) {
  requirePermission(c.actor, "inventory.read");
  const body = parse(replenishmentPolicyWriteSchema, input);
  return command(c, "inventory.replenishment-policy", body, async (tx) => {
    await rows(
      tx,
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text",
      `inventory-replenishment:${c.actor.id}`,
    );
    const before = await replenishmentPolicy(c.actor.id, tx);
    if (body.revision !== before.revision)
      fail(
        "POLICY_CONFLICT",
        "计算配置已在其他页面更新，请重新打开面板后修改",
        409,
      );
    const after = (await one(
      tx,
      `INSERT INTO public.inventory_replenishment_policies(user_id,policy)
      VALUES($1::bigint,$2::jsonb) ON CONFLICT(user_id) DO UPDATE SET policy=EXCLUDED.policy,
      revision=inventory_replenishment_policies.revision+1,updated_at=now() RETURNING policy,revision`,
      c.actor.id,
      JSON.stringify(body.policy),
    ))!;
    await audit(
      tx,
      c,
      "inventory.replenishment-policy",
      "users",
      c.actor.id,
      before,
      after,
    );
    return after;
  });
}
