create table if not exists discord_user (
  user_id bigint primary key,
  username text not null default '',
  first_seen_at_utc timestamptz not null,
  last_seen_at_utc timestamptz not null
);
create table if not exists priority (
  priority_code text primary key,
  description text not null default ''
);
create table if not exists ticket_status (
  status_code text primary key,
  description text not null default ''
);
create table if not exists ticket (
  ticket_id text primary key,
  requester_user_id bigint references discord_user(user_id),
  assignee_user_id bigint references discord_user(user_id),
  title text,
  description text,
  attachment_url text,
  priority_code text not null references priority(priority_code),
  classified_automatically boolean not null default false,
  classifier_offline boolean not null default false,
  created_at_utc timestamptz not null
);
create table if not exists ticket_status_event (
  status_event_id bigint generated always as identity primary key,
  ticket_id text not null references ticket(ticket_id),
  status_code text not null references ticket_status(status_code),
  actor_user_id bigint references discord_user(user_id),
  occurred_at_utc timestamptz not null
);
create index if not exists ticket_status_event_ticket_idx on ticket_status_event(ticket_id, occurred_at_utc);
create table if not exists ticket_note (
  note_id bigint generated always as identity primary key,
  ticket_id text not null references ticket(ticket_id),
  author_user_id bigint references discord_user(user_id),
  note_text text not null,
  created_at_utc timestamptz not null
);
create index if not exists ticket_note_ticket_idx on ticket_note(ticket_id, created_at_utc);
create table if not exists ticket_report (
  report_id bigint generated always as identity primary key,
  ticket_id text not null references ticket(ticket_id),
  filed_by_user_id bigint references discord_user(user_id),
  complaint text not null,
  action_taken text,
  file_url text,
  filed_at_utc timestamptz not null
);
create table if not exists solution (
  slug text primary key,
  title text not null,
  body text,
  image_url text
);
create table if not exists it_staff (
  user_id bigint primary key references discord_user(user_id),
  display_name text not null default '',
  handles text not null default '',
  active boolean not null default true
);
alter table it_staff add column if not exists handles text not null default '';
create table if not exists it_staff_absence (
  absence_id bigint generated always as identity primary key,
  user_id bigint not null references it_staff(user_id) on delete cascade,
  from_utc timestamptz not null,
  until_utc timestamptz not null,
  note text not null default ''
);
create table if not exists interaction_kind (kind_code text primary key);
create table if not exists interaction (
  interaction_id bigint primary key,
  kind_code text not null references interaction_kind(kind_code),
  name text not null,
  ticket_id text,
  user_id bigint references discord_user(user_id),
  channel_id bigint,
  guild_id bigint,
  received_at_utc timestamptz not null
);
create index if not exists interaction_received_idx on interaction(received_at_utc desc);
create table if not exists interaction_option (
  option_id bigint generated always as identity primary key,
  interaction_id bigint not null references interaction(interaction_id) on delete cascade,
  option_name text not null,
  option_value text
);
create index if not exists interaction_option_interaction_idx on interaction_option(interaction_id);
insert into priority(priority_code, description)
select code, guidance from (values
  ('urgent', 'Something is broken, failing, or blocking the user right now'),
  ('no-rush', 'A question or a request that can wait; nothing is failing')
) as defaults(code, guidance) where not exists(select 1 from priority)
on conflict do nothing;
insert into ticket_status(status_code) values
  ('open'), ('planned'), ('complete'), ('reopened'), ('unsolved'), ('cancel')
on conflict do nothing;
insert into interaction_kind(kind_code) values
  ('slash'), ('user-command'), ('message-command'), ('component'), ('modal'), ('other')
on conflict do nothing;
create table if not exists ticket_job (
  interaction_id bigint primary key,
  ticket_id text not null,
  payload jsonb not null,
  result jsonb not null default '{}',
  attempts integer not null default 0,
  available_at_utc timestamptz not null default now(),
  locked_until_utc timestamptz,
  applied_at_utc timestamptz,
  completed_at_utc timestamptz,
  expires_at_utc timestamptz not null default (now() + interval '14 minutes')
);
create index if not exists ticket_job_pending_idx on ticket_job(available_at_utc) where completed_at_utc is null;
create table if not exists ticket_sync_state (
  sync_key text primary key,
  value text not null default '',
  locked_until_utc timestamptz,
  synced_at_utc timestamptz
);
