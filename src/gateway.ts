import {
  createGatewayManager,
  ShardSocketCloseCodes,
} from "@discordeno/gateway";
import { DiscordClient, type Fetch } from "./integrations.ts";
import type { Interaction } from "./protocol.ts";

export async function connectGateway(
  token: string,
  handle: (interaction: Interaction) => Promise<void>,
  http: Fetch = fetch,
) {
  const discord = new DiscordClient(token, http);
  const application = await discord.request("/oauth2/applications/@me");
  if (application.interactions_endpoint_url) {
    throw new Error(
      "Discord routes this app to an Interactions Endpoint URL. Clear that field in the Developer Portal for Gateway mode, or run deno task start:http at the configured public URL.",
    );
  }
  const info = await discord.request("/gateway/bot");
  const limit = info.session_start_limit as {
    total: number;
    remaining: number;
    reset_after: number;
    max_concurrency: number;
  };
  if (limit.remaining < Number(info.shards)) {
    throw new Error(
      "Discord's Gateway session limit is exhausted; retry later.",
    );
  }
  const connected = new Set<number>();
  const gateway = createGatewayManager({
    token,
    intents: 0,
    preferSnakeCase: true,
    totalShards: Number(info.shards),
    lastShardId: Number(info.shards) - 1,
    connection: {
      url: String(info.url),
      shards: Number(info.shards),
      sessionStartLimit: {
        total: limit.total,
        remaining: limit.remaining,
        resetAfter: limit.reset_after,
        maxConcurrency: limit.max_concurrency,
      },
    },
    resharding: { enabled: false, checkInterval: -1, shardsFullPercentage: 80 },
    events: {
      disconnected(shard) {
        connected.delete(shard.id);
        console.warn(
          `[discord] Gateway shard ${shard.id} disconnected; reconnecting`,
        );
      },
      message(shard, packet) {
        if (packet.t === "READY" || packet.t === "RESUMED") {
          connected.add(shard.id);
          console.log(
            `[discord] Gateway shard ${shard.id} ${packet.t}; receiving interactions`,
          );
        }
        if (packet.t !== "INTERACTION_CREATE") return;
        void handle(packet.d as Interaction).catch((error) => {
          console.error(
            "[discord] interaction failed:",
            error instanceof Error ? error.message : "unknown error",
          );
        });
      },
    },
  });
  await gateway.spawnShards();
  return {
    get ready() {
      return connected.size === Number(info.shards);
    },
    shutdown: () =>
      gateway.shutdown(ShardSocketCloseCodes.Shutdown, "Bot shutdown"),
  };
}
