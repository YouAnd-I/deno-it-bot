# deno-it-bot

The `/it` IT-ticket flow as an HTTP-interactions Discord bot for **Deno Deploy** —
no gateway, no ECS: interactions arrive over HTTP, tickets live in the same
normalized Neon Postgres schema as the C# bot, priorities are classified by
Cloudflare Workers AI's clef model, and the IT directory (priorities, staff,
absences) stays editable in the Google Sheet.

## Endpoints

- `POST /interactions` — Discord interactions (signature-verified)
- `GET /` — health check ("YouAnd-I IT ticket bot (HTTP) is running")

## Commands

- `/it [title] [description] [priority:auto|urgent|no-rush] [attachment] [assignee]`
  — no arguments opens the modal form. Auto priority goes through clef, which
  also picks the assignee when the directory has ≥2 on-duty staff.
- Card buttons: Complete / Planned / Unsolved / Cancel, Reopen, Add note, Report
  (confidential, anonymous by default).

## Environment variables (Deno Deploy → Settings → Environment Variables)

| Variable | Value |
|---|---|
| `DISCORD_PUBLIC_KEY` | application verify key (dev portal → General Information) |
| `DISCORD_TOKEN` | bot token |
| `DISCORD_IT_USER` | optional fallback assignee when the directory is empty (Discord user id) |
| `DATABASE_URL` | Neon pooled connection string (`postgresql://…-pooler…/neondb?sslmode=require`) |
| `CLOUDFLARE_ACCOUNT_ID` | Workers AI account id |
| `CLOUDFLARE_API_TOKEN` | Workers AI token |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` | OAuth for the sheet API |
| `GOOGLE_SPREADSHEET_ID` | the directory spreadsheet id |

## Setup

1. Push this repo and connect it as the Deno Deploy project (entrypoint `src/main.ts`).
2. Add the environment variables for **Production** (and Preview).
3. In the Discord dev portal → General Information → **Interactions Endpoint URL**:
   `https://<your-project>.deno.dev/interactions`. Discord verifies it with a PING.
4. Commands (`/it`, `/ping`) are (re)registered automatically on cold start.

Note: with an Interactions Endpoint URL set, Discord delivers interactions over
HTTP — the gateway-based C# bot will not receive them while the URL is
configured. Clear the URL to hand control back to the C# bot.

## Sheet sync

`Deno.cron` mirrors the sheet's `priority`, `it_staff` and `it_staff_absence`
tabs into Neon every 10 minutes (and once at cold start). Priorities removed
from the sheet are dropped unless existing tickets reference them; staff are
deactivated through the Active column, never deleted.
