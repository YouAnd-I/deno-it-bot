import postgres from "postgres";
import { initializeDatabase } from "./storage.ts";

const url = Deno.env.get("DATABASE_URL_UNPOOLED") ??
  Deno.env.get("DATABASE_URL");
if (!url) throw new Error("Set DATABASE_URL_UNPOOLED or DATABASE_URL");
const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
try {
  await initializeDatabase(sql, Deno.env.get("DISCORD_IT_USER"));
  console.log("Ticket schema is ready");
} finally {
  await sql.end();
}
