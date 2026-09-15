# disco

Posts new GitHub releases to Discord channels on a single server.

## How it works

- `.github/workflows/notify.yml` runs `bun notify.ts` every 6 hours (and via manual dispatch), then commits `state.json`.
- `notify.ts` reads `https://github.com/<repo>/releases.atom` for each repo in `repos.txt` and posts unseen entries through a Discord bot (`DISCORD_BOT_TOKEN` secret).
- `repos.txt`: `owner/name channel_id [forum tag]`, one per line, `#` comments.
  - Text/announcement channel or thread/forum post ID → message.
  - Forum/media channel (type 15/16, detected via `GET /channels/:id`) → new post per release; optional tag name must already exist on the forum.
- `state.json`: seen Atom entry IDs per repo (last 100). A repo with no entry is seeded without posting, so adding a repo never floods a channel. An entry is marked seen only after Discord accepts the post.
- The state commit step rebases and retries the push up to 5 times so a concurrent push can't cause duplicate posts; a conflict on `state.json` fails the job loudly.

## Setup

- Bot must be added to the server via OAuth2 URL Generator (scope `bot`; View Channels, Send Messages, Embed Links, Send Messages in Threads). Private channels need explicit permission overrides. No gateway intents needed.
- Repo settings: `DISCORD_BOT_TOKEN` secret; Actions workflow permissions set to read and write.
- Channel IDs: enable Developer Mode in Discord, right-click → Copy Channel ID.

## Development

- Bun + TypeScript; only dependency is `fast-xml-parser`. Keep `bun.lock` committed (CI uses `--frozen-lockfile`).
- Typecheck: `bunx tsc --noEmit --strict --target esnext --module esnext --moduleResolution bundler --types bun --skipLibCheck notify.ts`
- Test locally in a scratch copy with the `DISCORD_API` constant rewritten to a local `Bun.serve` fake; never post to the real server while testing.

## Commits

- One-line commit messages.
- Never add `Co-Authored-By` trailers or any other attribution lines.
