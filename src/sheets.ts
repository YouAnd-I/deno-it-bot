import type { Database, Transaction } from "./storage.ts";
import { ensureUser } from "./storage.ts";
import type { Fetch } from "./integrations.ts";

export type SheetsOptions = {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  spreadsheetId?: string;
};
export type SheetRows = (string | number | boolean | null)[][];
export type Table = {
  name: string;
  columns: string[];
  rows: Record<string, unknown>[];
};
export type Tab = {
  properties: {
    sheetId: number;
    title: string;
    gridProperties?: { rowCount?: number; columnCount?: number };
  };
  bandedRanges?: { bandedRangeId: number }[];
  conditionalFormats?: {
    ranges?: {
      startRowIndex?: number;
      endRowIndex?: number;
      startColumnIndex?: number;
      endColumnIndex?: number;
    }[];
  }[];
  protectedRanges?: {
    protectedRangeId: number;
    description?: string;
    range: {
      startRowIndex?: number;
      endRowIndex?: number;
      startColumnIndex?: number;
      endColumnIndex?: number;
    };
  }[];
  charts?: { chartId: number; spec: { title?: string } }[];
};
const EDITABLE = ["it_staff", "it_staff_absence", "priority"];
const INTERNAL = ["ticket_job", "ticket_sync_state"];
const STATE_FIELDS =
  "sheets(properties,bandedRanges,conditionalFormats(ranges),protectedRanges(protectedRangeId,description,range),charts(chartId,spec(title)))";
export const headerKey = (value: unknown) =>
  String(value ?? "").replace(/[ _]/g, "").toLowerCase();
export const header = (value: string) =>
  value.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

function cell(row: SheetRows[number], columns: unknown[], name: string) {
  const at = columns.findIndex((column) =>
    headerKey(column) === headerKey(name)
  );
  return at < 0 ? "" : String(row[at] ?? "").trim();
}

export function parseMoment(value: string, endOfDay = false): Date | null {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (
    !dateOnly &&
    !/^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/
      .test(value)
  ) return null;
  let text = dateOnly
    ? value + (endOfDay ? "T23:59:59Z" : "T00:00:00Z")
    : value.replace(" ", "T");
  text = text.replace(/T(\d):/, "T0$1:");
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(text)) text += "Z";
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) return null;
  if (
    (dateOnly || text.endsWith("Z")) &&
    date.toISOString().slice(0, 10) !== value.slice(0, 10)
  ) return null;
  return date;
}

export function directoryRows(tab: string, rows: SheetRows) {
  const columns = rows[0] ?? [];
  const required = tab === "priority"
    ? ["priority_code"]
    : tab === "it_staff"
    ? ["user_id"]
    : ["user_id", "from_utc", "until_utc"];
  if (
    !rows.length ||
    required.some((name) =>
      !columns.some((column) => headerKey(column) === headerKey(name))
    )
  ) return null;
  const seen = new Set<string>();
  const result: Record<string, string | boolean | Date>[] = [];
  for (const row of rows.slice(1)) {
    if (tab === "priority") {
      const code = cell(row, columns, "priority_code");
      if (!code || seen.has(code)) continue;
      seen.add(code);
      result.push({ code, description: cell(row, columns, "description") });
    } else {
      const id = cell(row, columns, "user_id");
      if (!/^\d+$/.test(id) || BigInt(id) > 9223372036854775807n) continue;
      if (tab === "it_staff") {
        if (seen.has(id)) continue;
        seen.add(id);
        result.push({
          id,
          name: cell(row, columns, "display_name"),
          handles: cell(row, columns, "handles"),
          active: !["FALSE", "0", "NO"].includes(
            cell(row, columns, "active").toUpperCase(),
          ),
        });
      } else {
        const from = parseMoment(cell(row, columns, "from_utc"));
        const until = parseMoment(cell(row, columns, "until_utc"), true);
        if (!from || !until || until <= from) continue;
        const key = id + from.toISOString() + until.toISOString();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ id, from, until, note: cell(row, columns, "note") });
      }
    }
  }
  return result;
}

export async function applyDirectory(
  tx: Transaction,
  tabs: Record<string, SheetRows>,
) {
  const staff = directoryRows("it_staff", tabs.it_staff ?? []);
  if (staff) {
    const ids = staff.map((person) => String(person.id));
    await tx`update it_staff set active = false where not(user_id::text = any(${ids}::text[]))`;
    for (const person of staff) {
      await ensureUser(tx, {
        id: String(person.id),
        username: String(person.name),
      });
      await tx`insert into it_staff(user_id, display_name, handles, active)
        values (${String(person.id)}::bigint, ${String(person.name)}, ${
        String(person.handles)
      }, ${Boolean(person.active)})
        on conflict(user_id) do update set display_name = excluded.display_name, handles = excluded.handles, active = excluded.active`;
    }
  }
  const absences = directoryRows(
    "it_staff_absence",
    tabs.it_staff_absence ?? [],
  );
  if (absences) {
    const known = await tx<
      { user_id: string }[]
    >`select user_id::text from it_staff`;
    const ids = new Set(known.map((person) => person.user_id));
    await tx`delete from it_staff_absence`;
    for (const absence of absences) {
      if (ids.has(String(absence.id))) {
        await tx`insert into it_staff_absence(user_id, from_utc, until_utc, note)
      values (${String(absence.id)}::bigint, ${absence.from as Date}, ${absence
          .until as Date}, ${String(absence.note)})`;
      }
    }
  }
  const priorities = directoryRows("priority", tabs.priority ?? []);
  if (priorities) {
    for (const option of priorities) {
      await tx`insert into priority(priority_code, description)
      values (${String(option.code)}, ${
        String(option.description)
      }) on conflict(priority_code) do update set description = excluded.description`;
    }
    const codes = priorities.map((option) => String(option.code));
    await tx`delete from priority where not(priority_code = any(${codes}::text[]))
      and not exists(select 1 from ticket t where t.priority_code = priority.priority_code)`;
  }
}

export const serial = (date: Date) => date.getTime() / 86400000 + 25569;
export function sheetCell(
  value: unknown,
  column: string,
): string | number | boolean {
  if (value == null) return "";
  if (typeof value === "bigint") return value.toString();
  if (column === "id" || column.endsWith("_id")) return String(value);
  if (value instanceof Date) return serial(value);
  if (column.endsWith("_utc") && typeof value === "string") {
    const date = parseMoment(value);
    if (date) return serial(date);
  }
  if (
    typeof value === "boolean" || typeof value === "number" ||
    typeof value === "string"
  ) return value;
  return JSON.stringify(value);
}

export function dashboard(tables: Table[], now = new Date()) {
  const table = (name: string) =>
    tables.find((table) => table.name === name)?.rows ?? [];
  const latest = new Map<string, Record<string, unknown>>();
  for (const event of table("ticket_status_event")) {
    const key = String(event.ticket_id);
    const old = latest.get(key);
    const at = new Date(event.occurred_at_utc as string).getTime();
    const oldAt = old
      ? new Date(old.occurred_at_utc as string).getTime()
      : -Infinity;
    if (
      at > oldAt ||
      (at === oldAt &&
        BigInt(String(event.status_event_id ?? 0)) >
          BigInt(String(old?.status_event_id ?? 0)))
    ) latest.set(key, event);
  }
  const names = new Map<string, string>();
  for (const person of table("discord_user")) {
    if (person.username) {
      names.set(String(person.user_id), String(person.username));
    }
  }
  for (const person of table("it_staff")) {
    if (person.display_name) {
      names.set(String(person.user_id), String(person.display_name));
    }
  }
  const tickets: (Record<string, unknown> & { status: string })[] = table(
    "ticket",
  ).map((ticket) => ({
    ...ticket,
    status: String(latest.get(String(ticket.ticket_id))?.status_code ?? "open"),
  }));
  const open = tickets.filter((ticket) =>
    !["complete", "cancel"].includes(ticket.status)
  );
  const stale = open.filter((ticket) =>
    now.getTime() - new Date(ticket.created_at_utc as string).getTime() >=
      86400000
  );
  const matrix: SheetRows = [
    ["NeonDB — IT Tickets"],
    [`synced ${now.toISOString()}`],
    [],
    ["Open tickets", "", "Unsolved > 1 day", "", "Planned", "", "Complete"],
    [
      open.length,
      "",
      stale.length,
      "",
      tickets.filter((ticket) => ticket.status === "planned").length,
      "",
      tickets.filter((ticket) => ticket.status === "complete").length,
    ],
    [],
    ["Open tickets — oldest first"],
    [
      "Ticket",
      "Title",
      "Priority",
      "Status",
      "Assignee",
      "Created",
      "Age (days)",
    ],
  ];
  for (
    const ticket of open.sort((a, b) =>
      new Date(a.created_at_utc as string).getTime() -
      new Date(b.created_at_utc as string).getTime()
    ).slice(0, 15)
  ) {
    const created = new Date(ticket.created_at_utc as string);
    matrix.push([
      String(ticket.ticket_id),
      String(ticket.title ?? ""),
      String(ticket.priority_code),
      ticket.status,
      names.get(String(ticket.assignee_user_id)) ??
        String(ticket.assignee_user_id ?? ""),
      serial(created),
      Math.round((now.getTime() - created.getTime()) / 8640000) / 10,
    ]);
  }
  if (!open.length) matrix.push([]);
  matrix.push([], ["Solved by staff", "", "", "Status", "", "", "Priority"], [
    "Staff",
    "Solved",
    "",
    "Status",
    "Count",
    "",
    "Priority",
    "Count",
  ]);
  const countsStart = matrix.length - 1;
  const count = (items: string[]) =>
    [...new Set(items)].sort().map((label) =>
      [label, items.filter((item) => item === label).length] as [string, number]
    );
  const solved = count(
    tickets.filter((ticket) => ticket.status === "complete").map((ticket) =>
      names.get(String(ticket.assignee_user_id)) ??
        String(ticket.assignee_user_id ?? "(unassigned)")
    ),
  ).sort((a, b) => b[1] - a[1]);
  const status = [
    ...new Set([
      "open",
      "planned",
      "complete",
      "reopened",
      "unsolved",
      "cancel",
      ...tickets.map((ticket) => ticket.status),
    ]),
  ]
    .map((code) =>
      [code, tickets.filter((ticket) => ticket.status === code).length] as [
        string,
        number,
      ]
    );
  const priorities = [
    ...new Set([
      ...table("priority").map((option) => String(option.priority_code)),
      ...tickets.map((ticket) => String(ticket.priority_code)),
    ]),
  ]
    .map((code) =>
      [
        code,
        tickets.filter((ticket) => ticket.priority_code === code).length,
      ] as [string, number]
    );
  for (
    let i = 0;
    i < Math.max(solved.length, status.length, priorities.length);
    i++
  ) {
    matrix.push([
      solved[i]?.[0] ?? "",
      solved[i]?.[1] ?? "",
      "",
      status[i]?.[0] ?? "",
      status[i]?.[1] ?? "",
      "",
      priorities[i]?.[0] ?? "",
      priorities[i]?.[1] ?? "",
    ]);
  }
  matrix.push([], ["Recent activity"], [
    "Ticket",
    "Status",
    "Priority",
    "At (UTC)",
    "Title",
  ]);
  for (
    const event of table("ticket_status_event").sort((a, b) =>
      new Date(b.occurred_at_utc as string).getTime() -
      new Date(a.occurred_at_utc as string).getTime()
    ).slice(0, 10)
  ) {
    const ticket = tickets.find((ticket) =>
      ticket.ticket_id === event.ticket_id
    );
    matrix.push([
      String(event.ticket_id),
      String(event.status_code),
      String(ticket?.priority_code ?? ""),
      serial(new Date(event.occurred_at_utc as string)),
      String(ticket?.title ?? ""),
    ]);
  }
  return { matrix, countsStart, solved, status, priorities };
}

export class SheetsSync {
  private token: string | null = null;
  private tokenExpires = 0;
  constructor(
    private sql: Database,
    private options: SheetsOptions,
    private http: Fetch = fetch,
  ) {}

  private async request(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    if (!this.token || Date.now() >= this.tokenExpires) {
      const response = await this.http("https://oauth2.googleapis.com/token", {
        method: "POST",
        body: new URLSearchParams({
          client_id: this.options.clientId!,
          client_secret: this.options.clientSecret!,
          refresh_token: this.options.refreshToken!,
          grant_type: "refresh_token",
        }),
        signal: AbortSignal.timeout(15000),
      });
      const json = await response.json();
      if (!response.ok || !json.access_token) {
        throw new Error(`Google OAuth HTTP ${response.status}`);
      }
      this.token = json.access_token;
      this.tokenExpires = Date.now() +
        (Number(json.expires_in ?? 3600) - 60) * 1000;
    }
    const response = await this.http(
      "https://sheets.googleapis.com/v4/spreadsheets" + path,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      },
    );
    const json = await response.json();
    if (!response.ok) {
      throw new Error(
        `Google Sheets HTTP ${response.status}: ${
          JSON.stringify(json.error ?? {})
        }`,
      );
    }
    return json;
  }

  async sync(force = false) {
    if (
      !this.options.clientId || !this.options.clientSecret ||
      !this.options.refreshToken
    ) return;
    await this
      .sql`insert into ticket_sync_state(sync_key) values ('sheets') on conflict do nothing`;
    const [lease] = await this
      .sql`update ticket_sync_state set locked_until_utc = now() + interval '5 minutes'
      where sync_key = 'sheets' and (locked_until_utc is null or locked_until_utc < now())
        and (${force} or synced_at_utc is null or synced_at_utc < now() - interval '9 minutes'
          or (${this.options.spreadsheetId ?? ""} <> '' and value <> ${
      this.options.spreadsheetId ?? ""
    })) returning value`;
    if (!lease) return;
    try {
      let id = this.options.spreadsheetId || String(lease.value || "");
      if (!id) {
        id = String(
          (await this.request("", "POST", {
            properties: { title: "NeonDB — IT Tickets" },
          })).spreadsheetId,
        );
        await this
          .sql`update ticket_sync_state set value = ${id} where sync_key = 'sheets'`;
        console.log(
          `[sheets] created https://docs.google.com/spreadsheets/d/${id}`,
        );
      }
      const state = await this.request(
        `/${id}?fields=${encodeURIComponent(STATE_FIELDS)}`,
      );
      let tabs = state.sheets as Tab[] ?? [];
      const incoming: Record<string, SheetRows> = {};
      for (const tab of EDITABLE) {
        if (tabs.some((sheet) => sheet.properties.title === tab)) {
          const result = await this.request(
            `/${id}/values/${
              encodeURIComponent("'" + tab + "'!A1:ZZ")
            }?valueRenderOption=FORMATTED_VALUE`,
          );
          incoming[tab] = result.values as SheetRows ?? [];
        }
      }
      await this.sql.begin((tx) => applyDirectory(tx, incoming));
      const names = await this.sql<
        { table_name: string }[]
      >`select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`;
      const tables: Table[] = [];
      for (const { table_name: name } of names) {
        if (INTERNAL.includes(name)) continue;
        const columns = await this.sql<
          { column_name: string }[]
        >`select column_name from information_schema.columns
          where table_schema = 'public' and table_name = ${name} order by ordinal_position`;
        const rows = await this.sql`select * from public.${this.sql(name)}`;
        tables.push({
          name,
          columns: columns.map((column) => column.column_name),
          rows,
        });
      }
      const missing = [...tables.map((table) => table.name), "Dashboard"]
        .filter((name) => !tabs.some((tab) => tab.properties.title === name));
      if (missing.length) {
        await this.request(`/${id}:batchUpdate`, "POST", {
          requests: missing.map((title) => ({
            addSheet: { properties: { title } },
          })),
        });
        tabs = (await this.request(
          `/${id}?fields=${encodeURIComponent(STATE_FIELDS)}`,
        )).sheets as Tab[];
      }
      const requests: unknown[] = [];
      for (const table of tables) {
        const tab = tabs.find((tab) => tab.properties.title === table.name)!;
        const matrix = [
          table.columns.map(header),
          ...table.rows.map((row) =>
            table.columns.map((column) => sheetCell(row[column], column))
          ),
        ];
        await this.write(id, tab, matrix);
        requests.push(...tablePresentation(table, tab, tables));
      }
      const tab = tabs.find((tab) => tab.properties.title === "Dashboard")!;
      const model = dashboard(tables);
      await this.write(id, tab, model.matrix);
      requests.push({
        updateSheetProperties: {
          properties: {
            sheetId: tab.properties.sheetId,
            index: 0,
            gridProperties: { hideGridlines: true },
          },
          fields: "index,gridProperties.hideGridlines",
        },
      });
      const titles = [
        "Tickets by status",
        "Tickets by priority",
        "Solved by staff",
      ];
      for (const chart of tab.charts ?? []) {
        if (titles.includes(chart.spec.title ?? "")) {
          requests.push({ deleteEmbeddedObject: { objectId: chart.chartId } });
        }
      }
      for (
        const [index, items, column] of [[0, model.status, 3], [
          1,
          model.priorities,
          6,
        ], [2, model.solved, 0]] as const
      ) {
        if (!items.length) continue;
        const source = (col: number) => ({
          sourceRange: {
            sources: [{
              sheetId: tab.properties.sheetId,
              startRowIndex: model.countsStart,
              endRowIndex: model.countsStart + items.length + 1,
              startColumnIndex: col,
              endColumnIndex: col + 1,
            }],
          },
        });
        const spec = index === 1
          ? {
            pieChart: {
              domain: source(column),
              series: source(column + 1),
              pieHole: 0.55,
              legendPosition: "RIGHT_LEGEND",
            },
          }
          : {
            basicChart: {
              chartType: "COLUMN",
              legendPosition: "NO_LEGEND",
              headerCount: 1,
              domains: [{ domain: source(column) }],
              series: [{ series: source(column + 1), targetAxis: "LEFT_AXIS" }],
            },
          };
        requests.push({
          addChart: {
            chart: {
              spec: { title: titles[index], ...spec },
              position: {
                overlayPosition: {
                  anchorCell: {
                    sheetId: tab.properties.sheetId,
                    rowIndex: 3 + index * 17,
                    columnIndex: 9,
                  },
                },
              },
            },
          },
        });
      }
      requests.push({
        repeatCell: {
          range: {
            sheetId: tab.properties.sheetId,
            startRowIndex: 0,
            endRowIndex: 1,
          },
          cell: {
            userEnteredFormat: { textFormat: { bold: true, fontSize: 14 } },
          },
          fields: "userEnteredFormat.textFormat",
        },
      });
      requests.push(...dashboardPresentation(tab, model.matrix));
      await this.request(`/${id}:batchUpdate`, "POST", { requests });
      await this
        .sql`update ticket_sync_state set value = ${id}, synced_at_utc = now(), locked_until_utc = null where sync_key = 'sheets'`;
      console.log(
        `[sheets] synced ${
          tables.reduce((total, table) => total + table.rows.length, 0)
        } rows`,
      );
    } catch (error) {
      await this
        .sql`update ticket_sync_state set locked_until_utc = null where sync_key = 'sheets'`;
      throw error;
    }
  }

  private async write(id: string, tab: Tab, matrix: SheetRows) {
    const rows = Math.max(
      tab.properties.gridProperties?.rowCount ?? 1000,
      matrix.length,
      60,
    );
    const columns = Math.max(
      tab.properties.gridProperties?.columnCount ?? 26,
      ...matrix.map((row) => row.length),
    );
    await this.request(`/${id}:batchUpdate`, "POST", {
      requests: [{
        updateSheetProperties: {
          properties: {
            sheetId: tab.properties.sheetId,
            gridProperties: { rowCount: rows, columnCount: columns },
          },
          fields: "gridProperties(rowCount,columnCount)",
        },
      }],
    });
    await this.request(
      `/${id}/values/${
        encodeURIComponent(
          "'" + tab.properties.title.replaceAll("'", "''") + "'!A:ZZ",
        )
      }:clear`,
      "POST",
      {},
    );
    const data = [];
    for (let offset = 0; offset < matrix.length; offset += 5000) {
      data.push({
        range: "'" + tab.properties.title.replaceAll("'", "''") +
          `'!A${offset + 1}`,
        values: matrix.slice(offset, offset + 5000),
      });
    }
    await this.request(`/${id}/values:batchUpdate`, "POST", {
      valueInputOption: "RAW",
      data,
    });
  }
}

export function tablePresentation(
  table: Table,
  tab: Tab,
  tables: Table[],
): unknown[] {
  const sheetId = tab.properties.sheetId;
  const range = {
    sheetId,
    startRowIndex: 0,
    endRowIndex: table.rows.length + 1,
    startColumnIndex: 0,
    endColumnIndex: table.columns.length,
  };
  const color = { red: 0.12, green: 0.16, blue: 0.22 };
  const requests: unknown[] = [
    {
      updateSheetProperties: {
        properties: {
          sheetId,
          gridProperties: { hideGridlines: true, frozenRowCount: 1 },
        },
        fields: "gridProperties(hideGridlines,frozenRowCount)",
      },
    },
    {
      repeatCell: {
        range: { ...range, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: color,
            textFormat: {
              bold: true,
              foregroundColor: { red: 1, green: 1, blue: 1 },
            },
          },
        },
        fields: "userEnteredFormat",
      },
    },
    { setBasicFilter: { filter: { range } } },
  ];
  for (
    let index = (tab.conditionalFormats?.length ?? 0) - 1;
    index >= 0;
    index--
  ) {
    if (
      tab.conditionalFormats![index].ranges?.some((r) =>
        (r.startColumnIndex ?? 0) < table.columns.length &&
        (r.endColumnIndex ?? Infinity) > 0 &&
        (r.startRowIndex ?? 0) < range.endRowIndex &&
        (r.endRowIndex ?? Infinity) > 0
      )
    ) {
      requests.push({ deleteConditionalFormatRule: { sheetId, index } });
    }
  }
  for (const band of tab.bandedRanges ?? []) {
    requests.push({ deleteBanding: { bandedRangeId: band.bandedRangeId } });
  }
  requests.push({
    addBanding: {
      bandedRange: {
        range,
        rowProperties: {
          headerColor: color,
          firstBandColor: { red: 1, green: 1, blue: 1 },
          secondBandColor: { red: 0.95, green: 0.96, blue: 0.97 },
        },
      },
    },
  });
  table.columns.forEach((column, index) => {
    const width = Math.max(
      76,
      Math.min(
        320,
        Math.max(
              header(column).length,
              ...table.rows.slice(0, 200).map((row) =>
                String(row[column] ?? "").length
              ),
            ) * 7 + 22,
      ),
    );
    requests.push({
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: "COLUMNS",
          startIndex: index,
          endIndex: index + 1,
        },
        properties: { pixelSize: width },
        fields: "pixelSize",
      },
    });
    if (!table.rows.length) return;
    const dataRange = {
      ...range,
      startRowIndex: 1,
      startColumnIndex: index,
      endColumnIndex: index + 1,
    };
    const format = column.endsWith("_id")
      ? { numberFormat: { type: "TEXT", pattern: "@" } }
      : column.endsWith("_utc")
      ? {
        numberFormat: { type: "DATE_TIME", pattern: "yyyy-mm-dd hh:mm:ss" },
      }
      : { wrapStrategy: "WRAP" };
    requests.push({
      repeatCell: {
        range: dataRange,
        cell: { userEnteredFormat: format },
        fields: "userEnteredFormat",
      },
    });
    if (column.endsWith("_id")) {
      const description = `neon sync ${table.name}.${column}`;
      const old = tab.protectedRanges?.find((protection) =>
        protection.description === description
      );
      const protectionRange = {
        ...dataRange,
        endRowIndex: Math.max(
          tab.properties.gridProperties?.rowCount ?? 1000,
          range.endRowIndex,
        ),
      };
      if (!old) {
        requests.push({
          addProtectedRange: {
            protectedRange: {
              range: protectionRange,
              description,
              warningOnly: true,
            },
          },
        });
      } else if (
        old.range.startColumnIndex !== index ||
        old.range.endColumnIndex !== index + 1 ||
        (old.range.endRowIndex ?? 0) < protectionRange.endRowIndex
      ) {
        requests.push({
          updateProtectedRange: {
            protectedRange: {
              protectedRangeId: old.protectedRangeId,
              range: protectionRange,
            },
            fields: "range",
          },
        });
      }
    }
    const lookup = column === "priority_code"
      ? "priority"
      : column === "status_code"
      ? "ticket_status"
      : null;
    const codes = lookup
      ? tables.find((source) => source.name === lookup)?.rows.map((row) =>
        String(row[column])
      ) ?? []
      : [];
    if (codes.length) {
      requests.push({
        setDataValidation: {
          range: dataRange,
          rule: {
            condition: {
              type: "ONE_OF_LIST",
              values: codes.map((userEnteredValue) => ({ userEnteredValue })),
            },
            strict: true,
            showCustomUi: true,
          },
        },
      });
    }
    if (lookup) {
      requests.push(
        ...codeRules(
          dataRange,
          column === "status_code" ? STATUS_COLORS : PRIORITY_COLORS,
        ),
      );
    }
    if (table.rows.some((row) => typeof row[column] === "boolean")) {
      requests.push({
        setDataValidation: {
          range: dataRange,
          rule: { condition: { type: "BOOLEAN" }, strict: true },
        },
      });
    }
  });
  return requests;
}

const STATUS_COLORS: [string, number][] = [
  ["open", 0xDBEAFE],
  ["planned", 0xFEF3C7],
  ["complete", 0xD1FAE5],
  ["reopened", 0xFFEDD5],
  ["unsolved", 0xF3F4F6],
  ["cancel", 0xF3F4F6],
];
const PRIORITY_COLORS: [string, number][] = [["urgent", 0xFEE2E2], [
  "no-rush",
  0xDBEAFE,
], ["report", 0xFEF3C7]];
function codeRules(range: unknown, rules: [string, number][]) {
  return rules.map(([userEnteredValue, color]) => ({
    addConditionalFormatRule: {
      index: 0,
      rule: {
        ranges: [range],
        booleanRule: {
          condition: { type: "TEXT_EQ", values: [{ userEnteredValue }] },
          format: {
            backgroundColor: {
              red: (color >> 16 & 255) / 255,
              green: (color >> 8 & 255) / 255,
              blue: (color & 255) / 255,
            },
          },
        },
      },
    },
  }));
}

export function dashboardPresentation(tab: Tab, matrix: SheetRows): unknown[] {
  const sheetId = tab.properties.sheetId;
  const requests: unknown[] = [];
  for (
    let index = (tab.conditionalFormats?.length ?? 0) - 1;
    index >= 0;
    index--
  ) requests.push({ deleteConditionalFormatRule: { sheetId, index } });
  [110, 300, 90, 100, 130, 150, 100, 80].forEach((pixelSize, index) =>
    requests.push({
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: "COLUMNS",
          startIndex: index,
          endIndex: index + 1,
        },
        properties: { pixelSize },
        fields: "pixelSize",
      },
    })
  );
  matrix.forEach((row, index) => {
    const range = (column: number) => ({
      sheetId,
      startRowIndex: index,
      endRowIndex: index + 1,
      startColumnIndex: column,
      endColumnIndex: column + 1,
    });
    if (
      [
        "Open tickets — oldest first",
        "Ticket",
        "Solved by staff",
        "Staff",
        "Recent activity",
      ].includes(String(row[0]))
    ) {
      requests.push({
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: index,
            endRowIndex: index + 1,
            startColumnIndex: 0,
            endColumnIndex: 8,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.12, green: 0.16, blue: 0.22 },
              textFormat: {
                bold: true,
                foregroundColor: { red: 1, green: 1, blue: 1 },
              },
            },
          },
          fields: "userEnteredFormat",
        },
      });
    }
    const dateColumn = typeof row[5] === "number"
      ? 5
      : typeof row[3] === "number"
      ? 3
      : -1;
    if (dateColumn >= 0) {
      requests.push({
        repeatCell: {
          range: range(dateColumn),
          cell: {
            userEnteredFormat: {
              numberFormat: {
                type: "DATE_TIME",
                pattern: "yyyy-mm-dd hh:mm:ss",
              },
            },
          },
          fields: "userEnteredFormat.numberFormat",
        },
      });
    }
    row.forEach((value, column) => {
      if (STATUS_COLORS.some(([code]) => code === value)) {
        requests.push(...codeRules(range(column), STATUS_COLORS));
      }
      if (PRIORITY_COLORS.some(([code]) => code === value)) {
        requests.push(...codeRules(range(column), PRIORITY_COLORS));
      }
    });
  });
  requests.push({
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: 4,
        endRowIndex: 5,
        startColumnIndex: 0,
        endColumnIndex: 8,
      },
      cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 18 } } },
      fields: "userEnteredFormat.textFormat",
    },
  });
  return requests;
}
