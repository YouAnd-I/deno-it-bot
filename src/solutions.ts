import { join } from "node:path";
import type { Database } from "./storage.ts";

export async function syncSolutions(sql: Database, directory: string) {
  let count = 0;
  try {
    for await (const file of Deno.readDir(directory)) {
      if (!file.isFile || !file.name.endsWith(".s.json")) continue;
      const raw = JSON.parse(
        await Deno.readTextFile(join(directory, file.name)),
      );
      const title = raw.Title ?? raw.title;
      if (typeof title !== "string" || !title.trim()) continue;
      const body = raw.Text ?? raw.text ?? raw.body ?? null;
      const image = raw.Image ?? raw.image ?? raw.image_url ?? null;
      await sql`insert into solution(slug, title, body, image_url)
        values (${file.name.slice(0, -7)}, ${title}, ${
        typeof body === "string" ? body : null
      }, ${typeof image === "string" ? image : null})
        on conflict(slug) do update set title = excluded.title, body = excluded.body, image_url = excluded.image_url`;
      count++;
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return count;
}
