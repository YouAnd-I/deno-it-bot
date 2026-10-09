import { DiscordClient } from "./integrations.ts";

const token = Deno.env.get("DISCORD_TOKEN");
if (!token) throw new Error("Set DISCORD_TOKEN");
await new DiscordClient(token, fetch, Deno.env.get("DISCORD_APPLICATION_ID"))
  .registerCommands();
