# disco

Posts new GitHub releases to Discord channels on a single server, and bridges that server's messages to one Slack channel.

## How it works

- `.github/workflows/notify.yml` runs `bun notify.ts` then `bun bridge.ts` every 4 hours (and via manual dispatch), then commits `state.json` and `bridge-state.json`.
- `discord.ts`: shared Discord REST helper (429 retry, `HttpError` with status).
- `notify.ts` reads `https://github.com/<repo>/releases.atom` for each repo in `repos.txt` and posts unseen entries through a Discord bot (`DISCORD_BOT_TOKEN` secret).
- `repos.txt`: `owner/name channel_id [forum tag]`, one per line, `#` comments.
  - Text/announcement channel or thread/forum post ID → message.
  - Forum/media channel (type 15/16, detected via `GET /channels/:id`) → new post per release; optional tag name must already exist on the forum.
- `state.json`: seen Atom entry IDs per repo (last 100). A repo with no entry is seeded without posting, so adding a repo never floods a channel. An entry is marked seen only after Discord accepts the post.
- The state commit step rebases and retries the push up to 5 times so a concurrent push can't cause duplicate posts; a conflict on a state file fails the job loudly.
- `bridge.ts`: finds the bot's only server, reads text/announcement/voice channels, active threads, and public threads archived since the last run, fetches messages after each channel's cursor, and posts them to Slack in server-wide snowflake order via `chat.postMessage` with the Discord author's name and avatar. Channels the bot can't read (403/404) are skipped, as are the bot's own messages. Edits, deletes and reactions are not bridged.
- `bridge-state.json`: `since` (snowflake of the last successful run's start) plus the last bridged message ID per channel. The first run seeds without posting; channels without a cursor (new channels and threads, regained access) are read from `since`. Posting stops at the first Slack failure, and a cursor advances only after Slack accepts the message.

## Setup

- Bot must be added to the server via OAuth2 URL Generator (scope `bot`; View Channels, Send Messages, Embed Links, Send Messages in Threads, Read Message History). Private channels need explicit permission overrides. No gateway connection needed, but the bridge needs the privileged **Message Content Intent** turned on in the Developer Portal (Bot tab), or message text arrives empty.
- Slack app: bot scopes `chat:write` and `chat:write.customize`, installed to the workspace, then invited to the target channel.
- Repo settings: `DISCORD_BOT_TOKEN` and `SLACK_BOT_TOKEN` (`xoxb-…`) secrets; `SLACK_CHANNEL_ID` variable; Actions workflow permissions set to read and write.
- Channel IDs: enable Developer Mode in Discord, right-click → Copy Channel ID.

## Development

- Bun + TypeScript; only dependency is `fast-xml-parser`. Keep `bun.lock` committed (CI uses `--frozen-lockfile`).
- Typecheck: `bunx tsc --noEmit --strict --target esnext --module esnext --moduleResolution bundler --allowImportingTsExtensions --types bun --skipLibCheck notify.ts bridge.ts`
- Test locally in a scratch copy with the `DISCORD_API` (`discord.ts`) and `SLACK_API` (`bridge.ts`) constants rewritten to a local `Bun.serve` fake; never post to the real server or workspace while testing.

## Commits

- One-line commit messages.
- Never add `Co-Authored-By` trailers or any other attribution lines.
