const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
if (!clientId || !clientSecret) {
  throw new Error(
    "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET for a Desktop OAuth client",
  );
}
const state = crypto.randomUUID();
const controller = new AbortController();
const result = Promise.withResolvers<string>();
const server = Deno.serve({
  hostname: "127.0.0.1",
  port: 0,
  signal: controller.signal,
  onListen: () => {},
}, (request) => {
  const url = new URL(request.url);
  if (url.searchParams.get("state") !== state) {
    return new Response("Invalid OAuth state", { status: 400 });
  }
  const code = url.searchParams.get("code");
  if (!code) {
    result.reject(
      new Error(url.searchParams.get("error") ?? "No authorization code"),
    );
    return new Response("Authorization was not granted.", { status: 400 });
  }
  result.resolve(code);
  return new Response(
    "Authorization received. Return to your terminal and close this tab.",
  );
});
const redirect = `http://127.0.0.1:${server.addr.port}/`;
const consent = new URL("https://accounts.google.com/o/oauth2/v2/auth");
consent.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirect,
  response_type: "code",
  scope: "https://www.googleapis.com/auth/spreadsheets",
  access_type: "offline",
  prompt: "consent",
  state,
}).toString();
console.log("Open this URL in your browser:");
console.log(consent.toString());
const timeout = setTimeout(
  () => result.reject(new Error("Google consent timed out")),
  600000,
);
try {
  const code = await result.promise;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirect,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(15000),
  });
  const json = await response.json();
  if (!response.ok || !json.refresh_token) {
    throw new Error(`Token exchange failed (HTTP ${response.status})`);
  }
  console.log(`GOOGLE_REFRESH_TOKEN=${json.refresh_token}`);
} finally {
  clearTimeout(timeout);
  controller.abort();
  await server.finished;
}
