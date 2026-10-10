import { equal, ok, rejects } from "node:assert/strict";
import { initializeDatabase, sha256 } from "../src/storage.ts";
import { fakeDatabase, type Query } from "./helpers.ts";

const schemaText = await Deno.readTextFile(
  new URL("../src/schema.sql", import.meta.url),
);
const version = await sha256(schemaText);
const probe = (state: unknown[]) => (query: Query): unknown[] =>
  query.text.includes("sync_key = 'schema'") ? state : [];

Deno.test("matching schema fingerprint skips the locked setup", async () => {
  const { sql, queries } = fakeDatabase(
    probe([{ version, staffed: true }]),
  );
  equal(await initializeDatabase(sql), "current");
  equal(queries.length, 1);
  ok(!queries.some((query) => query.text.includes("pg_advisory")));
});

Deno.test("stale fingerprint runs the locked setup and stores the new one", async () => {
  const { sql, queries } = fakeDatabase(
    probe([{ version: "old", staffed: true }]),
  );
  equal(await initializeDatabase(sql), "migrated");
  ok(queries.some((query) => query.text.includes("pg_advisory_xact_lock")));
  const schemaIndex = queries.findIndex((query) => query.text === schemaText);
  const upsertIndex = queries.findIndex((query) =>
    query.text.includes("insert into ticket_sync_state")
  );
  ok(schemaIndex > 0);
  ok(upsertIndex > schemaIndex);
  ok(queries[upsertIndex].values.includes(version));
});

Deno.test("missing sync state table falls back to the full setup", async () => {
  const { sql, queries } = fakeDatabase((query) => {
    if (query.text.includes("sync_key = 'schema'")) {
      throw Object.assign(
        new Error('relation "ticket_sync_state" does not exist'),
        { code: "42P01" },
      );
    }
    return [];
  });
  equal(await initializeDatabase(sql), "migrated");
  ok(queries.some((query) => query.text.includes("pg_advisory_xact_lock")));
});

Deno.test("connection failures reject without touching the schema", async () => {
  const { sql, queries } = fakeDatabase((query) => {
    if (query.text.includes("sync_key = 'schema'")) {
      throw Object.assign(new Error("connection failure"), { code: "08006" });
    }
    return [];
  });
  await rejects(initializeDatabase(sql));
  ok(!queries.some((query) => query.text.includes("pg_advisory")));
});

Deno.test("an unstaffed roster seeds the on-call fallback only when configured", async () => {
  const reply = probe([{ version, staffed: false }]);
  const seeded = fakeDatabase(reply);
  equal(await initializeDatabase(seeded.sql, "100"), "migrated");
  ok(
    seeded.queries.some((query) => query.text.includes("insert into it_staff")),
  );
  const skipped = fakeDatabase(reply);
  equal(await initializeDatabase(skipped.sql), "current");
});

Deno.test("forced setup always runs the locked migration", async () => {
  const { sql, queries } = fakeDatabase(
    probe([{ version, staffed: true }]),
  );
  equal(await initializeDatabase(sql, undefined, true), "migrated");
  ok(queries.some((query) => query.text.includes("pg_advisory_xact_lock")));
  ok(!queries.some((query) => query.text.includes("sync_key = 'schema'")));
});
