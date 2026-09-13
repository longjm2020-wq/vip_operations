import pg from "pg";
const c = new pg.Client({
  connectionString: process.env.LOCAL_PG_URL,
});
await c.connect();
for (const name of ["vip_erp", "vip_erp_test"]) {
  if (
    !(await c.query("SELECT 1 FROM pg_database WHERE datname=$1", [name]))
      .rowCount
  )
    await c.query("CREATE DATABASE " + name);
}
await c.end();
console.log("Local development and isolated test databases ready.");
