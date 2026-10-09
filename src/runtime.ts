export function transportFor(
  env: (key: string) => string | undefined,
  http = false,
): "gateway" | "http" {
  const transport = http ? "http" : env("DISCORD_TRANSPORT")?.trim() ||
    (env("DENO_DEPLOY") === "true" || env("DENO_DEPLOYMENT_ID")
      ? "http"
      : "gateway");
  if (transport !== "http" && transport !== "gateway") {
    throw new Error("DISCORD_TRANSPORT must be gateway or http");
  }
  return transport;
}
