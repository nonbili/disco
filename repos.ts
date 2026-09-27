// Shared reader for repos.txt: which repo goes to which Discord channel.

const REPOS_FILE = new URL("./repos.txt", import.meta.url).pathname;

export type Target = { repo: string; channel: string; tag?: string };

// A line holding only a channel ID lists a channel for the bridge without any repo.
async function readLines(): Promise<(Target | string)[]> {
  const text = await Bun.file(REPOS_FILE).text();
  return text
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean)
    .map((line) => {
      if (/^\d+$/.test(line)) return line;
      const [repo, channel, ...tag] = line.split(/\s+/);
      if (!repo || !channel || !/^\d+$/.test(channel)) throw new Error(`bad line in repos.txt: "${line}"`);
      return { repo, channel, tag: tag.join(" ") || undefined };
    });
}

export async function readRepos(): Promise<Target[]> {
  return (await readLines()).filter((t): t is Target => typeof t !== "string");
}

// Every channel listed in repos.txt, with or without a repo.
export async function readChannels(): Promise<string[]> {
  return (await readLines()).map((t) => (typeof t === "string" ? t : t.channel));
}
