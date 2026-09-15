// Poll every readable channel on the Discord server and bridge new messages to one Slack channel.

import { discord, HttpError } from "./discord.ts";

const STATE_FILE = new URL("./bridge-state.json", import.meta.url).pathname;
const SLACK_API = "https://slack.com/api";
const DISCORD_EPOCH = 1420070400000n;
// 0 = GUILD_TEXT, 2 = GUILD_VOICE (text chat in voice), 5 = GUILD_ANNOUNCEMENT.
const TEXT_TYPES = new Set([0, 2, 5]);
// Channels whose threads (or forum posts) can be archived.
const THREAD_PARENT_TYPES = new Set([0, 5, 15, 16]);
// 10-12 = announcement/public/private thread.
const THREAD_TYPES = new Set([10, 11, 12]);
// 0 = DEFAULT, 19 = REPLY; everything else is a system message (joins, pins, boosts, ...).
const MESSAGE_TYPES = new Set([0, 19]);

type Channel = {
  id: string;
  type: number;
  name: string;
  parent_id?: string | null;
  last_message_id?: string | null;
  thread_metadata?: { archive_timestamp: string };
};
type User = { id: string; username: string; global_name?: string | null; avatar?: string | null };
type Message = {
  id: string;
  channel_id: string;
  type: number;
  author: User;
  content: string;
  mentions: User[];
  attachments: { url: string; filename: string }[];
  embeds: { title?: string; url?: string }[];
  sticker_items?: { name: string }[];
};
// since: snowflake of the last run's start; channels without a cursor are read from there.
type State = { since?: string; channels: Record<string, string> };

const byId = (a: { id: string }, b: { id: string }) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1);

async function fetchAfter(token: string, channel: string, after: string): Promise<Message[]> {
  const out: Message[] = [];
  for (;;) {
    const page: Message[] = await discord(token, `/channels/${channel}/messages?after=${after}&limit=100`);
    out.push(...page);
    if (page.length < 100) return out;
    after = page.toSorted(byId).at(-1)!.id;
  }
}

async function slack(token: string, method: string, body: unknown): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      await Bun.sleep(Number(res.headers.get("retry-after") ?? 1) * 1000);
      continue;
    }
    const json = (await res.json()) as { ok: boolean; error?: string };
    if (!json.ok) throw new Error(`Slack ${method}: ${json.error ?? `HTTP ${res.status}`}`);
    return json;
  }
  throw new Error("Slack rate limit retries exhausted");
}

const escapeSlack = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function avatarUrl(u: User): string {
  if (u.avatar) return `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png`;
  return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(u.id) >> 22n) % 6n)}.png`;
}

function toMrkdwn(m: Message, channelNames: Map<string, string>): string {
  const users = new Map(m.mentions.map((u) => [u.id, u.global_name || u.username]));
  return escapeSlack(m.content)
    .replace(/&lt;@!?(\d+)&gt;/g, (s, id) => (users.has(id) ? `@${escapeSlack(users.get(id)!)}` : s))
    .replace(/&lt;@&amp;\d+&gt;/g, "@role")
    .replace(/&lt;#(\d+)&gt;/g, (s, id) => (channelNames.has(id) ? `#${escapeSlack(channelNames.get(id)!)}` : s))
    .replace(/&lt;a?:(\w+):\d+&gt;/g, ":$1:")
    .replace(/(?<![*\w])\*(?!\*)([^*\n]+?)\*(?![*\w])/g, "_$1_")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/~~(.+?)~~/g, "~$1~");
}

const discordToken = process.env.DISCORD_BOT_TOKEN;
const slackToken = process.env.SLACK_BOT_TOKEN;
const slackChannel = process.env.SLACK_CHANNEL_ID;
if (!discordToken) throw new Error("DISCORD_BOT_TOKEN is not set");
if (!slackToken) throw new Error("SLACK_BOT_TOKEN is not set");
if (!slackChannel) throw new Error("SLACK_CHANNEL_ID is not set");

const stateFile = Bun.file(STATE_FILE);
const state: State = (await stateFile.exists()) ? await stateFile.json() : { channels: {} };
const runStart = String((BigInt(Date.now()) - DISCORD_EPOCH) << 22n);
let failed = false;

const guilds: { id: string }[] = await discord(discordToken, "/users/@me/guilds");
if (guilds.length !== 1) throw new Error(`bot must be in exactly one server, found ${guilds.length}`);
const guild = guilds[0]!.id;

const guildChannels: Channel[] = await discord(discordToken, `/guilds/${guild}/channels`);
const { threads }: { threads: Channel[] } = await discord(discordToken, `/guilds/${guild}/threads/active`);
const sources = new Map<string, Channel>();
for (const ch of [...guildChannels.filter((c) => TEXT_TYPES.has(c.type)), ...threads]) sources.set(ch.id, ch);

// Threads archived since the last run may still hold unbridged messages.
if (state.since) {
  const sinceMs = Number((BigInt(state.since) >> 22n) + DISCORD_EPOCH);
  for (const parent of guildChannels.filter((c) => THREAD_PARENT_TYPES.has(c.type))) {
    try {
      const archived: { threads: Channel[] } = await discord(discordToken, `/channels/${parent.id}/threads/archived/public`);
      for (const t of archived.threads) {
        if (Date.parse(t.thread_metadata!.archive_timestamp) >= sinceMs) sources.set(t.id, t);
      }
    } catch (err) {
      if (!(err instanceof HttpError && (err.status === 403 || err.status === 404))) throw err;
    }
  }
}

const channelNames = new Map([...guildChannels, ...sources.values()].map((c) => [c.id, c.name]));
function label(ch: Channel): string {
  const parent = THREAD_TYPES.has(ch.type) && ch.parent_id ? channelNames.get(ch.parent_id) : undefined;
  return parent ? `#${parent} › ${ch.name}` : `#${ch.name}`;
}

// Cursors are rebuilt from the channels visible this run; a channel that reappears later
// (access granted, thread unarchived) resumes from `since`, which precedes any message it missed.
const cursors: Record<string, string> = {};
const pending: Message[] = [];
for (const ch of sources.values()) {
  const after = state.channels[ch.id] ?? state.since;
  if (after === undefined) {
    // First run: seed without posting.
    if (ch.last_message_id) cursors[ch.id] = ch.last_message_id;
    continue;
  }
  try {
    pending.push(...(await fetchAfter(discordToken, ch.id, after)));
    cursors[ch.id] = after;
  } catch (err) {
    if (err instanceof HttpError && (err.status === 403 || err.status === 404)) {
      console.log(`${label(ch)}: skipped (HTTP ${err.status})`);
      continue;
    }
    failed = true;
    console.error(`${label(ch)}: error: ${err instanceof Error ? err.message : err}`);
    if (state.channels[ch.id]) cursors[ch.id] = state.channels[ch.id]!;
  }
}

// Post in server-wide order; stop at the first failure so nothing is skipped or reordered.
let posted = 0;
for (const m of pending.sort(byId)) {
  const ch = sources.get(m.channel_id)!;
  const body = [
    toMrkdwn(m, channelNames),
    ...m.attachments.map((a) => `<${a.url}|${escapeSlack(a.filename)}>`),
    ...m.embeds.filter((e) => e.title || e.url).map((e) => (e.url ? `<${e.url}|${escapeSlack(e.title || e.url)}>` : escapeSlack(e.title!))),
    ...(m.sticker_items ?? []).map((s) => `[sticker: ${escapeSlack(s.name)}]`),
  ]
    .filter(Boolean)
    .join("\n");
  if (MESSAGE_TYPES.has(m.type) && body) {
    const link = `https://discord.com/channels/${guild}/${m.channel_id}/${m.id}`;
    try {
      await slack(slackToken, "chat.postMessage", {
        channel: slackChannel,
        text: `<${link}|${escapeSlack(label(ch))}>\n${body}`.slice(0, 39000),
        username: (m.author.global_name || m.author.username).slice(0, 80),
        icon_url: avatarUrl(m.author),
        unfurl_links: false,
      });
    } catch (err) {
      failed = true;
      console.error(`${label(ch)}: error posting ${m.id}: ${err instanceof Error ? err.message : err}`);
      break;
    }
    posted++;
  }
  cursors[m.channel_id] = m.id;
}
console.log(`bridged ${posted} of ${pending.length} new messages from ${sources.size} channels`);

// Only advance `since` when every visible channel has a cursor that covers it.
const since = failed ? state.since : runStart;
await Bun.write(STATE_FILE, JSON.stringify({ since, channels: cursors }, null, 2) + "\n");
process.exit(failed ? 1 : 0);
