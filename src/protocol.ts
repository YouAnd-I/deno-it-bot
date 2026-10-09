export type Component = {
  type: number;
  custom_id?: string;
  value?: string | boolean;
  values?: string[];
  components?: Component[];
  component?: Component;
  [key: string]: unknown;
};

export type User = { id: string; username: string };
export type Attachment = { id?: string; url: string; filename?: string };
export type Option = {
  name: string;
  value?: string | number | boolean;
  options?: Option[];
  focused?: boolean;
};
export type Interaction = {
  id: string;
  type: number;
  application_id: string;
  token: string;
  guild_id?: string;
  channel_id?: string;
  channel?: { id: string };
  member?: { user: User };
  user?: User;
  message?: { id: string; content?: string; attachments?: Attachment[] };
  data?: {
    type?: number;
    name?: string;
    custom_id?: string;
    target_id?: string;
    options?: Option[];
    components?: Component[];
    values?: string[];
    resolved?: {
      attachments?: Record<string, Attachment>;
      users?: Record<string, User>;
      messages?: Record<string, { content: string }>;
    };
  };
};

export type TicketInput = {
  title: string | null;
  description: string | null;
  priority: string;
  attachmentUrl: string | null;
  assigneeId: string | null;
};

export type TicketView = {
  ticket_id: string;
  exists: boolean;
  title?: string | null;
  description?: string | null;
  attachment_url?: string | null;
  requester_name?: string | null;
  assignee_user_id?: string | null;
  priority_code?: string;
  classified_automatically?: boolean;
  classifier_offline?: boolean;
  created_at_utc?: Date | string;
  status?: string;
  notes?: number;
  solution?:
    | { title: string; body: string | null; image_url: string | null }
    | null;
};

export const DEFAULT_PRIORITIES = [
  {
    code: "urgent",
    description: "Something is broken, failing, or blocking the user right now",
  },
  {
    code: "no-rush",
    description: "A question or a request that can wait; nothing is failing",
  },
];
export const STATUSES = [
  "open",
  "planned",
  "complete",
  "reopened",
  "unsolved",
  "cancel",
];
export const FRUITS = [
  "apple",
  "apricot",
  "banana",
  "cherry",
  "dragonfruit",
  "elderberry",
  "fig",
  "grape",
  "kiwi",
  "lemon",
  "mango",
  "orange",
  "peach",
  "pear",
  "plum",
];

const parameter = (
  name: string,
  description: string,
  type = 3,
  required = false,
) => ({ name, description, type, required });
export const COMMANDS = [
  {
    name: "it",
    description: "Create an IT ticket",
    contexts: [0, 1, 2],
    options: [
      parameter("title", "Short summary"),
      parameter("description", "What happened?"),
      {
        ...parameter("priority", "How urgent is it?"),
        choices: ["auto", "urgent", "no-rush"].map((value) => ({
          name: value,
          value,
        })),
      },
      parameter("attachment", "Attach a screenshot or file", 11),
      parameter("assignee", "Who should handle this", 6),
    ],
  },
  { name: "ping", description: "Ping pong!" },
  {
    name: "greet",
    description: "Greet someone!",
    options: [
      parameter("user", "Who to greet", 6, true),
      parameter("message", "Greeting", 3, true),
    ],
  },
  {
    name: "tools",
    description: "Utility commands",
    options: [
      {
        name: "square",
        description: "Square a number",
        type: 1,
        options: [parameter("a", "Number", 10, true)],
      },
      {
        name: "echo",
        description: "Echo text back",
        type: 1,
        options: [parameter("text", "Text", 3, true)],
      },
    ],
  },
  {
    name: "fruit",
    description: "Pick a fruit",
    options: [{
      ...parameter("fruit", "Start typing to filter", 3, true),
      autocomplete: true,
    }],
  },
  { name: "components", description: "Buttons and menus demo" },
  { name: "form", description: "Open a modal form" },
  { name: "User Info", type: 2 },
  { name: "Echo Message", type: 3 },
];

export const row = (...components: Component[]): Component => ({
  type: 1,
  components,
});
export const label = (
  label: string,
  component: Component,
  description?: string,
): Component => ({
  type: 18,
  label,
  component,
  ...(description ? { description } : {}),
});
export const textInput = (
  id: string,
  style = 2,
  required = true,
): Component => ({ type: 4, custom_id: id, style, max_length: 2000, required });
const upload = (id: string): Component => ({
  type: 19,
  custom_id: id,
  required: false,
  min_values: 0,
  max_values: 1,
});
const select = (
  id: string,
  options: unknown[],
  required = true,
): Component => ({
  type: 3,
  custom_id: id,
  options,
  required,
  min_values: required ? 1 : 0,
  max_values: 1,
});

export function ticketModal() {
  return {
    type: 9,
    data: {
      custom_id: "modal-it-ticket",
      title: "New IT Ticket",
      components: [
        label("Title", textInput("title", 1)),
        label("Description", textInput("description", 2, false)),
        label(
          "Priority",
          select("priority", [
            {
              label: "Auto (let the model decide)",
              value: "auto",
              default: true,
            },
            { label: "Urgent", value: "urgent" },
            { label: "No rush", value: "no-rush" },
          ], false),
        ),
        label("Attachment", upload("file")),
      ],
    },
  };
}

export function noteModal(ticketId: string) {
  return {
    type: 9,
    data: {
      custom_id: `notemodal:${ticketId}`,
      title: `Note on ticket ${ticketId}`,
      components: [label("Follow-up note", textInput("note"))],
    },
  };
}

export function reportModal(ticketId: string) {
  return {
    type: 9,
    data: {
      custom_id: `reportmodal:${ticketId}`,
      title: "Confidential Report",
      components: [
        {
          type: 10,
          content:
            "**This report is confidential** — it won't be shown publicly.",
        },
        label("Your complaint", textInput("complaint")),
        label("What action should have been taken?", textInput("action")),
        label("Evidence", upload("reportfile")),
        label("Stay anonymous", {
          type: 23,
          custom_id: "anonymous",
          default: true,
        }, "We won't attach your name to this report"),
      ],
    },
  };
}

export function modalFields(interaction: Interaction) {
  const text: Record<string, string> = {};
  const values: Record<string, string[]> = {};
  const files: Record<string, string> = {};
  const checked: Record<string, boolean> = {};
  function visit(component: Component) {
    if (component.component) visit(component.component);
    component.components?.forEach(visit);
    if (!component.custom_id) return;
    const id = component.custom_id;
    if (component.type === 4 && typeof component.value === "string") {
      text[id] = component.value;
    }
    if (component.type === 3) values[id] = component.values ?? [];
    if (component.type === 23 && typeof component.value === "boolean") {
      checked[id] = component.value;
    }
    if (component.type === 19) {
      const attachment = interaction.data?.resolved?.attachments
        ?.[component.values?.[0] ?? ""];
      if (attachment) files[id] = attachment.url;
    }
  }
  interaction.data?.components?.forEach(visit);
  return { text, select: values, files, checked };
}

export const user = (interaction: Interaction): User =>
  interaction.member?.user ?? interaction.user ?? { id: "", username: "" };

export function ticketIdOf(name: string) {
  const parts = name.split(":");
  if (
    parts[0] === "itstatus" && parts.length === 3 && STATUSES.includes(parts[1])
  ) return parts[2];
  if (
    ["itreopen", "itnote", "itreport", "notemodal", "reportmodal"].includes(
      parts[0],
    ) && parts.length === 2
  ) return parts[1];
  return null;
}

export function interactionOptions(
  interaction: Interaction,
): [string, string | null][] {
  const result: [string, string | null][] = [];
  function visit(options: Option[], prefix = "") {
    for (const option of options) {
      const name = prefix + option.name;
      if (option.options) visit(option.options, name + ".");
      else {result.push([
          name,
          option.value == null ? null : String(option.value),
        ]);}
    }
  }
  visit(interaction.data?.options ?? []);
  const fields = modalFields(interaction);
  for (const [name, value] of Object.entries(fields.text)) {
    result.push([name, value]);
  }
  for (const [name, values] of Object.entries(fields.select)) {
    for (const value of values) {
      result.push([name, value]);
    }
  }
  for (const [name, value] of Object.entries(fields.files)) {
    result.push([name, value]);
  }
  for (const [name, value] of Object.entries(fields.checked)) {
    result.push([name, String(value)]);
  }
  for (const value of interaction.data?.values ?? []) {
    result.push(["value", value]);
  }
  return result;
}

const button = (
  label: string,
  custom_id: string,
  style: number,
): Component => ({ type: 2, label, custom_id, style });
export function buttons(ticketId: string, status = "open") {
  if (!["open", "reopened"].includes(status)) {
    return [row(
      button("Reopen", `itreopen:${ticketId}`, 1),
      button("Add note", `itnote:${ticketId}`, 2),
      button("Report", `itreport:${ticketId}`, 2),
    )];
  }
  return [row(
    button("Cancel", `itstatus:cancel:${ticketId}`, 2),
    button("Complete", `itstatus:complete:${ticketId}`, 3),
    button("Unsolved", `itstatus:unsolved:${ticketId}`, 4),
    button("Planned", `itstatus:planned:${ticketId}`, 1),
    button("Report", `itreport:${ticketId}`, 2),
  )];
}

export function card(view: TicketView, heading: string) {
  let head = `**IT ticket \`${view.ticket_id}\`** — ${heading}`;
  if (!view.exists) return head;
  if (view.created_at_utc) {
    const created = new Date(view.created_at_utc).getTime();
    if (["open", "reopened"].includes(view.status ?? "open")) {
      head += ` — <t:${Math.floor(created / 1000)}:R>`;
    } else {
      const seconds = Math.max(0, Math.floor((Date.now() - created) / 1000));
      const age = seconds >= 3600
        ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`
        : seconds >= 60
        ? `${Math.floor(seconds / 60)}m`
        : `${seconds}s`;
      head += ` (open for ${age})`;
    }
  }
  const lines = [
    head,
    `Title: **${view.title || "(no title)"}**`,
    `Priority: \`${view.priority_code}\`${
      view.classified_automatically
        ? " *(auto-classified)*"
        : view.classifier_offline
        ? " *(classifier offline — defaulted)*"
        : ""
    }`,
    `> ${view.description || "(no description)"}`,
  ];
  if (view.assignee_user_id) {
    lines.push(`👤 Handled by <@${view.assignee_user_id}>`);
  }
  if (view.attachment_url) lines.push(`📎 ${view.attachment_url}`);
  if (view.notes) lines.push(`📝 ${view.notes} note(s)`);
  if (view.solution) {
    lines.push(
      `\n**💡 IT solution — ${view.solution.title}:**\n${
        view.solution.body ?? ""
      }${view.solution.image_url ? "\n" + view.solution.image_url : ""}`,
    );
  }
  return lines.join("\n");
}

export function message(content: string, ephemeral = true) {
  return {
    type: 4,
    data: {
      ...messagePayload(content),
      flags: ephemeral ? 64 : 0,
    },
  };
}

export function messagePayload(content: string, components?: Component[]) {
  if (content.length <= 2000) {
    return { content, components, allowed_mentions: { parse: [] } };
  }
  return {
    content: content.split("\n")[0].slice(0, 2000),
    embeds: [content.slice(0, 4096), content.slice(4096, 6000)]
      .filter(Boolean).map((description) => ({ description })),
    components,
    allowed_mentions: { parse: [] },
  };
}
