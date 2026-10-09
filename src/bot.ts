import { verifyKey } from "discord-interactions";
import {
  buttons,
  card,
  FRUITS,
  type Interaction,
  label,
  message,
  messagePayload,
  modalFields,
  noteModal,
  reportModal,
  textInput,
  ticketIdOf,
  type TicketInput,
  ticketModal,
  user,
} from "./protocol.ts";
import {
  applyJob,
  availableStaff,
  claimJob,
  cleanJobs,
  type Database,
  enqueueJob,
  finishJob,
  initializeDatabase,
  type Job,
  type JobPayload,
  loadView,
  markDelivery,
  recordInteraction,
  retryJob,
} from "./storage.ts";
import {
  classify,
  demoComponents,
  DiscordClient,
  download,
  type Fetch,
} from "./integrations.ts";
import { type SheetsOptions, SheetsSync } from "./sheets.ts";
import { publicPage } from "./pages.ts";

export type BotConfig = {
  publicKey: string;
  token: string;
  applicationId?: string;
  itUser?: string;
  cloudflareAccount?: string;
  cloudflareToken?: string;
  google?: SheetsOptions;
  registerCommands?: boolean;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const logError = (area: string, error: unknown) =>
  console.error(
    `[${area}]`,
    error instanceof Error ? error.message : "unknown error",
  );

export function createBot(
  config: BotConfig,
  sql: Database,
  http: Fetch = fetch,
) {
  const discord = new DiscordClient(config.token, http, config.applicationId);
  const sheets = new SheetsSync(sql, config.google ?? {}, http);
  let ready = false;
  let initializing: Promise<void> | null = null;
  let working = false;

  function initialize(): Promise<void> {
    if (ready) return Promise.resolve();
    if (!initializing) {
      initializing = initializeDatabase(sql, config.itUser).then(() => {
        ready = true;
      }).finally(() => {
        initializing = null;
      });
    }
    return initializing;
  }

  function background(action: () => Promise<unknown>, area: string) {
    setTimeout(() => {
      void action().catch((error) => logError(area, error));
    }, 0);
  }

  async function queue(
    payload: JobPayload,
    ticketId: string,
    responseType: number,
  ) {
    if (!ready) {
      return json(
        message(
          "The ticket service is starting. Please try again in a few seconds.",
        ),
      );
    }
    if (!user(payload.interaction).id) {
      return json(message("This interaction has no Discord user."));
    }
    await enqueueJob(sql, payload, ticketId);
    return json({
      type: responseType,
      ...(responseType === 5 ? { data: { flags: 64 } } : {}),
    });
  }

  function dispatch(interaction: Interaction): Response | Promise<Response> {
    const data = interaction.data ?? {};
    const options = Object.fromEntries(
      (data.options ?? []).map((option) => [option.name, option.value]),
    );
    if (interaction.type === 4) {
      const focused = (data.options ?? []).find((option) =>
        option.focused
      )?.value ?? "";
      return json({
        type: 8,
        data: {
          choices: data.name === "fruit"
            ? FRUITS.filter((fruit) =>
              fruit.includes(String(focused).toLowerCase())
            ).slice(0, 25).map((fruit) => ({ name: fruit, value: fruit }))
            : [],
        },
      });
    }
    if (interaction.type === 2) {
      switch (data.name) {
        case "it": {
          if (!Object.keys(options).length) return json(ticketModal());
          const input: TicketInput = {
            title: options.title == null ? null : String(options.title),
            description: options.description == null
              ? null
              : String(options.description),
            priority: String(options.priority ?? "auto"),
            attachmentUrl:
              data.resolved?.attachments?.[String(options.attachment)]?.url ??
                null,
            assigneeId: options.assignee ? String(options.assignee) : null,
          };
          return queue(
            { interaction, operation: "create", input },
            crypto.randomUUID().replaceAll("-", "").slice(0, 8),
            5,
          );
        }
        case "ping":
          return json(message("Pong You!!"));
        case "greet":
          return json(
            message(`${options.message}, <@${options.user}>!`, false),
          );
        case "tools": {
          const command = data.options?.[0];
          const value = command?.options?.[0]?.value;
          return json(
            message(
              command?.name === "square"
                ? `${value}² = ${Number(value) * Number(value)}`
                : String(value ?? ""),
              false,
            ),
          );
        }
        case "fruit":
          return json(message(`You picked **${options.fruit}**!`, false));
        case "components":
          return json({
            type: 4,
            data: {
              content: "Click a button or pick a color:",
              components: demoComponents(),
            },
          });
        case "form":
          return json({
            type: 9,
            data: {
              custom_id: "modal-hello",
              title: "Tell me something",
              components: [label("Message", textInput("text"))],
            },
          });
        case "User Info":
          return json(
            message(`<@${data.target_id}> — ID \`${data.target_id}\``),
          );
        case "Echo Message":
          return json(
            message(
              `Echo: ${
                data.resolved?.messages?.[data.target_id ?? ""]?.content ?? ""
              }`,
            ),
          );
        default:
          return json(message("Unknown command."));
      }
    }
    const customId = data.custom_id ?? "";
    if (interaction.type === 3) {
      if (customId === "btn-hello") return json(message("Hi!", false));
      if (customId === "menu-color") {
        return json(
          message(`You chose: **${(data.values ?? []).join(", ")}**`, false),
        );
      }
      const ticketId = ticketIdOf(customId);
      if (!ticketId) return json(message("Unknown button."));
      if (customId.startsWith("itnote:")) return json(noteModal(ticketId));
      if (customId.startsWith("itreport:")) return json(reportModal(ticketId));
      return queue(
        {
          interaction,
          operation: "status",
          status: customId.startsWith("itreopen:")
            ? "reopened"
            : customId.split(":")[1],
        },
        ticketId,
        6,
      );
    }
    if (interaction.type === 5) {
      const fields = modalFields(interaction);
      if (customId === "modal-hello") {
        return json(
          message("You wrote: " + Object.values(fields.text).join(", "), false),
        );
      }
      if (customId === "modal-it-ticket") {
        return queue(
          {
            interaction,
            operation: "create",
            input: {
              title: fields.text.title ?? null,
              description: fields.text.description ?? null,
              priority: fields.select.priority?.[0] ?? "auto",
              attachmentUrl: fields.files.file ?? null,
              assigneeId: null,
            },
          },
          crypto.randomUUID().replaceAll("-", "").slice(0, 8),
          5,
        );
      }
      const ticketId = ticketIdOf(customId);
      if (!ticketId) return json(message("Unknown form."));
      if (customId.startsWith("notemodal:")) {
        if (!fields.text.note?.trim()) {
          return json(message("Please enter a follow-up note."));
        }
        return queue(
          { interaction, operation: "note", note: fields.text.note },
          ticketId,
          interaction.message ? 6 : 5,
        );
      }
      if (customId.startsWith("reportmodal:")) {
        return queue(
          {
            interaction,
            operation: "report",
            complaint: fields.text.complaint ?? "",
            action: fields.text.action ?? "",
            fileUrl: fields.files.reportfile ?? null,
            anonymous: fields.checked.anonymous ??
              fields.select.anonymous?.[0] !== "no",
          },
          ticketId,
          interaction.message ? 6 : 5,
        );
      }
    }
    return json(message("Unsupported interaction."));
  }

  async function fetchRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET") {
      const page = publicPage(url.pathname);
      if (page) return page;
      if (url.pathname === "/") {
        return new Response("YouAnd-I IT ticket bot (HTTP) is running");
      }
      if (url.pathname === "/ready") return json({ ready }, ready ? 200 : 503);
    }
    if (request.method !== "POST" || url.pathname !== "/interactions") {
      return new Response("Not Found", { status: 404 });
    }
    const signature = request.headers.get("X-Signature-Ed25519");
    const timestamp = request.headers.get("X-Signature-Timestamp");
    const body = await request.text();
    try {
      if (
        !signature || !timestamp || !/^\d+$/.test(timestamp) ||
        Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
        !await verifyKey(body, signature, timestamp, config.publicKey)
      ) return new Response("Invalid signature", { status: 401 });
    } catch {
      return new Response("Invalid signature", { status: 401 });
    }
    let interaction: Interaction;
    try {
      interaction = JSON.parse(body);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    if (!interaction || typeof interaction.type !== "number") {
      return new Response("Invalid interaction", { status: 400 });
    }
    if (interaction.type === 1) return json({ type: 1 });
    const response = await handleInteraction(interaction);
    background(processPending, "jobs");
    return response;
  }

  async function handleInteraction(
    interaction: Interaction,
  ): Promise<Response> {
    if (interaction.type === 1) return json({ type: 1 });
    background(async () => {
      await initialize();
      await recordInteraction(sql, interaction);
    }, "audit");
    try {
      return await dispatch(interaction);
    } catch (error) {
      logError("interaction", error);
      return json(
        message("Could not handle this interaction. Please try again."),
      );
    }
  }

  async function handleGatewayInteraction(interaction: Interaction) {
    const response = await handleInteraction(interaction);
    const payload = await response.json();
    await discord.respond(interaction, payload);
    console.log(
      `[discord] acknowledged ${interaction.id} ${
        interaction.data?.name ?? interaction.data?.custom_id ??
          interaction.type
      }`,
    );
    if (payload.type === 5 || payload.type === 6) {
      background(processPending, "jobs");
    }
  }

  async function createClassification(job: Job) {
    const input = job.payload.input!;
    const staff = await availableStaff(sql);
    const text = `${input.title ?? ""} ${input.description ?? ""}`.trim();
    const auto = input.priority === "auto";
    const classified = auto && text
      ? await classify(
        sql,
        text,
        staff,
        config.cloudflareAccount,
        config.cloudflareToken,
        http,
      )
      : null;
    const offline = auto && Boolean(text) && !classified;
    let assignee = input.assigneeId ?? classified?.assignee ??
      staff[0]?.user_id ?? null;
    if (!assignee && config.itUser) {
      const [roster] =
        await sql`select exists(select 1 from it_staff) as populated`;
      if (!roster.populated) assignee = config.itUser;
    }
    return {
      priority: auto
        ? offline ? "urgent" : classified?.priority ?? "no-rush"
        : input.priority === "no-rush"
        ? "no-rush"
        : "urgent",
      assignee,
      offline,
      auto: auto && !offline,
    };
  }

  async function deliver(job: Job) {
    const payload = job.payload;
    const interaction = payload.interaction;
    let view = await loadView(sql, job.ticket_id);
    const actor = user(interaction);
    if (payload.operation === "create") {
      const media = await download(view.attachment_url, http);
      if (!job.result.requesterDelivered) {
        const content = messagePayload(
          card(view, "created"),
          buttons(job.ticket_id, view.status),
        );
        try {
          const channel = interaction.channel_id ?? interaction.channel?.id;
          const result = !interaction.guild_id && channel
            ? await discord.sendMessage(channel, content, interaction.id, media)
            : await discord.dm(actor.id, content, interaction.id, media);
          job.result.delivery = !interaction.guild_id && channel
            ? "channel"
            : "dm";
          if (result.attachments?.[0]?.url) {
            await sql`update ticket set attachment_url = ${
              result.attachments[0].url
            } where ticket_id = ${job.ticket_id}`;
            view = await loadView(sql, job.ticket_id);
          }
        } catch (error) {
          logError("requester delivery", error);
          await discord.editOriginal(
            interaction,
            { ...content, flags: 64 },
            media,
          );
          job.result.delivery = "original";
        }
        await markDelivery(sql, job, "requesterDelivered");
      }
      if (job.result.delivery !== "original") {
        await discord.editOriginal(
          interaction,
          messagePayload(
            `**IT ticket \`${job.ticket_id}\` created** — ${
              job.result.delivery === "dm"
                ? "sent to your DMs 📬"
                : "posted in this conversation"
            }`,
          ),
        );
      }
      if (
        !job.result.staffDelivered && view.assignee_user_id &&
        view.assignee_user_id !== actor.id
      ) {
        await discord.dm(
          view.assignee_user_id,
          messagePayload(
            `**Ticket \`${job.ticket_id}\` assigned to you** — from <@${actor.id}>\n` +
              card(view, "created"),
            buttons(job.ticket_id, view.status),
          ),
          interaction.id,
          media,
        );
      }
      await markDelivery(sql, job, "staffDelivered");
    } else {
      const heading = payload.operation === "note"
        ? `note #${view.notes} added`
        : `status updated to \`${view.status}\``;
      await discord.editOriginal(
        interaction,
        messagePayload(
          card(view, heading) +
            (payload.operation === "note" ? `\n> ${payload.note}` : ""),
          buttons(job.ticket_id, view.status),
        ),
      );
      if (payload.operation === "report") {
        const content = messagePayload(
          `Report filed on \`${job.ticket_id}\`${
            payload.anonymous ? " anonymously" : ""
          }. The ticket is complete. Your report is confidential.`,
        );
        if (interaction.message) {
          await discord.followup(interaction, { ...content, flags: 64 });
        } else await discord.editOriginal(interaction, content);
      }
    }
  }

  async function processPending() {
    await initialize();
    if (working) return;
    working = true;
    try {
      await cleanJobs(sql);
      for (let i = 0; i < 20; i++) {
        const job = await claimJob(sql);
        if (!job) break;
        try {
          try {
            await recordInteraction(sql, job.payload.interaction);
          } catch (error) {
            logError("audit", error);
          }
          const classification =
            job.payload.operation === "create" && !job.applied_at_utc
              ? await createClassification(job)
              : undefined;
          await applyJob(sql, job, classification);
          await deliver(job);
          await finishJob(sql, job);
        } catch (error) {
          logError("ticket job", error);
          if (error instanceof Error && error.message === "Ticket not found") {
            await discord.followup(job.payload.interaction, {
              content: "This ticket no longer exists.",
              flags: 64,
            });
            await finishJob(sql, job);
            continue;
          }
          await retryJob(sql, job);
          if (!job.applied_at_utc && job.attempts === 1) {
            try {
              await discord.followup(job.payload.interaction, {
                content:
                  "Ticket processing was interrupted. I'll retry shortly.",
                flags: 64,
              });
            } catch (error) {
              logError("job receipt", error);
            }
          }
        }
      }
    } finally {
      working = false;
    }
  }

  async function syncSheets() {
    await initialize();
    await sheets.sync();
  }

  async function registerCommands() {
    if (config.registerCommands === false) return;
    await initialize();
    const { COMMANDS } = await import("./protocol.ts");
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(COMMANDS)),
    );
    const version = Array.from(
      new Uint8Array(digest),
      (value) => value.toString(16).padStart(2, "0"),
    ).join("");
    const key = `commands:${config.applicationId ?? config.publicKey}`;
    await sql`insert into ticket_sync_state(sync_key) values (${key}) on conflict do nothing`;
    const [lease] =
      await sql`update ticket_sync_state set locked_until_utc = now() + interval '2 minutes'
      where sync_key = ${key} and value <> ${version} and (locked_until_utc is null or locked_until_utc < now()) returning value`;
    if (!lease) return;
    try {
      await discord.registerCommands();
      await sql`update ticket_sync_state set value = ${version}, synced_at_utc = now(), locked_until_utc = null where sync_key = ${key}`;
    } catch (error) {
      await sql`update ticket_sync_state set locked_until_utc = null where sync_key = ${key}`;
      throw error;
    }
  }

  return {
    fetch: fetchRequest,
    handleGatewayInteraction,
    initialize,
    processPending,
    syncSheets,
    registerCommands,
  };
}
