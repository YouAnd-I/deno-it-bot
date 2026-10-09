import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
  applyDirectory,
  dashboardPresentation,
  type Table,
  tablePresentation,
} from "../src/sheets.ts";
import type { Transaction } from "../src/storage.ts";
import { fakeDatabase } from "./helpers.ts";

Deno.test("staff imports create the referenced user before upserting staff and retain absences", async () => {
  const { sql, queries } = fakeDatabase((query) =>
    query.text.includes("select user_id::text from it_staff")
      ? [{ user_id: "100" }]
      : []
  );
  await applyDirectory(sql as unknown as Transaction, {
    it_staff: [["User Id", "Display Name", "Active", "Handles"], [
      "100",
      "Alice",
      "TRUE",
      "VPN",
    ]],
    it_staff_absence: [["User Id", "From Utc", "Until Utc", "Note"], [
      "100",
      "2026-10-07",
      "2026-10-07",
      "Holiday",
    ], ["999", "2026-10-07", "2026-10-07", "Unknown"]],
  });
  ok(
    queries.findIndex((query) =>
      query.text.includes("insert into discord_user")
    ) < queries.findIndex((query) =>
      query.text.includes("insert into it_staff(")
    ),
  );
  const absence = queries.filter((query) =>
    query.text.includes("insert into it_staff_absence")
  );
  equal(absence.length, 1);
  equal(
    (absence[0].values[2] as Date).toISOString(),
    "2026-10-07T23:59:59.000Z",
  );
  ok(
    !queries.some((query) =>
      query.text.includes("delete from it_staff") &&
      !query.text.includes("it_staff_absence")
    ),
  );
});

Deno.test("header-only directory sheets apply deletions while malformed or missing tabs leave data alone", async () => {
  const { sql, queries } = fakeDatabase();
  await applyDirectory(sql as unknown as Transaction, {
    priority: [["Priority Code", "Description"]],
    it_staff_absence: [["User Id", "From Utc", "Until Utc"]],
  });
  ok(
    queries.some((query) =>
      query.text.includes("delete from priority") &&
      query.values[0] instanceof Array && query.values[0].length === 0
    ),
  );
  ok(
    queries.some((query) =>
      query.text.includes("delete from it_staff_absence")
    ),
  );
  const next = fakeDatabase();
  await applyDirectory(next.sql as unknown as Transaction, {
    priority: [["wrong"], ["urgent"]],
  });
  equal(next.queries.length, 0);
});

Deno.test("table presentation sources dropdowns and manages colors, checkboxes, and ID protection", () => {
  const tables: Table[] = [
    {
      name: "priority",
      columns: ["priority_code"],
      rows: [{ priority_code: "urgent" }, { priority_code: "no-rush" }],
    },
    {
      name: "ticket",
      columns: ["ticket_id", "priority_code", "classifier_offline"],
      rows: [{
        ticket_id: "t1",
        priority_code: "urgent",
        classifier_offline: false,
      }],
    },
  ];
  const tab = {
    properties: {
      sheetId: 7,
      title: "ticket",
      gridProperties: { rowCount: 1000 },
    },
    bandedRanges: [{ bandedRangeId: 91 }],
    conditionalFormats: [{
      ranges: [{
        startRowIndex: 1,
        endRowIndex: 5,
        startColumnIndex: 1,
        endColumnIndex: 2,
      }],
    }],
  };
  const requests = tablePresentation(tables[1], tab, tables);
  const body = JSON.stringify(requests);
  ok(body.includes("deleteBanding"));
  ok(body.includes("deleteConditionalFormatRule"));
  ok(body.includes("ONE_OF_LIST"));
  ok(body.includes("BOOLEAN"));
  ok(body.includes("warningOnly"));
  ok(body.includes("neon sync ticket.ticket_id"));
  deepStrictEqual(requests, tablePresentation(tables[1], tab, tables));
});

Deno.test("dashboard formatting removes old conditional rules before creating replacements", () => {
  const requests = dashboardPresentation({
    properties: { sheetId: 9, title: "Dashboard" },
    conditionalFormats: [{ ranges: [] }],
  }, [["NeonDB"], [], [], [], [], [], [], [
    "t1",
    "Printer",
    "urgent",
    "open",
    "Alice",
    46023,
  ]]);
  const keys = requests.map((request) => Object.keys(request as object)[0]);
  ok(
    keys.indexOf("deleteConditionalFormatRule") <
      keys.indexOf("addConditionalFormatRule"),
  );
  ok(JSON.stringify(requests).includes("DATE_TIME"));
});
