// Shared Discord REST helper.

export const USER_AGENT = "DiscordBot (https://github.com, 1) disco-release-notifier";
export const DISCORD_API = "https://discord.com/api/v10";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function discord(token: string, path: string, body?: unknown): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${DISCORD_API}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.ok) return res.json();
    if (res.status !== 429) throw new HttpError(`Discord HTTP ${res.status} ${path}: ${await res.text()}`, res.status);
    const { retry_after = 2 } = (await res.json().catch(() => ({}))) as { retry_after?: number };
    await Bun.sleep(retry_after * 1000);
  }
  throw new Error("Discord rate limit retries exhausted");
}
