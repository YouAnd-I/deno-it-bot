import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { createBot } from "../src/bot.ts";
import { connectGateway } from "../src/gateway.ts";
import type { Interaction } from "../src/protocol.ts";
import { transportFor } from "../src/runtime.ts";
import { delay, fakeDatabase, json, publicKey } from "./helpers.ts";

const interaction = (data: Interaction["data"], type = 2): Interaction => ({
  id: "1552661722299367516",
  type,
  application_id: "999",
  token: "test-token",
  user: { id: "42", username: "alice" },
  data,
});

Deno.test("local and Deno Deploy choose working transports without an extra setting", () => {
  const resolve = (variables: Record<string, string>, http = false) =>
    transportFor((key) => variables[key], http);
  equal(resolve({}), "gateway");
  equal(resolve({ DENO_DEPLOY: "true" }), "http");
  equal(resolve({ DENO_DEPLOYMENT_ID: "classic-deployment" }), "http");
  equal(resolve({ DISCORD_TRANSPORT: "", DENO_DEPLOY: "true" }), "http");
  equal(resolve({ DISCORD_TRANSPORT: "gateway" }), "gateway");
  equal(resolve({ DISCORD_TRANSPORT: "http" }), "http");
  equal(resolve({}, true), "http");
});

Deno.test("Gateway commands post initial replies and modals to Discord's callback endpoint", async () => {
  const { sql } = fakeDatabase();
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const bot = createBot({ publicKey, token: "test" }, sql, (url, init) => {
    equal(new Headers(init?.headers).get("Authorization"), null);
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  await bot.handleGatewayInteraction(interaction({ name: "ping" }));
  await bot.handleGatewayInteraction(interaction({ name: "it" }));
  await bot.handleGatewayInteraction(
    interaction({ custom_id: "itnote:t1" }, 3),
  );
  await bot.handleGatewayInteraction(interaction({
    name: "fruit",
    options: [{ name: "fruit", value: "app", focused: true }],
  }, 4));
  equal(
    sent[0].url,
    "https://discord.com/api/v10/interactions/1552661722299367516/test-token/callback",
  );
  deepStrictEqual(sent[0].body, {
    type: 4,
    data: { content: "Pong You!!", flags: 64, allowed_mentions: { parse: [] } },
  });
  equal(sent[1].body.type, 9);
  equal(
    (sent[1].body.data as Record<string, unknown>).custom_id,
    "modal-it-ticket",
  );
  equal(
    (sent[2].body.data as Record<string, unknown>).custom_id,
    "notemodal:t1",
  );
  equal(sent[3].body.type, 8);
  await delay();
});

Deno.test("Gateway ticket work starts only after Discord accepts the deferred acknowledgement", async () => {
  const { sql, queries } = fakeDatabase();
  let accepted = false;
  let acknowledge!: () => void;
  const bot = createBot(
    { publicKey, token: "test" },
    sql,
    async (_url, init) => {
      deepStrictEqual(JSON.parse(String(init?.body)), {
        type: 5,
        data: { flags: 64 },
      });
      await new Promise<void>((resolve) => acknowledge = resolve);
      accepted = true;
      return new Response(null, { status: 204 });
    },
  );
  await bot.initialize();
  const handling = bot.handleGatewayInteraction(interaction({
    name: "it",
    options: [{ name: "title", value: "Printer" }],
  }));
  await delay();
  ok(queries.some((query) => query.text.includes("insert into ticket_job")));
  ok(!queries.some((query) => query.text.includes("skip locked")));
  equal(accepted, false);
  acknowledge();
  await handling;
  await delay();
  equal(accepted, true);
  ok(queries.some((query) => query.text.toLowerCase().includes("skip locked")));
});

Deno.test("Gateway startup rejects an app configured for HTTP instead of silently losing commands", async () => {
  await rejects(
    () =>
      connectGateway("test", async () => {}, () =>
        Promise.resolve(json({
          id: "999",
          interactions_endpoint_url: "https://bot.example/interactions",
        }))),
    /Clear that field/,
  );
});

Deno.test({
  name:
    "Discordeno Gateway carries raw interaction fields over a real local WebSocket",
  ignore: Deno.env.get("TEST_HTTP") !== "true",
  async fn() {
    let socket: WebSocket | undefined;
    let sequence = 0;
    let receive!: (interaction: Interaction) => void;
    const received = new Promise<Interaction>((resolve) => receive = resolve);
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      (request) => {
        const upgraded = Deno.upgradeWebSocket(request);
        socket = upgraded.socket;
        socket.onopen = () =>
          socket!.send(
            JSON.stringify({ op: 10, d: { heartbeat_interval: 60000 } }),
          );
        socket.onmessage = (event) => {
          const packet = JSON.parse(event.data);
          if (packet.op === 1) {
            socket!.send(JSON.stringify({ op: 11, d: null }));
          }
          if (packet.op !== 2) return;
          equal(packet.d.intents, 0);
          socket!.send(JSON.stringify({
            op: 0,
            t: "READY",
            s: sequence++,
            d: {
              session_id: "session",
              resume_gateway_url: `ws://127.0.0.1:${server.addr.port}`,
              guilds: [],
            },
          }));
          socket!.send(
            JSON.stringify({
              op: 0,
              t: "INTERACTION_CREATE",
              s: sequence++,
              d: interaction({
                custom_id: "notemodal:t1",
                components: [{
                  type: 18,
                  component: { type: 4, custom_id: "note", value: "rebooted" },
                }],
              }, 5),
            }),
          );
        };
        return upgraded.response;
      },
    );
    let gateway: Awaited<ReturnType<typeof connectGateway>> | undefined;
    try {
      gateway = await connectGateway("test", (interaction) => {
        receive(interaction);
        return Promise.resolve();
      }, (url) =>
        Promise.resolve(json(
          String(url).endsWith("/gateway/bot")
            ? {
              url: `ws://127.0.0.1:${server.addr.port}`,
              shards: 1,
              session_start_limit: {
                total: 1000,
                remaining: 1000,
                reset_after: 86400000,
                max_concurrency: 1,
              },
            }
            : { id: "999", interactions_endpoint_url: null },
        )));
      const payload = await received;
      equal(gateway.ready, true);
      equal(payload.application_id, "999");
      equal(payload.data?.custom_id, "notemodal:t1");
      equal(payload.data?.components?.[0].component?.custom_id, "note");
    } finally {
      await gateway?.shutdown();
      socket?.close();
      await server.shutdown();
    }
  },
});
