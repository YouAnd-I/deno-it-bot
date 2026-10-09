import type { Database } from "../src/storage.ts";

export type Query = { text: string; values: unknown[] };
export function fakeDatabase(
  reply: (query: Query) => unknown[] | Promise<unknown[]> = () => [],
) {
  const queries: Query[] = [];
  const sql = Object.assign(
    (strings: TemplateStringsArray | string, ...values: unknown[]) => {
      const query = {
        text: typeof strings === "string" ? strings : strings.join("?"),
        values,
      };
      queries.push(query);
      return Promise.resolve(reply(query));
    },
    {
      begin: (work: (tx: Database) => Promise<unknown>) =>
        work(sql as unknown as Database),
      unsafe: (text: string) => {
        queries.push({ text, values: [] });
        return Promise.resolve([]);
      },
      json: (value: unknown) => value,
    },
  );
  return { sql: sql as unknown as Database, queries };
}

export const delay = () => new Promise((resolve) => setTimeout(resolve, 25));
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const keys = await crypto.subtle.generateKey("Ed25519", true, [
  "sign",
  "verify",
]) as CryptoKeyPair;
const hex = (bytes: ArrayBuffer) =>
  Array.from(
    new Uint8Array(bytes),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
export const publicKey = hex(
  await crypto.subtle.exportKey("raw", keys.publicKey),
);
export async function signedRequest(body: unknown, rawOverride?: string) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await crypto.subtle.sign(
    "Ed25519",
    keys.privateKey,
    new TextEncoder().encode(timestamp + text),
  );
  return new Request("http://localhost/interactions", {
    method: "POST",
    body: rawOverride ?? text,
    headers: {
      "X-Signature-Ed25519": hex(signature),
      "X-Signature-Timestamp": timestamp,
    },
  });
}
