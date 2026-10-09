export function publicPage(path: string): Response | null {
  const pages: Record<string, { title: string; body: string }> = {
    "/terms": {
      title: "IT ticket bot — Terms of Service",
      body:
        `<p>This bot lets users request IT support, track ticket status, add notes, and file confidential reports. Support is provided by the IT staff configured by the application operator; response times and resolutions are not guaranteed.</p><p>Use the service for legitimate support requests. Do not upload unlawful material, passwords, access tokens, or content you are not authorized to share. The application operator may restrict misuse or discontinue the service.</p><p>For questions, contact the administrator who provided this bot in your Discord server.</p>`,
    },
    "/privacy": {
      title: "IT ticket bot — Privacy Policy",
      body:
        `<p>The bot processes Discord user IDs and usernames, interaction metadata, ticket text, attachments, assignments, status changes, notes, and submitted reports to provide IT support. Data is stored in Neon Postgres and mirrored to a Google spreadsheet accessible to the application operator and people they authorize.</p><p>Ticket text, priority guidance, and the available IT roster are sent to Cloudflare Workers AI for automatic classification and assignment. Ticket cards and uploaded files are delivered through Discord. Confidential report text and evidence stay in the database and administrator spreadsheet; they are not included in ticket cards or classifier requests.</p><p>When you choose an anonymous report, the report, its submission audit, and resulting status event do not store your identity. A temporary delivery job holds the interaction token and user information while sending your receipt; its payload is cleared on completion and expired jobs are removed after the interaction expires. Other interactions, such as opening a report form, are audited with your Discord identity.</p><p>The application operator controls access and retention of tickets, audit records, and spreadsheet copies. Contact your server administrator for access, correction, or deletion requests. The bot does not read unrelated channel messages or sell your information.</p>`,
    },
  };
  const page = pages[path];
  if (!page) return null;
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${page.title}</title><style>body{font:18px/1.65 system-ui,sans-serif;max-width:760px;margin:60px auto;padding:0 24px;color:#17202a}h1{line-height:1.2}a{color:#2563eb}</style><main><h1>${page.title}</h1><p>Updated 9 October 2026</p>${page.body}<p><a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></p></main></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
