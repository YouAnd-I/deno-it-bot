import {
  COMMANDS,
  type Component,
  DEFAULT_PRIORITIES,
  type Interaction,
} from "./protocol.ts";
import type { Database, Staff } from "./storage.ts";

export type Fetch = typeof fetch;
export type Media = { name: string; bytes: Uint8Array };
export type MessageResult = { id: string; attachments?: { url: string }[] };
const DISCORD = "https://discord.com/api/v10";

export class DiscordClient {
  constructor(
    private token: string,
    private http: Fetch = fetch,
    private applicationId?: string,
  ) {}

  async request(
    path: string,
    method = "GET",
    payload?: Record<string, unknown>,
    media?: Media | null,
    authenticated = true,
  ): Promise<MessageResult & Record<string, unknown>> {
    const headers = new Headers();
    if (authenticated) headers.set("Authorization", `Bot ${this.token}`);
    let body: BodyInit | undefined;
    if (media) {
      const form = new FormData();
      form.append(
        "payload_json",
        JSON.stringify({
          ...payload,
          attachments: [{ id: 0, filename: media.name }],
        }),
      );
      form.append("files[0]", new Blob([media.bytes as BlobPart]), media.name);
      body = form;
    } else if (payload) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(payload);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await this.http(DISCORD + path, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(15000),
      });
      const raw = await response.text();
      if (response.status === 429 && attempt < 2) {
        const delay = Number(JSON.parse(raw).retry_after ?? 1);
        if (delay > 5) throw new Error("Discord is rate limited; retry later");
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0.1, delay) * 1000)
        );
        continue;
      }
      if (!response.ok) {
        throw new Error(`Discord HTTP ${response.status}: ${raw}`);
      }
      return raw ? JSON.parse(raw) : { id: "" };
    }
    throw new Error("Discord retry failed");
  }

  async registerCommands() {
    const application = this.applicationId ??
      (await this.request("/oauth2/applications/@me")).id;
    for (const command of COMMANDS) {
      await this.request(
        `/applications/${application}/commands`,
        "POST",
        command,
      );
    }
    console.log(`[discord] registered ${COMMANDS.length} commands`);
  }

  editOriginal(
    interaction: Interaction,
    payload: Record<string, unknown>,
    media?: Media | null,
  ) {
    return this.request(
      `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
      "PATCH",
      payload,
      media,
      false,
    );
  }

  followup(
    interaction: Interaction,
    payload: Record<string, unknown>,
    media?: Media | null,
  ) {
    return this.request(
      `/webhooks/${interaction.application_id}/${interaction.token}`,
      "POST",
      payload,
      media,
      false,
    );
  }

  sendMessage(
    channelId: string,
    content: Record<string, unknown>,
    nonce: string,
    media?: Media | null,
  ) {
    return this.request(`/channels/${channelId}/messages`, "POST", {
      ...content,
      nonce,
      enforce_nonce: true,
    }, media);
  }

  async dm(
    userId: string,
    content: Record<string, unknown>,
    nonce: string,
    media?: Media | null,
  ) {
    const channel = await this.request("/users/@me/channels", "POST", {
      recipient_id: userId,
    });
    return this.sendMessage(channel.id, content, nonce, media);
  }
}

export async function download(
  url: string | null | undefined,
  http: Fetch = fetch,
): Promise<Media | null> {
  if (!url) return null;
  try {
    const response = await http(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return {
      name: new URL(url).pathname.split("/").pop() || "attachment",
      bytes: new Uint8Array(await response.arrayBuffer()),
    };
  } catch (error) {
    console.error(
      "[attachment] download failed",
      error instanceof Error ? error.message : "unknown error",
    );
    return null;
  }
}

export async function classify(
  sql: Database,
  text: string,
  staff: Staff[],
  account: string | undefined,
  token: string | undefined,
  http: Fetch = fetch,
) {
  if (!account || !token) return null;
  const stored = await sql<
    { code: string; description: string }[]
  >`select priority_code as code, description from priority order by priority_code`;
  const priorities = stored.filter((option) => option.code?.trim());
  const questions: Record<string, unknown> = {
    priority: {
      type: "choice",
      instructions: "How should this support ticket be prioritized?",
      criteria: Object.fromEntries(
        (priorities.length >= 2 ? priorities : DEFAULT_PRIORITIES).map(
          (option) => [option.code, option.description || option.code],
        ),
      ),
    },
  };
  if (staff.length >= 2) {
    questions.assignee = {
      type: "choice",
      instructions: "Which on-duty IT staff member should this ticket go to?",
      criteria: Object.fromEntries(
        staff.map(
          (person) => [
            person.user_id,
            person.handles ? `${person.name} — ${person.handles}` : person.name,
          ],
        ),
      ),
    };
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await http(
        `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/clef`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "clef",
            state: `Today is ${
              new Date().toISOString()
            }. A user submitted a support ticket: ${text}`,
            questions,
          }),
          signal: AbortSignal.timeout(10000),
        },
      );
      const body = await response.json();
      if (
        !response.ok || body.success === false ||
        !body.result?.answers?.priority?.choice
      ) {
        throw new Error(
          `Invalid classifier response (HTTP ${response.status})`,
        );
      }
      const choice = body.result.answers.assignee?.choice;
      return {
        priority: body.result.answers.priority.choice === "no-rush"
          ? "no-rush"
          : "urgent",
        assignee: staff.some((person) => person.user_id === choice)
          ? String(choice)
          : null,
      };
    } catch (error) {
      console.error(
        "[classifier] failed",
        error instanceof Error ? error.message : "unknown error",
      );
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
  return null;
}

export function demoComponents(): Component[] {
  return [
    {
      type: 1,
      components: [{
        type: 2,
        custom_id: "btn-hello",
        label: "Say hi",
        style: 3,
      }, {
        type: 2,
        label: "NetCord docs",
        style: 5,
        url: "https://netcord.dev",
      }],
    },
    {
      type: 1,
      components: [{
        type: 3,
        custom_id: "menu-color",
        options: ["Red", "Green", "Blue"].map((label) => ({
          label,
          value: label.toLowerCase(),
        })),
      }],
    },
  ];
}
