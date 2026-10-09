import type postgres from "postgres";
import {
  type Interaction,
  interactionOptions,
  modalFields,
  ticketIdOf,
  type TicketInput,
  type TicketView,
  type User,
  user,
} from "./protocol.ts";

export type Database = postgres.Sql;
export type Transaction = postgres.TransactionSql;
type Executor = Database | Transaction;
export type Staff = { user_id: string; name: string; handles: string };
export type JobPayload = {
  interaction: Interaction;
  operation: "create" | "status" | "note" | "report";
  input?: TicketInput;
  status?: string;
  note?: string;
  complaint?: string;
  action?: string;
  fileUrl?: string | null;
  anonymous?: boolean;
};
export type Job = {
  interaction_id: string;
  ticket_id: string;
  payload: JobPayload;
  result: {
    requesterDelivered?: boolean;
    staffDelivered?: boolean;
    delivery?: string;
  };
  applied_at_utc: Date | null;
  attempts: number;
};

export async function initializeDatabase(sql: Database, fallbackUser?: string) {
  const schema = await Deno.readTextFile(
    new URL("./schema.sql", import.meta.url),
  );
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(92610741)`;
    await tx.unsafe(schema);
    if (fallbackUser && /^\d+$/.test(fallbackUser)) {
      const [existing] = await tx`select user_id from it_staff limit 1`;
      if (!existing) {
        await ensureUser(tx, { id: fallbackUser, username: "on-call" });
        await tx`insert into it_staff(user_id, display_name, handles, active)
          values (${fallbackUser}::bigint, 'on-call', 'everything IT — first responder', true)
          on conflict do nothing`;
      }
    }
  });
}

export async function ensureUser(sql: Executor, actor: User) {
  if (!actor.id) return;
  await sql`insert into discord_user(user_id, username, first_seen_at_utc, last_seen_at_utc)
    values (${actor.id}::bigint, ${actor.username}, now(), now())
    on conflict(user_id) do update set
      username = case when excluded.username = '' then discord_user.username else excluded.username end,
      last_seen_at_utc = now()`;
}

export async function availableStaff(sql: Database): Promise<Staff[]> {
  return await sql<
    Staff[]
  >`select user_id::text, display_name as name, handles from it_staff
    where active and not exists(select 1 from it_staff_absence a
      where a.user_id = it_staff.user_id and now() between a.from_utc and a.until_utc)
    order by user_id`;
}

export async function loadView(
  sql: Database,
  ticketId: string,
): Promise<TicketView> {
  const [view] = await sql<
    TicketView[]
  >`select t.ticket_id, true as "exists", t.title, t.description,
    t.attachment_url, t.assignee_user_id::text, t.priority_code, t.classified_automatically,
    t.classifier_offline, t.created_at_utc, u.username as requester_name,
    coalesce((select s.status_code from ticket_status_event s where s.ticket_id = t.ticket_id
      order by s.occurred_at_utc desc, s.status_event_id desc limit 1), 'open') as status,
    (select count(*)::int from ticket_note n where n.ticket_id = t.ticket_id) as notes
    from ticket t left join discord_user u on u.user_id = t.requester_user_id where t.ticket_id = ${ticketId}`;
  if (!view) return { ticket_id: ticketId, exists: false };
  const words = `${view.title ?? ""} ${view.description ?? ""}`.split(/\s+/)
    .filter((word) => word.length > 1);
  if (words.length) {
    const solutions = await sql<
      { title: string; body: string | null; image_url: string | null }[]
    >`select title, body, image_url from solution`;
    view.solution = solutions.map((solution) => ({
      solution,
      score: words.filter((word) =>
        (solution.title + " " + (solution.body ?? "")).toLowerCase().includes(
          word.toLowerCase(),
        )
      ).length,
    }))
      .filter((match) =>
        match.score > 0
      ).sort((a, b) => b.score - a.score)[0]
      ?.solution ?? null;
  }
  return view;
}

export async function recordInteraction(
  sql: Database,
  interaction: Interaction,
) {
  if (interaction.type === 1 || !interaction.id) return;
  const name = interaction.data?.name ?? interaction.data?.custom_id ??
    "unknown";
  const fields = modalFields(interaction);
  const anonymous = name.startsWith("reportmodal:") &&
    (fields.checked.anonymous ?? fields.select.anonymous?.[0] !== "no");
  const actor = anonymous ? { id: "", username: "" } : user(interaction);
  const kind = interaction.type === 2
    ? interaction.data?.type === 2
      ? "user-command"
      : interaction.data?.type === 3
      ? "message-command"
      : "slash"
    : interaction.type === 5
    ? "modal"
    : interaction.type === 3
    ? "component"
    : "other";
  const options = name.startsWith("reportmodal:")
    ? [["anonymous", String(anonymous)]] as [string, string][]
    : interactionOptions(interaction);
  await sql.begin(async (tx) => {
    await ensureUser(tx, actor);
    const inserted =
      await tx`insert into interaction(interaction_id, kind_code, name, ticket_id, user_id, channel_id, guild_id, received_at_utc)
      values (${interaction.id}::bigint, ${kind}, ${name}, ${
        ticketIdOf(name)
      }, ${actor.id || null}::bigint,
        ${interaction.channel_id ?? interaction.channel?.id ?? null}::bigint, ${
        interaction.guild_id ?? null
      }::bigint, now())
      on conflict(interaction_id) do nothing returning interaction_id`;
    if (!inserted.length) return;
    for (const [option, value] of options) {
      await tx`insert into interaction_option(interaction_id, option_name, option_value)
      values (${interaction.id}::bigint, ${option}, ${value})`;
    }
  });
}

export async function enqueueJob(
  sql: Database,
  payload: JobPayload,
  ticketId: string,
) {
  const expires = new Date(
    Number((BigInt(payload.interaction.id) >> 22n) + 1420070400000n) +
      14 * 60000,
  );
  await sql`insert into ticket_job(interaction_id, ticket_id, payload, expires_at_utc)
    values (${payload.interaction.id}::bigint, ${ticketId}, ${
    sql.json(payload as unknown as postgres.JSONValue)
  }, ${expires})
    on conflict(interaction_id) do nothing`;
}

export async function claimJob(sql: Database): Promise<Job | null> {
  const [job] = await sql<
    Job[]
  >`update ticket_job j set locked_until_utc = now() + interval '2 minutes', attempts = attempts + 1
    where interaction_id = (select interaction_id from ticket_job
      where completed_at_utc is null and expires_at_utc > now() and available_at_utc <= now()
        and (locked_until_utc is null or locked_until_utc < now())
      order by available_at_utc, interaction_id for update skip locked limit 1)
    returning interaction_id::text, ticket_id, payload, result, applied_at_utc, attempts`;
  return job ?? null;
}

export async function applyJob(
  sql: Database,
  job: Job,
  classification?: {
    priority: string;
    assignee: string | null;
    offline: boolean;
    auto: boolean;
  },
) {
  await sql.begin(async (tx) => {
    const [state] =
      await tx`select applied_at_utc from ticket_job where interaction_id = ${job.interaction_id}::bigint for update`;
    if (state?.applied_at_utc) return;
    const payload = job.payload;
    const actor = user(payload.interaction);
    const anonymous = payload.operation === "report" && payload.anonymous;
    if (!anonymous) await ensureUser(tx, actor);
    if (payload.operation === "create") {
      const input = payload.input!;
      const result = classification!;
      if (result.assignee) {
        await ensureUser(tx, { id: result.assignee, username: "" });
      }
      await tx`insert into priority(priority_code) values (${result.priority}) on conflict do nothing`;
      await tx`insert into ticket(ticket_id, requester_user_id, assignee_user_id, title, description,
        attachment_url, priority_code, classified_automatically, classifier_offline, created_at_utc)
        values (${job.ticket_id}, ${actor.id}::bigint, ${result.assignee}::bigint, ${input.title}, ${input.description},
          ${input.attachmentUrl}, ${result.priority}, ${result.auto}, ${result.offline}, now())`;
    } else {
      const [ticket] =
        await tx`select ticket_id from ticket where ticket_id = ${job.ticket_id}`;
      if (!ticket) throw new Error("Ticket not found");
      if (payload.operation === "note") {
        await tx`insert into ticket_note(ticket_id, author_user_id, note_text, created_at_utc)
        values (${job.ticket_id}, ${actor.id}::bigint, ${
          payload.note ?? ""
        }, now())`;
      }
      if (payload.operation === "report") {
        await tx`insert into ticket_report(ticket_id, filed_by_user_id, complaint, action_taken, file_url, filed_at_utc)
        values (${job.ticket_id}, ${anonymous ? null : actor.id}::bigint, ${
          payload.complaint ?? ""
        }, ${payload.action ?? ""}, ${payload.fileUrl ?? null}, now())`;
      }
    }
    const status = payload.operation === "create"
      ? "open"
      : payload.operation === "report"
      ? "complete"
      : payload.operation === "status"
      ? payload.status
      : null;
    if (status) {
      await tx`insert into ticket_status_event(ticket_id, status_code, actor_user_id, occurred_at_utc)
      values (${job.ticket_id}, ${status}, ${
        anonymous ? null : actor.id
      }::bigint, now())`;
    }
    await tx`update ticket_job set applied_at_utc = now() where interaction_id = ${job.interaction_id}::bigint`;
  });
}

export async function markDelivery(
  sql: Database,
  job: Job,
  flag: "requesterDelivered" | "staffDelivered",
) {
  job.result[flag] = true;
  await sql`update ticket_job set result = ${
    sql.json(job.result)
  } where interaction_id = ${job.interaction_id}::bigint`;
}

export async function finishJob(sql: Database, job: Job) {
  await sql`update ticket_job set completed_at_utc = now(), payload = '{}', result = '{}', locked_until_utc = null
    where interaction_id = ${job.interaction_id}::bigint`;
}

export async function retryJob(sql: Database, job: Job) {
  await sql`update ticket_job set available_at_utc = now() + interval '30 seconds', locked_until_utc = null
    where interaction_id = ${job.interaction_id}::bigint`;
}

export async function cleanJobs(sql: Database) {
  await sql`delete from ticket_job where expires_at_utc < now()`;
}
