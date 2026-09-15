// Poll GitHub release Atom feeds and post new releases to Discord channels via a bot.

import { XMLParser } from "fast-xml-parser";
import { discord, USER_AGENT } from "./discord.ts";

const REPOS_FILE = new URL("./repos.txt", import.meta.url).pathname;
const STATE_FILE = new URL("./state.json", import.meta.url).pathname;
const MAX_SEEN = 100;
const PRERELEASE_RE = /-(alpha|beta|rc|pre|dev|canary|nightly)/i;

type Entry = { id: string; title: string; updated: string; url: string; content: string };
type State = Record<string, string[]>;

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

type Target = { repo: string; channel: string; tag?: string };

async function readRepos(): Promise<Target[]> {
  const text = await Bun.file(REPOS_FILE).text();
  return text
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean)
    .map((line) => {
      const [repo, channel, ...tag] = line.split(/\s+/);
      if (!repo || !channel || !/^\d+$/.test(channel)) throw new Error(`bad line in repos.txt: "${line}"`);
      return { repo, channel, tag: tag.join(" ") || undefined };
    });
}

async function fetchEntries(repo: string): Promise<Entry[]> {
  const res = await fetch(`https://github.com/${repo}/releases.atom`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
  const feed = parser.parse(await res.text()).feed;
  const entries = [feed?.entry ?? []].flat();
  return entries.map((e: any) => ({
    id: String(e.id),
    title: String(e.title ?? ""),
    updated: String(e.updated ?? ""),
    url: e.link?.href ?? `https://github.com/${repo}/releases`,
    content: String(e.content?.["#text"] ?? e.content ?? ""),
  })); // newest first
}

function htmlToText(s: string): string {
  return s
    .replace(/\s*<h\d[^>]*>\s*/gi, "\n\n**")
    .replace(/\s*<\/h\d>/gi, "**\n")
    .replace(/\s*<li[^>]*>\s*/gi, "\n- ")
    .replace(/<br\s*\/?>|<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// 15 = GUILD_FORUM, 16 = GUILD_MEDIA: these only accept new posts (threads), not messages.
const FORUM_TYPES = new Set([15, 16]);
type Channel = { type: number; available_tags?: { id: string; name: string }[] };
const channels = new Map<string, Promise<Channel>>();

function getChannel(token: string, id: string): Promise<Channel> {
  if (!channels.has(id)) channels.set(id, discord(token, `/channels/${id}`));
  return channels.get(id)!;
}

async function postDiscord(token: string, target: Target, entry: Entry, tag: string) {
  const { repo, channel } = target;
  const title = entry.title || tag;
  const message = {
    embeds: [
      {
        author: { name: repo, url: `https://github.com/${repo}`, icon_url: `https://github.com/${repo.split("/")[0]}.png` },
        title: title.slice(0, 256),
        url: entry.url,
        description: htmlToText(entry.content).slice(0, 4000),
        timestamp: entry.updated || undefined,
        color: 0x5865f2,
      },
    ],
  };

  const info = await getChannel(token, channel);
  if (!FORUM_TYPES.has(info.type)) {
    // Text channel, announcement channel, or an existing thread/forum post.
    await discord(token, `/channels/${channel}/messages`, message);
    return;
  }

  let applied_tags: string[] | undefined;
  if (target.tag) {
    const found = info.available_tags?.find((t) => t.name.toLowerCase() === target.tag!.toLowerCase());
    if (!found) throw new Error(`forum ${channel} has no tag "${target.tag}"`);
    applied_tags = [found.id];
  }
  const name = title.toLowerCase().includes(repo.split("/")[1]!.toLowerCase()) ? title : `${repo} ${title}`;
  await discord(token, `/channels/${channel}/threads`, { name: name.slice(0, 100), message, applied_tags });
}

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) throw new Error("DISCORD_BOT_TOKEN is not set");
const skipPre = process.env.SKIP_PRERELEASE === "true";
const stateFile = Bun.file(STATE_FILE);
const state: State = (await stateFile.exists()) ? await stateFile.json() : {};
let failed = false;

for (const target of await readRepos()) {
  const { repo, channel } = target;
  try {
    const entries = await fetchEntries(repo);
    const seen = state[repo];
    if (!seen) {
      // First time seeing this repo: seed without posting.
      state[repo] = entries.map((e) => e.id);
      console.log(`${repo}: seeded ${entries.length} entries`);
      continue;
    }
    for (const entry of entries.toReversed()) {
      if (seen.includes(entry.id)) continue;
      const tag = entry.id.split("/").pop()!;
      if (!(skipPre && PRERELEASE_RE.test(tag))) {
        await postDiscord(token, target, entry, tag);
        console.log(`${repo}: posted ${tag} to channel ${channel}`);
      }
      seen.push(entry.id);
    }
    state[repo] = seen.slice(-MAX_SEEN);
  } catch (err) {
    failed = true;
    console.error(`${repo}: error: ${err instanceof Error ? err.message : err}`);
  }
}

await Bun.write(STATE_FILE, JSON.stringify(state, Object.keys(state).sort(), 2) + "\n");
process.exit(failed ? 1 : 0);
