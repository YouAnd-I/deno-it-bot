import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import {
  buttons,
  card,
  COMMANDS,
  type Interaction,
  interactionOptions,
  modalFields,
  reportModal,
  ticketModal,
} from "../src/protocol.ts";
import {
  dashboard,
  directoryRows,
  parseMoment,
  sheetCell,
} from "../src/sheets.ts";

Deno.test("ticket and report forms use Discord labels, uploads, and an anonymous checkbox", () => {
  const ticket = ticketModal();
  equal(ticket.data.components.length, 4);
  ok(ticket.data.components.every((component) => component.type === 18));
  const components = ticket.data.components.map((component) =>
    component.component!
  );
  deepStrictEqual(components.map((component) => component.type), [4, 4, 3, 19]);
  equal(components[2].required, false);
  equal(components[3].max_values, 1);
  const report = reportModal("t1");
  equal(report.data.components.length, 5);
  equal(report.data.components[0].type, 10);
  equal(report.data.components[4].component!.type, 23);
  equal(report.data.components[4].component!.default, true);
});

Deno.test("modal parsing resolves current labels and legacy rows, files, and checkbox false", () => {
  const interaction = {
    id: "123",
    type: 5,
    application_id: "999",
    token: "test",
    data: {
      components: [
        {
          type: 18,
          component: { type: 4, custom_id: "title", value: "Printer jam" },
        },
        {
          type: 18,
          component: { type: 3, custom_id: "priority", values: ["no-rush"] },
        },
        {
          type: 1,
          components: [{
            type: 4,
            custom_id: "description",
            value: "Paper stuck",
          }],
        },
        {
          type: 18,
          component: { type: 19, custom_id: "file", values: ["777"] },
        },
        {
          type: 18,
          component: { type: 23, custom_id: "anonymous", value: false },
        },
      ],
      resolved: {
        attachments: { "777": { url: "https://cdn.discordapp.com/file.png" } },
      },
    },
  } satisfies Interaction;
  deepStrictEqual(modalFields(interaction), {
    text: { title: "Printer jam", description: "Paper stuck" },
    select: { priority: ["no-rush"] },
    files: { file: "https://cdn.discordapp.com/file.png" },
    checked: { anonymous: false },
  });
});

Deno.test("full cards include assignment, notes, classifier flags, and solution", () => {
  const content = card({
    ticket_id: "t1",
    exists: true,
    title: "Printer",
    description: "Paper stuck",
    priority_code: "urgent",
    classifier_offline: true,
    assignee_user_id: "42",
    notes: 2,
    attachment_url: "https://cdn/image",
    created_at_utc: new Date(),
    status: "open",
    solution: {
      title: "Clear the jam",
      body: "Open the back",
      image_url: "https://cdn/solution",
    },
  }, "created");
  match(content, /Title: \*\*Printer\*\*/);
  match(content, /Handled by <@42>/);
  match(content, /2 note\(s\)/);
  match(content, /classifier offline/);
  match(content, /Clear the jam/);
  match(content, /<t:\d+:R>/);
  equal(
    card({ ticket_id: "gone", exists: false }, "missing"),
    "**IT ticket `gone`** — missing",
  );
});

Deno.test("button rows switch between open-ticket and follow-up actions", () => {
  deepStrictEqual(
    buttons("t1")[0].components!.map((component) => component.custom_id),
    [
      "itstatus:cancel:t1",
      "itstatus:complete:t1",
      "itstatus:unsolved:t1",
      "itstatus:planned:t1",
      "itreport:t1",
    ],
  );
  deepStrictEqual(
    buttons("t1", "complete")[0].components!.map((component) =>
      component.custom_id
    ),
    ["itreopen:t1", "itnote:t1", "itreport:t1"],
  );
  equal(buttons("t1", "reopened")[0].components!.length, 5);
});

Deno.test("all reference slash and context commands are registered", () => {
  deepStrictEqual(COMMANDS.map((command) => command.name), [
    "it",
    "ping",
    "greet",
    "tools",
    "fruit",
    "components",
    "form",
    "User Info",
    "Echo Message",
  ]);
});

Deno.test("audit options flatten slash groups and include selected values", () => {
  const options = interactionOptions(
    {
      data: {
        options: [{ name: "square", options: [{ name: "a", value: 3 }] }],
        values: ["blue"],
      },
    } as Interaction,
  );
  deepStrictEqual(options, [["square.a", "3"], ["value", "blue"]]);
});

Deno.test("directory sheets accept reordered headers, preserve IDs, and skip junk", () => {
  deepStrictEqual(
    directoryRows("it_staff", [
      ["Active", "Handles", "Display_Name", "user_id"],
      [false, "VPN", "Alice", "407442087664156674"],
      [true, "", "Bad", "x"],
    ]),
    [{
      id: "407442087664156674",
      name: "Alice",
      handles: "VPN",
      active: false,
    }],
  );
  deepStrictEqual(
    directoryRows("priority", [["Priority Code", "Description"], [
      "urgent",
      "Call now",
    ], ["urgent", "duplicate"]]),
    [{ code: "urgent", description: "Call now" }],
  );
  deepStrictEqual(directoryRows("it_staff", [["User Id", "Active"]]), []);
  equal(directoryRows("it_staff", [["wrong header"], ["100"]]), null);
});

Deno.test("date-only absences cover the entire UTC day and invalid dates are skipped", () => {
  equal(
    parseMoment("2026-10-07", true)!.toISOString(),
    "2026-10-07T23:59:59.000Z",
  );
  equal(parseMoment("2026-10-07")!.toISOString(), "2026-10-07T00:00:00.000Z");
  equal(parseMoment("2026-02-30"), null);
  equal(parseMoment("junk"), null);
  const rows = directoryRows("it_staff_absence", [
    ["User Id", "From Utc", "Until Utc"],
    ["100", "2026-10-07", "2026-10-07"],
    ["100", "junk", "2026-10-07"],
  ]);
  equal(rows!.length, 1);
});

Deno.test("sheet values keep snowflakes as text and UTC times as serial dates", () => {
  equal(sheetCell(407442087664156674n, "user_id"), "407442087664156674");
  equal(sheetCell(new Date("2026-01-01T00:00:00Z"), "created_at_utc"), 46023);
  equal(sheetCell(true, "active"), true);
});

Deno.test("dashboard uses latest event ID for tied timestamps and staff names", () => {
  const result = dashboard([
    {
      name: "ticket",
      columns: [],
      rows: [{
        ticket_id: "t1",
        title: "Printer",
        priority_code: "urgent",
        assignee_user_id: "100",
        created_at_utc: "2026-10-07T00:00:00Z",
      }, {
        ticket_id: "t2",
        priority_code: "no-rush",
        created_at_utc: "2026-10-08T00:00:00Z",
      }],
    },
    {
      name: "it_staff",
      columns: [],
      rows: [{ user_id: "100", display_name: "Alice" }],
    },
    {
      name: "ticket_status_event",
      columns: [],
      rows: [{
        ticket_id: "t1",
        status_code: "complete",
        status_event_id: "2",
        occurred_at_utc: "2026-10-08T01:00:00Z",
      }, {
        ticket_id: "t1",
        status_code: "open",
        status_event_id: "1",
        occurred_at_utc: "2026-10-08T01:00:00Z",
      }],
    },
  ], new Date("2026-10-09T12:00:00Z"));
  equal(result.matrix[4][0], 1);
  equal(result.matrix[4][2], 1);
  equal(result.matrix[4][6], 1);
  deepStrictEqual(result.solved, [["Alice", 1]]);
});
