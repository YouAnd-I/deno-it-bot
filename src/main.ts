import { verifyKey, InteractionType, InteractionResponseType } from "npm:discord-interactions";
import postgres from "npm:postgres";

// ============================================================
// CONFIG
// ============================================================
const PUBLIC_KEY = Deno.env.get("DISCORD_PUBLIC_KEY");
const TOKEN = Deno.env.get("DISCORD_TOKEN");
const DATABASE_URL = Deno.env.get("DATABASE_URL");
const CF_ACCOUNT = Deno.env.get("CLOUDFLARE_ACCOUNT_ID");
const CF_TOKEN = Deno.env.get("CLOUDFLARE_API_TOKEN");
const IT_USER = Deno.env.get("DISCORD_IT_USER") ?? null;

if (!PUBLIC_KEY || !TOKEN || !DATABASE_URL) {
  throw new Error("Missing DISCORD_PUBLIC_KEY / DISCORD_TOKEN / DATABASE_URL");
}

const DISCORD = "https://discord.com/api/v10";
const sql = postgres(DATABASE_URL, { ssl: "require", max: 2 });

const DEFAULT_PRIORITIES = [
  { code: "urgent", description: "Something is broken, failing, or blocking the user right now" },
  { code: "no-rush", description: "A question or a request that can wait; nothing is failing" },
];

const headers = { Authorization: `Bot ${TOKEN}` };

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

// ============================================================
// COMMAND REGISTRATION (runs on cold start, idempotent)
// ============================================================
async function registerCommands() {
  const commands = [
    {
      name: "it",
      description: "Create an IT ticket",
      options: [
        { name: "title", description: "Short summary", type: 3 },
        { name: "description", description: "What happened?", type: 3 },
        {
          name: "priority",
          description: "How urgent is it?",
          type: 3,
          choices: [
            { name: "auto", value: "auto" },
            { name: "urgent", value: "urgent" },
            { name: "no-rush", value: "no-rush" },
          ],
        },
        { name: "attachment", description: "Attach a screenshot or file", type: 11 },
        { name: "assignee", description: "Who should handle this", type: 6 },
      ],
    },
    { name: "ping", description: "Replies with Pong!" },
  ];
  const res = await fetch(`${DISCORD}/applications/${await appId()}/commands`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  console.log("commands registered:", res.status);
}

let cachedAppId: string | null = null;
async function appId(): Promise<string> {
  if (cachedAppId) return cachedAppId;
  const me = await (await fetch(`${DISCORD}/users/@me`, { headers })).json();
  cachedAppId = me.id;
  return me.id;
}

// ============================================================
// ENTRY
// ============================================================
Deno.serve({ port: 8000 }, async (request, ctx) => {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/") {
    return new Response("YouAnd-I IT ticket bot (HTTP) is running");
  }
  if (request.method !== "POST" || url.pathname !== "/interactions") {
    return new Response("Not Found", { status: 404 });
  }

  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp) return new Response("Unauthorized", { status: 401 });
  const rawBody = await request.text();
  if (!await verifyKey(rawBody, signature, timestamp, PUBLIC_KEY)) {
    return new Response("Invalid signature", { status: 401 });
  }

  const interaction = JSON.parse(rawBody);
  void audit(interaction); // every interaction lands in the audit tables

  try {
    switch (interaction.type) {
      case InteractionType.PING:
        return jsonResponse({ type: InteractionResponseType.PONG });

      case InteractionType.APPLICATION_COMMAND: {
        if (interaction.data.name === "ping") {
          return jsonResponse({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "Pong! 🏓" },
          });
        }
        if (interaction.data.name === "it") return itCommand(interaction, ctx);
        return jsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "Unknown command!", flags: 64 },
        });
      }

      case InteractionType.MODAL_SUBMIT:
        return modalSubmit(interaction, ctx);

      case InteractionType.MESSAGE_COMPONENT:
        return component(interaction, ctx);
    }
    return new Response("Unsupported interaction", { status: 400 });
  } catch (error) {
    console.error("interaction error:", error);
    return jsonResponse({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Something went wrong handling that — try again.", flags: 64 },
    });
  }
});

void registerCommands();
console.log("HTTP IT ticket bot started!");

// ============================================================
// /it
// ============================================================
function itCommand(interaction: any, ctx: any) {
  const options = Object.fromEntries(
    (interaction.data.options ?? []).map((o: any) => [o.name, o.value]),
  );

  if (Object.keys(options).length === 0) {
    // No arguments: open the big form
    return jsonResponse({
      type: 9, // MODAL
      data: {
        custom_id: "modal-it-ticket",
        title: "New IT Ticket",
        components: [
          row(textInput("title", "Title", TextInputStyle.SHORT)),
          row(textInput("description", "Description", TextInputStyle.PARAGRAPH, false)),
          row(select("priority", "Priority", [
            { label: "Auto (let the model decide)", value: "auto", default: true },
            { label: "Urgent", value: "urgent" },
            { label: "No rush", value: "no-rush" },
          ])),
        ],
      },
    });
  }

  const attachments = interaction.data.resolved?.attachments ?? {};
  const attachmentUrl = options.attachment
    ? attachments[String(options.attachment)]?.url ?? null
    : null;
  const users = interaction.data.resolved?.users ?? {};
  const assignee = options.assignee ? String(options.assignee) : null;

  const run = createTicket(interaction, {
    title: options.title ?? null,
    description: options.description ?? null,
    priority: options.priority ?? "auto",
    attachmentUrl,
    assigneeId: assignee,
  });
  ctx?.waitUntil?.(run) ?? void run;
  return jsonResponse({ type: 5, data: { flags: 64 } }); // deferred ephemeral
}

const TextInputStyle = { SHORT: 1, PARAGRAPH: 2 } as const;
const row = (...components: any[]) => ({ type: 1, components });
const textInput = (id: string, label: string, style: number, required = true) => ({
  type: 4, custom_id: id, label, style, max_length: 2000, required,
});
// Selects have no label/required fields — placeholder only, or Discord
// rejects the modal and nothing opens.
const select = (id: string, placeholder: string, options: any[]) => ({
  type: 3, custom_id: id, placeholder, options,
});

// ============================================================
// MODALS
// ============================================================
function modalSubmit(interaction: any, ctx: any) {
  const customId: string = interaction.data.custom_id;
  const fields = modalFields(interaction);

  if (customId === "modal-it-ticket") {
    const run = createTicket(interaction, {
      title: fields.text.title ?? null,
      description: fields.text.description ?? null,
      priority: fields.select.priority?.[0] ?? "auto",
      attachmentUrl: null,
      assigneeId: null,
    });
    ctx?.waitUntil?.(run) ?? void run;
    return jsonResponse({ type: 5, data: { flags: 64 } });
  }

  if (customId.startsWith("notemodal:")) {
    const ticketId = customId.slice("notemodal:".length);
    const note = fields.text.note;
    const run = (async () => {
      const count = await addNote(ticketId, user(interaction), note);
      await followup(interaction, {
        content: `📝 Note added to \`${ticketId}\` (${count} total).`,
        flags: 64,
      });
    })();
    ctx?.waitUntil?.(run) ?? void run;
    return jsonResponse({ type: 5, data: { flags: 64 } });
  }

  if (customId.startsWith("reportmodal:")) {
    const ticketId = customId.slice("reportmodal:".length);
    const anonymous = (fields.select.anonymous?.[0] ?? "yes") === "yes";
    const run = (async () => {
      await fileReport(
        ticketId,
        anonymous ? null : user(interaction),
        fields.text.complaint ?? "(none)",
        fields.text.action ?? "",
      );
      await changeStatus(ticketId, user(interaction), "complete");
      await followup(interaction, {
        content: `🤐 Report filed on \`${ticketId}\`${
          anonymous ? " anonymously" : ""
        }. The ticket is marked complete. This report is confidential.`,
        flags: 64,
      });
    })();
    ctx?.waitUntil?.(run) ?? void run;
    return jsonResponse({ type: 5, data: { flags: 64 } });
  }

  return jsonResponse({ type: 4, data: { content: "Unknown form.", flags: 64 } });
}

function modalFields(interaction: any) {
  const text: Record<string, string> = {};
  const values: Record<string, string[]> = {};
  for (const row of interaction.data.components ?? []) {
    for (const c of row.components ?? []) {
      if (c.type === 4 && c.value != null) text[c.custom_id] = c.value;
      if (c.type === 3 && Array.isArray(c.values)) values[c.custom_id] = c.values;
    }
  }
  return { text, select: values };
}

// ============================================================
// BUTTONS
// ============================================================
function component(interaction: any, ctx: any) {
  const customId: string = interaction.data.custom_id;

  if (customId.startsWith("itstatus:")) {
    const [, status, ticketId] = customId.split(":");
    return updateCard(interaction, ctx, async () => {
      await changeStatus(ticketId, user(interaction), status);
    });
  }
  if (customId.startsWith("itreopen:")) {
    const ticketId = customId.slice("itreopen:".length);
    return updateCard(interaction, ctx, async () => {
      await changeStatus(ticketId, user(interaction), "reopened");
    });
  }
  if (customId.startsWith("itnote:")) {
    const ticketId = customId.slice("itnote:".length);
    return jsonResponse({
      type: 9,
      data: {
        custom_id: `notemodal:${ticketId}`,
        title: `Note on ticket ${ticketId}`,
        components: [row(textInput("note", "Follow-up note", TextInputStyle.PARAGRAPH))],
      },
    });
  }
  if (customId.startsWith("itreport:")) {
    const ticketId = customId.slice("itreport:".length);
    return jsonResponse({
      type: 9,
      data: {
        custom_id: `reportmodal:${ticketId}`,
        title: "Confidential Report",
        components: [
          row(textInput("complaint", "Your complaint", TextInputStyle.PARAGRAPH)),
          row(textInput("action", "What action should have been taken?", TextInputStyle.PARAGRAPH)),
          row(select("anonymous", "Stay anonymous?", [
            { label: "Yes — don't attach my name", value: "yes", default: true },
            { label: "No — attach my name", value: "no" },
          ])),
        ],
      },
    });
  }
  return jsonResponse({ type: 4, data: { content: "Unknown button.", flags: 64 } });
}

// Runs the (fast, DB-only) work, then swaps the card for the fresh state.
function updateCard(interaction: any, ctx: any, work: () => Promise<void>) {
  const ticketId = (interaction.data.custom_id.match(/[0-9a-f]{8}$/) ?? [])[0]
    ?? interaction.data.custom_id.split(":").pop();
  const run = (async () => {
    await work();
    const view = await loadView(ticketId);
    await followup(interaction, {
      content: card(view, statusOf(view)),
      components: buttons(ticketId),
    }, /* ephemeral default */ undefined, true);
  })();
  ctx?.waitUntil?.(run) ?? void run;
  return jsonResponse({ type: 6 }); // DEFERRED_UPDATE_MESSAGE
}

// ============================================================
// TICKET CREATION (classification + persistence + delivery)
// ============================================================
async function createTicket(interaction: any, input: {
  title: string | null;
  description: string | null;
  priority: string;
  attachmentUrl: string | null;
  assigneeId: string | null;
}) {
  try {
    await createTicketInner(interaction, input);
  } catch (e: any) {
    console.error("createTicket failed:", e);
    try {
      await followup(interaction, {
        content: `⚠️ Could not create the ticket: ${e.message ?? e}. Try again.`,
        flags: 64,
      });
    } catch { /* nothing more we can do */ }
  }
}

async function createTicketInner(interaction: any, input: {
  title: string | null;
  description: string | null;
  priority: string;
  attachmentUrl: string | null;
  assigneeId: string | null;
}) {
  const requester = user(interaction);
  const text = `${input.title ?? ""} ${input.description ?? ""}`.trim();
  const auto = input.priority === "auto";

  let priority = auto ? "no-rush" : input.priority;
  let classified = false;
  let offline = false;
  let routedId = input.assigneeId;

  if (auto && text) {
    const staff = (await availableStaff()) as any[];
    const classified_ = await classify(text, staff);
    if (classified_) {
      priority = classified_.priority;
      classified = true;
      if (!routedId && classified_.assignee) routedId = classified_.assignee;
    } else {
      priority = "urgent";
      offline = true;
    }
    if (!routedId) routedId = staff[0]?.user_id ?? IT_USER;
  } else if (!routedId) {
    routedId = (await availableStaff())[0]?.user_id ?? IT_USER;
  }

  const ticketId = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  await upsertUser(requester);
  await sql`insert into priority (priority_code) values (${priority}) on conflict do nothing`;
  const routed = routedId && routedId !== requester.id ? routedId : null;
  if (routed) await ensureUser(routed);
  await sql`
    insert into ticket
      (ticket_id, requester_user_id, assignee_user_id, title, description,
       attachment_url, priority_code, classified_automatically, classifier_offline, created_at_utc)
    values
      (${ticketId}, ${requester.id}::bigint, ${routed?.toString() ?? null}::bigint, ${input.title}, ${input.description},
       ${input.attachmentUrl}, ${priority}, ${classified}, ${offline}, now())`;
  await sql`
    insert into ticket_status_event (ticket_id, status_code, actor_user_id, occurred_at_utc)
    values (${ticketId}, 'open', ${requester.id}::bigint, now())`;

  const view = await loadView(ticketId);
  const content = card(view, "created");
  const btns = buttons(ticketId);
  const media = await download(input.attachmentUrl);

  // DM the requester the card; fall back to the channel if their DMs are closed.
  let delivered = false;
  if (interaction.guild_id) {
    try {
      await dm(requester.id, content, btns, media);
      delivered = true;
    } catch (e: any) {
      console.log(`[it] DM failed (${e.message ?? e}); card goes to the channel`);
    }
  }
  await followup(
    interaction,
    delivered
      ? { content: `**IT ticket \`${ticketId}\` created** — sent to your DMs 📬`, flags: 64 }
      : { content, components: btns, flags: interaction.guild_id ? 64 : 0 },
    media,
  );

  // Tell the assigned staff member (skip when they filed it themselves).
  if (routed && routed !== requester.id) {
    try {
      await dm(
        routed,
        `**Ticket \`${ticketId}\` assigned to you** — <@${requester.id}>\n${content}`,
        btns,
        media,
      );
    } catch (e: any) {
      console.log(`[assign] notify failed (${e.message ?? e})`);
    }
  }
}

// ============================================================
// CLOUDFLARE CLEF CLASSIFIER
// ============================================================
async function classify(text: string, staff: { user_id: string; name: string; handles: string }[]) {
  if (!CF_ACCOUNT || !CF_TOKEN) return null;
  const priorities = await sql`
    select priority_code as code, description from priority order by priority_code`;
  const criteria = Object.fromEntries(
    (priorities.length ? priorities : DEFAULT_PRIORITIES)
      .map((p: any) => [p.code, p.description || p.code]),
  );
  const questions: Record<string, unknown> = {
    priority: {
      type: "choice",
      instructions: "How should this support ticket be prioritized?",
      criteria,
    },
  };
  if (staff.length >= 2) {
    questions.assignee = {
      type: "choice",
      instructions: "Which on-duty IT staff member should this ticket go to?",
      criteria: Object.fromEntries(
        staff.map((s) => [
          s.user_id,
          s.handles ? `${s.name} — ${s.handles}` : s.name,
        ]),
      ),
    };
  }
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/@cf/cloudflare/clef`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CF_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "clef",
          state: `Today is ${new Date().toISOString()}. A user submitted a support ticket: ${text}`,
          questions,
        }),
      },
    );
    const body = await res.json();
    if (!res.ok || !body.success) throw new Error(`HTTP ${res.status}`);
    const answers = body.result.answers;
    const priority = answers.priority?.choice === "no-rush" ? "no-rush" : "urgent";
    const assignee = staff.length >= 2 && answers.assignee?.choice &&
        staff.some((s) => s.user_id === answers.assignee.choice)
      ? answers.assignee.choice
      : null;
    return { priority, assignee };
  } catch (e: any) {
    console.log(`[cloudflare] classify failed: ${e.message ?? e}`);
    return null;
  }
}

async function availableStaff() {
  return await sql`
    select user_id::text, display_name as name, handles
    from it_staff
    where active
      and not exists (
        select 1 from it_staff_absence a
        where a.user_id = it_staff.user_id
          and now() >= a.from_utc and now() <= a.until_utc)
    order by user_id`;
}

// ============================================================
// TICKET ACTIONS
// ============================================================
async function changeStatus(ticketId: string, actor: { id: string; username: string }, status: string) {
  await upsertUser(actor);
  await sql`insert into ticket_status (status_code) values (${status}) on conflict do nothing`;
  await sql`
    insert into ticket_status_event (ticket_id, status_code, actor_user_id, occurred_at_utc)
    values (${ticketId}, ${status}, ${actor.id}::bigint, now())`;
}

async function addNote(ticketId: string, actor: { id: string; username: string }, note: string) {
  await upsertUser(actor);
  await sql`
    insert into ticket_note (ticket_id, author_user_id, note_text, created_at_utc)
    values (${ticketId}, ${actor.id}::bigint, ${note}, now())`;
  const [row] = await sql`
    select count(*)::int as n from ticket_note where ticket_id = ${ticketId}`;
  return row?.n ?? 0;
}

async function fileReport(
  ticketId: string,
  actor: { id: string; username: string } | null,
  complaint: string,
  action: string,
) {
  if (actor) await upsertUser(actor);
  await sql`
    insert into ticket_report (ticket_id, filed_by_user_id, complaint, action_taken, filed_at_utc)
    values (${ticketId}, ${actor?.id ?? null}::bigint, ${complaint}, ${action}, now())`;
}

// ============================================================
// VIEW + CARD
// ============================================================
type View = any;

async function loadView(ticketId: string): Promise<View> {
  const [row] = await sql`
    select t.ticket_id, t.title, t.description, t.attachment_url, t.priority_code,
           t.classified_automatically, t.classifier_offline, t.created_at_utc,
           u.username as requester_name,
           (select s.status_code from ticket_status_event s
             where s.ticket_id = t.ticket_id
             order by s.occurred_at_utc desc, s.status_event_id desc limit 1) as status,
           (select count(*)::int from ticket_note n where n.ticket_id = t.ticket_id) as notes
    from ticket t
    left join discord_user u on u.user_id = t.requester_user_id
    where t.ticket_id = ${ticketId}`;
  if (!row) return { ticket_id: ticketId, exists: false };
  return row;
}

const statusOf = (v: View) => v?.status ?? "open";

function card(v: View, heading: string): string {
  const head = `**IT ticket \`${v.ticket_id}\`** — ${heading}`;
  if (!v.exists) return head;
  const age = Math.floor(new Date(v.created_at_utc).getTime() / 1000);
  const lines = [
    `${head} — <t:${age}:R>`,
    `**Priority:** ${v.priority_code}${v.classified_automatically ? " _(model)_" : ""}${
      v.classifier_offline ? " ⚠️ _classifier offline, urgent assumed_" : ""
    }`,
    `**By:** ${v.requester_name ? `@${v.requester_name}` : "unknown"}`,
  ];
  if (v.title) lines.push(`**${v.title}**`);
  if (v.description) lines.push(v.description);
  if (v.attachment_url) lines.push(`📎 ${v.attachment_url}`);
  if (v.notes > 0) lines.push(`🗒️ ${v.notes} note${v.notes === 1 ? "" : "s"}`);
  return lines.join("\n");
}

function buttons(ticketId: string) {
  const b = (label: string, customId: string, style: number) => ({
    type: 2, label, custom_id: customId, style,
  });
  return [
    {
      type: 1,
      components: [
        b("Complete", `itstatus:complete:${ticketId}`, 3),
        b("Planned", `itstatus:planned:${ticketId}`, 2),
        b("Unsolved", `itstatus:unsolved:${ticketId}`, 4),
        b("Cancel", `itstatus:cancel:${ticketId}`, 1),
      ],
    },
    {
      type: 1,
      components: [
        b("Reopen", `itreopen:${ticketId}`, 1),
        b("Add note", `itnote:${ticketId}`, 1),
        b("Report", `itreport:${ticketId}`, 4),
      ],
    },
  ];
}

// ============================================================
// DISCORD DELIVERY
// ============================================================
const user = (i: any) => ({
  id: i.member?.user?.id ?? i.user?.id,
  username: i.member?.user?.username ?? i.user?.username ?? "",
});

async function followup(interaction: any, payload: any, media?: Media | null, editOriginal = false) {
  const url = `${DISCORD}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  const method = editOriginal ? "PATCH" : "POST";
  const endpoint = editOriginal ? url : `${DISCORD}/webhooks/${interaction.application_id}/${interaction.token}`;
  const res = await (media?.bytes
    ? multipart(endpoint, method, payload, media)
    : fetch(endpoint, {
      method: editOriginal ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editOriginal ? payload : { ...payload, ...{ wait: true } }),
    }));
  if (!res.ok) console.log(`[discord] followup ${res.status}: ${await res.text()}`);
  return res;
}

async function dm(userId: string, content: string, components: any, media?: Media | null) {
  const channel = await (await fetch(`${DISCORD}/users/@me/channels`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ recipient_id: userId }),
  })).json();
  if (!channel.id) throw new Error(channel.message ?? "no DM channel");
  const payload = { content, components };
  const res = await (media?.bytes
    ? multipart(`${DISCORD}/channels/${channel.id}/messages`, "POST", payload, media)
    : fetch(`${DISCORD}/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }));
  if (!res.ok) throw new Error(`DM send ${res.status}`);
}

type Media = { name: string; bytes: Uint8Array } | null;

async function download(url: string | null): Promise<Media> {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    const name = new URL(url).pathname.split("/").pop() || "attachment";
    return { name, bytes: new Uint8Array(await res.arrayBuffer()) };
  } catch (e: any) {
    console.log(`[it] could not re-attach media: ${e.message ?? e}`);
    return null;
  }
}

function multipart(url: string, method: string, payload: any, media: NonNullable<Media>) {
  const form = new FormData();
  form.append(
    "payload_json",
    JSON.stringify({ ...payload, attachments: [{ id: 0, filename: media.name, description: "ticket attachment" }] }),
  );
  form.append("files[0]", new Blob([media.bytes as BlobPart]), media.name);
  return fetch(url, { method, headers, body: form });
}

// ============================================================
// USERS
// ============================================================
async function upsertUser(u: { id: string; username: string }) {
  if (!u?.id) return;
  await ensureUser(u.id, u.username);
}

async function ensureUser(id: string, username = "") {
  await sql`
    insert into discord_user (user_id, username, first_seen_at_utc, last_seen_at_utc)
    values (${id}, ${username}, now(), now())
    on conflict (user_id) do update set last_seen_at_utc = now()`;
}

// ============================================================
// AUDIT (every interaction, same tables as the ECS bot)
// ============================================================
async function audit(interaction: any) {
  try {
    const kind = interaction.type === 2
      ? "slash"
      : interaction.type === 5
      ? "modal"
      : "component";
    const name = interaction.data?.name ?? interaction.data?.custom_id ?? "?";
    const ticketId = name.match(/[0-9a-f]{8}$/)?.[0] ?? null;
    const u = user(interaction);
    if (u.id) await ensureUser(u.id, u.username);
    await sql`
      insert into interaction
        (interaction_id, kind_code, name, ticket_id, user_id, channel_id, guild_id, received_at_utc)
      values
        (${interaction.id}::bigint, ${kind}, ${name}, ${ticketId},
         ${u.id ?? null}::bigint, ${interaction.channel_id ?? null}::bigint,
         ${interaction.guild_id ?? null}::bigint, now())
      on conflict (interaction_id) do nothing`;
    const options = (interaction.data?.options ?? []).map((o: any) => [o.name, String(o.value)]);
    for (const row of interaction.data?.components ?? []) {
      for (const c of row.components ?? []) {
        if (c.type === 4 && c.value != null) options.push([c.custom_id, c.value]);
        if (c.type === 3 && Array.isArray(c.values)) {
          for (const v of c.values) options.push([c.custom_id, v]);
        }
      }
    }
    for (const [name_, value] of options) {
      await sql`
        insert into interaction_option (interaction_id, option_name, option_value)
        values (${interaction.id}::bigint, ${name_}, ${value})`;
    }
  } catch (e: any) {
    console.log(`[audit] failed: ${e.message ?? e}`);
  }
}

// ============================================================
// GOOGLE SHEET DIRECTORY SYNC (sheet -> Neon, every 10 minutes)
// The sheet's priority / it_staff / it_staff_absence tabs are the
// editing UI; the bot reads the tables. Staff rows removed from the
// sheet are deactivated via the Active column, never deleted.
// ============================================================
const GOOGLE = {
  clientId: Deno.env.get("GOOGLE_CLIENT_ID"),
  clientSecret: Deno.env.get("GOOGLE_CLIENT_SECRET"),
  refreshToken: Deno.env.get("GOOGLE_REFRESH_TOKEN"),
  spreadsheetId: Deno.env.get("GOOGLE_SPREADSHEET_ID"),
};

async function googleToken(): Promise<string | null> {
  if (!GOOGLE.clientId || !GOOGLE.clientSecret || !GOOGLE.refreshToken) return null;
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE.clientId,
        client_secret: GOOGLE.clientSecret,
        refresh_token: GOOGLE.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    return (await res.json()).access_token ?? null;
  } catch (e: any) {
    console.log(`[sheets] token failed: ${e.message ?? e}`);
    return null;
  }
}

async function sheetRows(token: string, tab: string): Promise<string[][]> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE.spreadsheetId}/values/${
      encodeURIComponent(tab)
    }`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`${tab}: HTTP ${res.status}`);
  return (await res.json()).values ?? [];
}

async function syncDirectory() {
  const token = await googleToken();
  if (!token) return;
  try {
    const rows = await sheetRows(token, "priority");
    const [head, ...body] = rows;
    const at = (r: string[], n: string) => r[head.indexOf(n)];
    const codes: string[] = [];
    for (const r of body) {
      const code = at(r, "Priority Code");
      if (!code) continue;
      codes.push(code);
      await sql`insert into priority (priority_code, description)
                values (${code}, ${at(r, "Description") ?? ""})
                on conflict (priority_code) do update set description = excluded.description`;
    }
    if (codes.length) {
      await sql`delete from priority
                where not (priority_code = any(${codes}::text[]))
                  and not exists (select 1 from ticket t where t.priority_code = priority.priority_code)`;
    }

    const staffRows = await sheetRows(token, "it_staff");
    const [sHead, ...sBody] = staffRows;
    const sAt = (r: string[], n: string) => r[sHead.indexOf(n)];
    for (const r of sBody) {
      const id = sAt(r, "User Id");
      if (!id || !/^\d+$/.test(id)) continue;
      await sql`insert into it_staff (user_id, display_name, active, handles)
                values (${id}::bigint, ${sAt(r, "Display Name") ?? ""},
                        ${(sAt(r, "Active") ?? "TRUE").toUpperCase() !== "FALSE"},
                        ${sAt(r, "Handles") ?? ""})
                on conflict (user_id) do update set display_name = excluded.display_name,
                  active = excluded.active, handles = excluded.handles`;
    }

    const absRows = await sheetRows(token, "it_staff_absence");
    const [aHead, ...aBody] = absRows;
    if (aHead) {
      const aAt = (r: string[], n: string) => r[aHead.indexOf(n)];
      await sql`delete from it_staff_absence`;
      for (const r of aBody) {
        const uid = aAt(r, "User Id");
        const from = aAt(r, "From Utc"), until = aAt(r, "Until Utc");
        if (!uid || !/^\d+$/.test(uid) || !from || !until) continue;
        await sql`insert into it_staff_absence (user_id, from_utc, until_utc, note)
                  values (${uid}::bigint, ${from}::timestamptz, ${until}::timestamptz,
                          ${aAt(r, "Note") ?? ""})`;
      }
    }
    console.log("[sheets] directory synced");
  } catch (e: any) {
    console.log(`[sheets] sync failed: ${e.message ?? e}`);
  }
}

Deno.cron("sheet-directory-sync", "*/10 * * * *", () => syncDirectory());
void syncDirectory();
