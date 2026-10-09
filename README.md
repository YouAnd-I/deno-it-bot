# Deno IT ticket bot

A standalone Deno Discordeno application for Discord. It uses the existing
normalized Neon Postgres ticket database, Cloudflare Workers AI clef, and Google
Sheets. `src/main.ts` connects to Discord's Gateway, starts the HTTP server, and
runs scheduled maintenance. The application does not depend on the C# projects.

## Features

- `/it` accepts optional title, description, priority, attachment, and assignee.
  With no arguments it opens a form with an upload and priority selector.
- Ticket cards include priority, classifier status, assignee, attachment, notes,
  creation time, and matching saved solutions. Requesters and assigned staff get
  private cards. A command in a bot DM posts a normal message in that
  conversation. If a requester cannot receive a DM, the card stays in their
  ephemeral reply.
- Cancel, Complete, Unsolved, Planned, Reopen, Add note, and Report are wired to
  persistent ticket changes. Reports include evidence, default to anonymous, and
  mark the ticket complete. Report text never appears on ticket cards.
- Auto classification reads the current priority guidance and on-duty roster.
  Staff absences apply for the entire UTC day when dates have no time. Explicit
  assignees take precedence. An unavailable classifier defaults to urgent. A
  configured fallback staff member who is absent is not selected automatically.
- `/ping`, `/greet`, `/tools square`, `/tools echo`, `/fruit` with autocomplete,
  `/components`, `/form`, User Info, and Echo Message match the reference bot.
- Slash commands, context commands, components, autocomplete, and modal
  submissions are audited. Replayed interactions do not add duplicate audit
  options. Anonymous report audits omit the user ID and report contents.
- Every public database table is mirrored to a spreadsheet, with a Dashboard for
  open and stale tickets, planned and complete counts, staff solutions, recent
  activity, and charts. Tabs have headers, banding, filters, column sizing,
  dates, text IDs, checkboxes, dropdowns, status colors, and warning-only ID
  protection.
- Changes to `it_staff`, `it_staff_absence`, and `priority` flow back from the
  sheet before the database is mirrored. Header order and extra columns are
  tolerated. Missing or malformed tabs are ignored. A tab containing only a
  valid header clears its rows; removed staff are deactivated, retaining their
  history.
- `it-tickets/*.s.json` solution files are mirrored on startup. Existing
  solutions already in Neon also work without local files.
  `TICKET_SOLUTIONS_DIR` changes the source directory.
- `/terms` and `/privacy` provide the Discord developer portal policy pages.

## Local setup

Run from this repository directory. Keep the existing `.env`, or create one from
`.env.example` if it does not exist. Then run:

```sh
deno task check
deno task test
deno task start
```

`deno task start` connects directly to Discord using Discordeno. Wait for
`[discord] Gateway shard 0 READY; receiving interactions`, then use `/ping` or
`/it` in Discord. No tunnel or public HTTP URL is needed. Leave the Discord
Developer Portal's Interactions Endpoint URL empty for this mode. Startup fails
with a clear error if that field would route commands somewhere else.

The HTTP server defaults to `http://localhost:8000`. `/ready` returns 200 only
after the database initializes and the Gateway connects, and 503 during startup
or a disconnect. `PORT` changes the listener port. The HTTP server also serves
the policy pages and the signed interaction endpoint.

`deno task start:http` explicitly uses HTTP interactions instead. Discord must
be configured to reach that server through a public HTTPS endpoint; localhost
alone cannot receive Discord webhooks. Both transports share all command,
component, modal, audit, and ticket handlers.

`deno task test:http` also runs a real local HTTP listener test. It needs an
environment that permits binding a local port. The default tests exercise signed
requests directly against the same HTTP handler, with fake external services.

The local `.env` is ignored by Git. Deno Deploy supplies the same variables
through its environment settings.

| Variable                 | Purpose                                                                 |
| ------------------------ | ----------------------------------------------------------------------- |
| `DISCORD_PUBLIC_KEY`     | Discord verification key, 64 hex characters; required for HTTP mode     |
| `DISCORD_TOKEN`          | Discord bot token                                                       |
| `DISCORD_TRANSPORT`      | Optional override: local defaults to `gateway`, Deno Deploy to `http`   |
| `DISCORD_APPLICATION_ID` | Optional application ID; otherwise resolved through Discord             |
| `DISCORD_IT_USER`        | Optional initial on-call staff member and empty-roster fallback         |
| `DATABASE_URL`           | Neon pooled PostgreSQL URL, including `sslmode=require`                 |
| `DATABASE_URL_UNPOOLED`  | Optional direct URL for `deno task migrate`                             |
| `CLOUDFLARE_ACCOUNT_ID`  | Workers AI account ID                                                   |
| `CLOUDFLARE_API_TOKEN`   | Workers AI API token                                                    |
| `GOOGLE_CLIENT_ID`       | Google Desktop OAuth client ID                                          |
| `GOOGLE_CLIENT_SECRET`   | Google OAuth client secret                                              |
| `GOOGLE_REFRESH_TOKEN`   | Refresh token with the spreadsheets scope                               |
| `GOOGLE_SPREADSHEET_ID`  | Existing spreadsheet ID; otherwise one is created and saved in Neon     |
| `TICKET_SOLUTIONS_DIR`   | Optional directory containing `.s.json` files; defaults to `it-tickets` |
| `REGISTER_COMMANDS`      | Set to `false` to disable automatic registration                        |
| `PORT`                   | Local listener port; defaults to 8000                                   |

The existing Neon tickets, users, notes, reports, staff, and solutions are
reused. `src/schema.sql` initializes an empty database and adds the internal job
and sync tables to an existing one. Initialization is serialized with a
transaction lock. It does not overwrite edited priority guidance or remove
existing tables. `deno task migrate` runs this schema setup separately; use a
development Neon branch when validating schema changes before production.

`deno task google-auth` opens a local OAuth callback listener and prints a
browser consent URL. After approval it prints the refresh token for the
environment file. Use a Desktop-type OAuth client with the Google Sheets API
enabled.

## Deno Deploy and Discord setup

Configure the Deno Deploy application with entrypoint `src/main.ts` and this
repository as its source. HTTP mode is selected automatically from Deno Deploy's
predefined environment variables. Set `DISCORD_TRANSPORT=http` for an explicit
override. Configure credentials in both Production and Development; preview
warm-up uses Development and cannot start without its own Discord token, public
key, and database URL. Preview databases can be separate when trying changes.

GitHub pushes redeploy automatically when this repository's `main` branch is
connected and the app is enabled. The ignored local `.env` is not sent to
GitHub. In Settings, import the environment file using **Add from .env file**,
assign the variables to the intended contexts, and save. The local `.env.deploy`
file, when present, contains the same working credentials with HTTP mode
selected. Mark database URLs, bot/API tokens, client secrets, and refresh tokens
as secrets.

Set these Discord developer portal URLs using the HTTPS domain from Deno Deploy:

| Portal field              | URL                                 |
| ------------------------- | ----------------------------------- |
| Interactions Endpoint URL | `https://<app-domain>/interactions` |
| Terms of Service URL      | `https://<app-domain>/terms`        |
| Privacy Policy URL        | `https://<app-domain>/privacy`      |

Linked Roles Verification URL is optional. This app does not implement a linked
role OAuth verification flow, so leave that field empty. The policy pages
describe the bot's actual data flow; the application operator is the contact for
user requests.

Commands register automatically after database initialization. Registration
upserts this app's commands and preserves unrelated commands. The command
version is saved in Neon to avoid registering them on every replica or cold
start. `deno task register` forces registration without starting the HTTP
server.

Discord validates the endpoint with a signed PING. PING and the policy pages
work while the database is initializing. Requests with invalid or old signatures
get 401. Configuring an HTTP interactions endpoint routes commands to this
application; the gateway-based C# bot will not receive those interactions.

## Deferred work and scheduled sync

Ticket operations are saved in `ticket_job` before returning Discord's deferred
acknowledgement. A worker starts immediately, and `ticket-job-retry` runs every
minute to resume interrupted jobs. The ticket mutation and its applied marker
commit in one transaction, so recovery does not create another ticket, note,
report, or status event. Workers claim jobs with a lease and `SKIP LOCKED`.
Discord DM deliveries use an interaction nonce to reduce duplicate messages
during retries. Original interaction replies are edited through Discord's
webhook endpoint.

Completed jobs clear their payload and tokens immediately. Expired jobs are
removed on maintenance. Jobs expire before Discord's 15-minute interaction token
deadline; persistent tickets remain even if final delivery cannot be completed.
Permanent DM restrictions can prevent notifying an assigned staff member.

`sheet-directory-sync` runs at startup and every ten minutes. A database lease
prevents overlapping replicas from repeatedly writing the same spreadsheet.
Internal job and sync tables are excluded from the export, so interaction tokens
and queued report payloads never appear in Sheets. The spreadsheet itself
contains confidential reports and should be shared only with authorized
administrators.

The protocol follows the official
[Discord component reference](https://docs.discord.com/developers/components/reference)
and
[interaction response contract](https://docs.discord.com/developers/interactions/receiving-and-responding).
The recovery queue accounts for
[Deno Deploy's runtime lifecycle](https://docs.deno.com/deploy/reference/runtime/).
