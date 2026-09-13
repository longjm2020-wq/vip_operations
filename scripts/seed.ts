import "dotenv/config";
import { db, rows, one } from "../packages/database/src/index.js";
import { passwordHash } from "../apps/api/src/core.js";
import { permissions, roleSeeds } from "../packages/contracts/src/domain.js";
export async function seed() {
  const password = process.env.ADMIN_PASSWORD;
  if (!password || password.length < 12)
    throw Error("ADMIN_PASSWORD must contain at least 12 characters");
  await db.$transaction(async (tx) => {
    for (const code of permissions)
      await rows(
        tx,
        "INSERT INTO permissions(code,name) VALUES($1,$1) ON CONFLICT(code) DO NOTHING RETURNING id",
        code,
      );
    for (const [code, r] of Object.entries(roleSeeds)) {
      await rows(
        tx,
        "INSERT INTO roles(code,name) VALUES($1,$2) ON CONFLICT(code) DO NOTHING RETURNING id",
        code,
        r.name,
      );
      const role = await one(tx, "SELECT id FROM roles WHERE code=$1", code);
      for (const p of r.permissions)
        await rows(
          tx,
          "INSERT INTO role_permissions(role_id,permission_id) SELECT $1::bigint,id FROM permissions WHERE code=$2 ON CONFLICT DO NOTHING RETURNING role_id",
          String(role!.id),
          p,
        );
    }
    const username = (process.env.ADMIN_USERNAME || "admin").toLowerCase();
    await rows(
      tx,
      "INSERT INTO users(username,display_name,password_hash) VALUES($1,$2,$3) ON CONFLICT(username) DO NOTHING RETURNING id",
      username,
      "管理员",
      passwordHash(password),
    );
    await rows(
      tx,
      "INSERT INTO user_roles(user_id,role_id) SELECT u.id,r.id FROM users u CROSS JOIN roles r WHERE u.username=$1 AND r.code='ADMIN' ON CONFLICT DO NOTHING RETURNING user_id",
      username,
    );
  });
  console.log("Permission seed complete; existing passwords unchanged.");
}
if (process.argv[1]?.endsWith("seed.ts")) {
  try {
    await seed();
  } finally {
    await db.$disconnect();
  }
}
