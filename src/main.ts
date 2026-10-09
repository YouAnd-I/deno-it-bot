import postgres from "postgres";
import { createBot } from "./bot.ts";
import { syncSolutions } from "./solutions.ts";

const env = (key: string) => Deno.env.get(key)?.trim() || undefined;
const publicKey = env("DISCORD_PUBLIC_KEY");
const token = env("DISCORD_TOKEN");
const databaseUrl = env("DATABASE_URL");
if (!publicKey || !token || !databaseUrl) {
  throw new Error("Set DISCORD_PUBLIC_KEY, DISCORD_TOKEN, and DATABASE_URL");
}
if (!/^[a-fA-F0-9]{64}$/.test(publicKey)) {
  throw new Error("DISCORD_PUBLIC_KEY must contain 64 hexadecimal characters");
}

const sql = postgres(databaseUrl, {
  ssl: "require",
  prepare: false,
  max: 4,
  connect_timeout: 2,
  idle_timeout: 20,
});
const bot = createBot({
  publicKey,
  token,
  applicationId: env("DISCORD_APPLICATION_ID"),
  itUser: env("DISCORD_IT_USER"),
  cloudflareAccount: env("CLOUDFLARE_ACCOUNT_ID"),
  cloudflareToken: env("CLOUDFLARE_API_TOKEN"),
  registerCommands: env("REGISTER_COMMANDS") !== "false",
  google: {
    clientId: env("GOOGLE_CLIENT_ID"),
    clientSecret: env("GOOGLE_CLIENT_SECRET"),
    refreshToken: env("GOOGLE_REFRESH_TOKEN"),
    spreadsheetId: env("GOOGLE_SPREADSHEET_ID"),
  },
}, sql);

const server = Deno.serve({ port: Number(env("PORT") ?? "8000") }, bot.fetch);
const run = async (
  name: string,
  action: () => Promise<unknown>,
): Promise<void> => {
  try {
    await action();
  } catch (error) {
    console.error(
      `[${name}]`,
      error instanceof Error ? error.message : "unknown error",
    );
  }
};
Deno.cron("ticket-job-retry", "* * * * *", async () => {
  await run("jobs", bot.processPending);
  await run("commands", bot.registerCommands);
});
Deno.cron(
  "sheet-directory-sync",
  "*/10 * * * *",
  () => run("sheets", bot.syncSheets),
);
void run("startup", async () => {
  await bot.initialize();
  await syncSolutions(sql, env("TICKET_SOLUTIONS_DIR") ?? "it-tickets");
  await Promise.allSettled([
    run("jobs", bot.processPending),
    run("commands", bot.registerCommands),
    run("sheets", bot.syncSheets),
  ]);
});

Deno.addSignalListener("SIGINT", () => {
  void server.shutdown().then(() => sql.end({ timeout: 2 }));
});
