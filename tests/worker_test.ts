import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { createBot } from "../src/bot.ts";
import { applyJob, type Job, loadView } from "../src/storage.ts";
import { fakeDatabase, json, publicKey, signedRequest } from "./helpers.ts";
import { syncSolutions } from "../src/solutions.ts";

const job = (operation: "create" | "note" | "report"): Job => ({
  interaction_id: "12345",
  ticket_id: "t1",
  attempts: 1,
  applied_at_utc: null,
  result: {},
  payload: {
    operation,
    interaction: {
      id: "12345",
      type: 2,
      application_id: "999",
      token: "test",
      guild_id: "700",
      user: { id: "42", username: "Alice" },
    },
    input: {
      title: "Printer",
      description: "Smoke",
      priority: "urgent",
      attachmentUrl: null,
      assigneeId: "100",
    },
    note: "Rebooted",
    complaint: "Private complaint",
    action: "Fix it",
    anonymous: true,
    fileUrl: "https://cdn/evidence.png",
  },
});

Deno.test("loaded database tickets render full cards and matching solutions", async () => {
  const { sql } = fakeDatabase((query) =>
    query.text.includes("from ticket t")
      ? [{
        ticket_id: "t1",
        exists: true,
        title: "Printer jam",
        description: "Paper stuck",
        notes: 1,
      }]
      : query.text.includes("from solution")
      ? [{ title: "Clear the printer", body: "Remove paper", image_url: null }]
      : []
  );
  const view = await loadView(sql, "t1");
  equal(view.exists, true);
  equal(view.solution!.title, "Clear the printer");
});

Deno.test("replayed work does not add another note or status event", async () => {
  let applied = false;
  const { sql, queries } = fakeDatabase((query) => {
    if (query.text.includes("select applied_at_utc")) {
      return [{ applied_at_utc: applied ? new Date() : null }];
    }
    if (query.text.includes("select ticket_id from ticket")) {
      return [{ ticket_id: "t1" }];
    }
    if (query.text.includes("set applied_at_utc")) applied = true;
    return [];
  });
  const note = job("note");
  await applyJob(sql, note);
  await applyJob(sql, note);
  equal(
    queries.filter((query) => query.text.includes("insert into ticket_note"))
      .length,
    1,
  );
  equal(
    queries.filter((query) =>
      query.text.includes("insert into ticket_status_event")
    ).length,
    0,
  );
});

Deno.test("anonymous report stores evidence and completes without an actor ID", async () => {
  const { sql, queries } = fakeDatabase((query) =>
    query.text.includes("select ticket_id from ticket")
      ? [{ ticket_id: "t1" }]
      : [{ applied_at_utc: null }]
  );
  await applyJob(sql, job("report"));
  const report = queries.find((query) =>
    query.text.includes("insert into ticket_report")
  )!;
  deepStrictEqual(report.values, [
    "t1",
    null,
    "Private complaint",
    "Fix it",
    "https://cdn/evidence.png",
  ]);
  const status = queries.find((query) =>
    query.text.includes("insert into ticket_status_event")
  )!;
  deepStrictEqual(status.values, ["t1", "complete", null]);
  equal(
    queries.filter((query) => query.text.includes("insert into discord_user"))
      .length,
    0,
  );
});

Deno.test("requester DM failure falls back to the full ephemeral card and still notifies staff", async () => {
  const pending = job("create");
  let claimed = false;
  const { sql, queries } = fakeDatabase((query) => {
    if (query.text.includes("returning interaction_id::text")) {
      if (claimed) return [];
      claimed = true;
      return [pending];
    }
    if (query.text.includes("select applied_at_utc")) {
      return [{ applied_at_utc: null }];
    }
    if (query.text.includes("from ticket t")) {
      return [{
        ticket_id: "t1",
        exists: true,
        title: "Printer",
        description: "Smoke",
        assignee_user_id: "100",
        priority_code: "urgent",
        status: "open",
        notes: 0,
      }];
    }
    return [];
  });
  const calls: {
    url: string;
    body: Record<string, unknown>;
    method?: string;
  }[] = [];
  const bot = createBot(
    { publicKey, token: "test", registerCommands: false },
    sql,
    (url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ url: String(url), body, method: init?.method });
      if (String(url).endsWith("/users/@me/channels")) {
        return Promise.resolve(
          body.recipient_id === "42"
            ? json({ message: "DMs closed" }, 403)
            : json({ id: "staff-dm" }),
        );
      }
      return Promise.resolve(json({ id: "message" }));
    },
  );
  await bot.processPending();
  const fallback = calls.find((call) => call.method === "PATCH")!;
  equal(fallback.body.flags, 64);
  match(String(fallback.body.content), /Title: \*\*Printer\*\*/);
  const staff = calls.find((call) =>
    call.url.endsWith("/channels/staff-dm/messages")
  )!;
  ok(staff);
  equal(staff.body.enforce_nonce, true);
  ok(
    queries.some((query) =>
      query.text.includes("completed_at_utc = now(), payload = '{}'")
    ),
  );
});

Deno.test({
  name:
    "real local HTTP server accepts a signed PING and serves the portal policy URLs",
  ignore: Deno.env.get("TEST_HTTP") !== "true",
  fn: async () => {
    const { sql } = fakeDatabase();
    const bot = createBot(
      { publicKey, token: "test", registerCommands: false },
      sql,
    );
    const server = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      onListen: () => {},
    }, bot.fetch);
    const base = `http://127.0.0.1:${server.addr.port}`;
    try {
      const signed = await signedRequest({ type: 1 });
      const response = await fetch(base + "/interactions", {
        method: "POST",
        headers: signed.headers,
        body: await signed.text(),
      });
      deepStrictEqual(await response.json(), { type: 1 });
      for (const path of ["/terms", "/privacy"]) {
        const page = await fetch(base + path);
        equal(page.status, 200);
        match(await page.text(), /IT ticket bot/);
      }
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test("hand-authored C# solution JSON mirrors into the shared solution table", async () => {
  const { sql, queries } = fakeDatabase();
  equal(await syncSolutions(sql, "tests/fixtures/it-tickets"), 1);
  deepStrictEqual(queries[0].values, [
    "printer-jam",
    "Clear a printer jam",
    "Open the back and pull the paper",
    null,
  ]);
});
