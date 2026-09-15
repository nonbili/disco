// Shared reader for repos.txt: which repo goes to which Discord channel.

const REPOS_FILE = new URL("./repos.txt", import.meta.url).pathname;

export type Target = { repo: string; channel: string; tag?: string };

export async function readRepos(): Promise<Target[]> {
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
