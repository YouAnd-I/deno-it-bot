import postgres from "postgres";
import { createBot } from "./bot.ts";
import { syncSolutions } from "./solutions.ts";
import type { connectGateway } from "./gateway.ts";
import { transportFor } from "./runtime.ts";

const env = (key: string) => Deno.env.get(key)?.trim() || undefined;
const publicKey = env("DISCORD_PUBLIC_KEY");
const token = env("DISCORD_TOKEN");
const databaseUrl = env("DATABASE_URL");
const transport = transportFor(env, Deno.args.includes("--http"));
if (!token || !databaseUrl) {
  throw new Error("Set DISCORD_TOKEN and DATABASE_URL");
}
if (transport === "http" && !publicKey) {
  throw new Error("Set DISCORD_PUBLIC_KEY for HTTP interactions");
}
if (publicKey && !/^[a-fA-F0-9]{64}$/.test(publicKey)) {
  throw new Error("DISCORD_PUBLIC_KEY must contain 64 hexadecimal characters");
}

const sql = postgres(databaseUrl, {
  ssl: "require",
  prepare: false,
  max: 4,
  connect_timeout: 2,
  idle_timeout: 20,
  onnotice(notice) {
    if (notice.code !== "42P07" && notice.code !== "42701") {
      console.warn(`[postgres] ${notice.message}`);
    }
  },
});
const bot = createBot({
  publicKey: publicKey ?? "",
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

let gateway: Awaited<ReturnType<typeof connectGateway>> | undefined;
const server = Deno.serve(
  { port: Number(env("PORT") ?? "8000") },
  async (request) => {
    const response = await bot.fetch(request);
    if (
      request.method === "GET" && new URL(request.url).pathname === "/ready"
    ) {
      const database = (await response.json()).ready;
      const connected = transport === "http" || gateway?.ready === true;
      return Response.json({
        ready: database && connected,
        database,
        transport,
        connected,
      }, {
        status: database && connected ? 200 : 503,
      });
    }
    return response;
  },
);
console.log(`[discord] transport: ${transport}`);
if (transport === "http") {
  console.log(
    "[discord] Set the Interactions Endpoint URL to this server's public HTTPS /interactions URL",
  );
}
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
async function shutdown() {
  await gateway?.shutdown();
  await server.shutdown();
  await sql.end({ timeout: 2 });
}
if (!env("DENO_DEPLOYMENT_ID") && env("DENO_DEPLOY") !== "true") {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    Deno.addSignalListener(signal, () => {
      void shutdown().finally(() => Deno.exit());
    });
  }
}

try {
  await bot.initialize();
  await syncSolutions(sql, env("TICKET_SOLUTIONS_DIR") ?? "it-tickets");
  if (transport === "gateway") {
    const { connectGateway } = await import("./gateway.ts");
    gateway = await connectGateway(token, bot.handleGatewayInteraction);
  }
  void Promise.allSettled([
    run("jobs", bot.processPending),
    run("commands", bot.registerCommands),
    run("sheets", bot.syncSheets),
  ]);
} catch (error) {
  console.error(
    "[startup]",
    error instanceof Error ? error.message : "unknown error",
  );
  await shutdown();
  Deno.exit(1);
}
