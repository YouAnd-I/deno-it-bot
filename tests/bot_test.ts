import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { createBot } from "../src/bot.ts";
import { recordInteraction } from "../src/storage.ts";
import type { Interaction } from "../src/protocol.ts";
import { classify, DiscordClient } from "../src/integrations.ts";
import {
  delay,
  fakeDatabase,
  json,
  publicKey,
  signedRequest,
} from "./helpers.ts";

const interaction = (data: Interaction["data"], type = 2): Interaction => ({
  id: "12345",
  type,
  application_id: "999",
  token: "test-token",
  user: { id: "42", username: "alice" },
  data,
});

Deno.test("signature verification handles valid PING without a database", async () => {
  const { sql, queries } = fakeDatabase(() => {
    throw new Error("must not query");
  });
  const bot = createBot(
    { publicKey, token: "test", registerCommands: false },
    sql,
  );
  const response = await bot.fetch(await signedRequest({ type: 1 }));
  deepStrictEqual(await response.json(), { type: 1 });
  equal(queries.length, 0);
});

Deno.test("requester and IT DMs do not share Discord's author-wide nonce, while retries deduplicate", async () => {
  const messages = new Map<string, { id: string; channel: string }>();
  const discord = new DiscordClient("test", (url, init) => {
    const payload = JSON.parse(String(init?.body));
    if (String(url).endsWith("/users/@me/channels")) {
      return Promise.resolve(json({ id: `dm-${payload.recipient_id}` }));
    }
    const channel = String(url).split("/").at(-2)!;
    equal(payload.enforce_nonce, true);
    ok(payload.nonce.length <= 25);
    let message = messages.get(payload.nonce);
    if (message && message.channel !== channel) {
      return Promise.resolve(
        json({ message: "Unknown Message", code: 10008 }, 404),
      );
    }
    if (!message) {
      message = { id: `message-${messages.size + 1}`, channel };
      messages.set(payload.nonce, message);
    }
    return Promise.resolve(json(message));
  });
  const requester = await discord.dm(
    "42",
    { content: "Your ticket" },
    "1558115229102247987",
  );
  const staff = await discord.dm("407442087664156674", {
    content: "Assigned to you",
  }, "1558115229102247987");
  equal(requester.id, "message-1");
  equal(staff.id, "message-2");
  equal(
    (await discord.dm(
      "407442087664156674",
      { content: "Assigned to you" },
      "1558115229102247987",
    )).id,
    staff.id,
  );
  equal(messages.size, 2);
});

Deno.test("invalid, malformed, and tampered signatures are rejected", async () => {
  const { sql } = fakeDatabase();
  const bot = createBot({ publicKey, token: "test" }, sql);
  equal(
    (await bot.fetch(
      new Request("http://localhost/interactions", {
        method: "POST",
        body: "{}",
      }),
    )).status,
    401,
  );
  equal(
    (await bot.fetch(await signedRequest({ type: 1 }, '{"type":2}'))).status,
    401,
  );
  equal(
    (await bot.fetch(
      new Request("http://localhost/interactions", {
        method: "POST",
        body: "{}",
        headers: {
          "X-Signature-Ed25519": "bad",
          "X-Signature-Timestamp": "123",
        },
      }),
    )).status,
    401,
  );
  equal((await bot.fetch(await signedRequest("not-json"))).status, 400);
});

Deno.test("HTTP utility commands, autocomplete, and components match reference behavior", async () => {
  const { sql } = fakeDatabase();
  const bot = createBot(
    { publicKey, token: "test", registerCommands: false },
    sql,
  );
  for (
    const [data, expected] of [
      [{ name: "ping" }, "Pong You!!"],
      [{
        name: "greet",
        options: [{ name: "user", value: "7" }, {
          name: "message",
          value: "hi",
        }],
      }, "hi, <@7>!"],
      [{
        name: "tools",
        options: [{ name: "square", options: [{ name: "a", value: 3 }] }],
      }, "3² = 9"],
      [{
        name: "Echo Message",
        type: 3,
        target_id: "m1",
        resolved: { messages: { m1: { content: "hello" } } },
      }, "Echo: hello"],
    ] as const
  ) {
    const request = interaction(data as Interaction["data"]);
    equal(
      (await (await bot.fetch(await signedRequest(request))).json()).data
        .content,
      expected,
    );
  }
  const fruit = await (await bot.fetch(
    await signedRequest(
      interaction({
        name: "fruit",
        options: [{ name: "fruit", value: "app", focused: true }],
      }, 4),
    ),
  )).json();
  deepStrictEqual(fruit, {
    type: 8,
    data: { choices: [{ name: "apple", value: "apple" }] },
  });
  equal(
    (await (await bot.fetch(
      await signedRequest(interaction({ custom_id: "btn-hello" }, 3)),
    )).json()).data.content,
    "Hi!",
  );
  await delay();
});

Deno.test("ticket submission queues the selected attachment before returning a deferred reply", async () => {
  const { sql, queries } = fakeDatabase();
  const bot = createBot(
    { publicKey, token: "test", registerCommands: false },
    sql,
  );
  await bot.initialize();
  const request = interaction({
    name: "it",
    options: [{ name: "title", value: "Printer" }, {
      name: "attachment",
      value: "88",
    }],
    resolved: {
      attachments: { "88": { url: "https://cdn.discordapp.com/printer.png" } },
    },
  });
  const response = await bot.fetch(await signedRequest(request));
  deepStrictEqual(await response.json(), { type: 5, data: { flags: 64 } });
  const insert = queries.find((query) =>
    query.text.includes("insert into ticket_job")
  )!;
  ok(insert);
  const payload = insert.values[2] as {
    input: { attachmentUrl: string; priority: string };
  };
  equal(payload.input.attachmentUrl, "https://cdn.discordapp.com/printer.png");
  equal(payload.input.priority, "auto");
  await delay();
});

Deno.test("anonymous report audits redact identity and complaint, and replays do not duplicate options", async () => {
  let inserted = false;
  const { sql, queries } = fakeDatabase((query) => {
    if (query.text.includes("insert into interaction(")) {
      if (inserted) return [];
      inserted = true;
      return [{ interaction_id: "12345" }];
    }
    return [];
  });
  const report = interaction({
    custom_id: "reportmodal:t1",
    components: [
      {
        type: 18,
        component: {
          type: 4,
          custom_id: "complaint",
          value: "PRIVATE COMPLAINT",
        },
      },
      {
        type: 18,
        component: { type: 23, custom_id: "anonymous", value: true },
      },
    ],
  }, 5);
  await recordInteraction(sql, report);
  await recordInteraction(sql, report);
  equal(
    queries.filter((query) =>
      query.text.includes("insert into interaction_option")
    ).length,
    1,
  );
  ok(!JSON.stringify(queries).includes("PRIVATE COMPLAINT"));
  const insert = queries.find((query) =>
    query.text.includes("insert into interaction(")
  )!;
  equal(insert.values[4], null);
  equal(
    queries.filter((query) => query.text.includes("insert into discord_user"))
      .length,
    0,
  );
});

Deno.test("classifier uses fallback guidance for a one-row priority sheet and validates staff choices", async () => {
  const { sql } = fakeDatabase(
    () => [{ code: "urgent", description: "Call now" }],
  );
  let body: Record<string, unknown> = {};
  const result = await classify(
    sql,
    "VPN down",
    [{ user_id: "100", name: "Alice", handles: "VPN" }, {
      user_id: "200",
      name: "Bob",
      handles: "printers",
    }],
    "account",
    "secret",
    (_url, init) => {
      body = JSON.parse(String(init?.body));
      return Promise.resolve(
        json({
          success: true,
          result: {
            answers: {
              priority: { choice: "no-rush" },
              assignee: { choice: "999" },
            },
          },
        }),
      );
    },
  );
  deepStrictEqual(result, { priority: "no-rush", assignee: null });
  const questions = body.questions as {
    priority: { criteria: Record<string, unknown> };
    assignee: unknown;
  };
  ok(questions.priority.criteria["no-rush"]);
  ok(questions.assignee);
  equal(await classify(sql, "VPN down", [], undefined, undefined), null);
});

Deno.test("Discord edits the deferred original and uploads webhook files without the bot header", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = new DiscordClient("bot-secret", (url, init) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(json({ id: "m1" }));
  });
  await client.editOriginal(interaction({}), { content: "Ticket created" }, {
    name: "screen.png",
    bytes: new Uint8Array([1, 2]),
  });
  equal(calls[0].init!.method, "PATCH");
  match(calls[0].url, /messages\/@original$/);
  equal(new Headers(calls[0].init!.headers).has("Authorization"), false);
  ok(calls[0].init!.body instanceof FormData);
});

Deno.test("health and policy pages are available while the database initializes", async () => {
  const { sql } = fakeDatabase();
  const bot = createBot({ publicKey, token: "test" }, sql);
  equal((await bot.fetch(new Request("http://localhost/ready"))).status, 503);
  for (const path of ["/", "/terms", "/privacy"]) {
    equal(
      (await bot.fetch(new Request("http://localhost" + path))).status,
      200,
    );
  }
  equal((await bot.fetch(new Request("http://localhost/unknown"))).status, 404);
});
