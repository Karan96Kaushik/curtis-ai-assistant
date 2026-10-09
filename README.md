# Curtis

Curtis is a personal assistant for Jira, GitHub, the web, timesheets, and release workflows. The same agent runs in three places:

- **Web chat** — a React app (sign-in, conversations, settings) that calls an AWS Lambda.
- **Discord bot** — slash commands, `!` message commands, and natural-language replies when you mention the bot or DM it.
- **CLI** — the same Jira, GitHub, and release tasks, without Discord.

Mutating actions (create, update, delete) stage a plan and wait for confirmation unless `REQUIRE_CONFIRMATION` is turned off.

## Prerequisites

- [Node.js 22](https://nodejs.org/) (the chat Lambda uses runtime 22)
- A [Supabase](https://supabase.com/) project, for the web app
- An AWS account with the Amplify CLI available, for the chat Lambda
- API credentials for the tools you want the agent to use (see [Configuration](#configuration))

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`. Never commit it.

### Web app

1. In the Supabase SQL editor, run [`supabase/schema.sql`](supabase/schema.sql). That file is the full schema. [`supabase/migrations/`](supabase/migrations/) is the incremental history if a database already exists.
2. Set `VITE_SUPABASE_URL_CURTIS`, `VITE_SUPABASE_PUBLISHABLE_KEY_CURTIS`, and `ALLOWED_EMAILS` in `.env`. An empty allow-list means nobody can call the chat Lambda.
3. Start an Amplify sandbox and store secrets there (they are not read from `.env` at Lambda runtime):

```bash
npm run amplify:sandbox
npm run amplify:secret:groq
npm run amplify:secret:google
npm run amplify:secret:openrouter
npm run amplify:secret:jira
npm run amplify:secret:github
npm run amplify:secret:serp
```

The sandbox writes `amplify_outputs.json`, which the SPA uses to find the chat Function URL.

4. Start the UI:

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Sign in with a Supabase user whose email is in `ALLOWED_EMAILS`.

| Path | Screen |
|---|---|
| `/login` | Sign in |
| `/reset-password` | Password recovery |
| `/` and `/c/:conversationId` | Chat |
| `/settings` | Account, theme, and saved contexts |

### Discord bot

Set `DISCORD_BOT_TOKEN`, `DISCORD_APP_ID`, and the Jira / model keys in `.env`, then:

```bash
npm run register-commands   # register slash commands with Discord
npm start                   # gateway bot, restarts on file changes
```

`npm run bot` runs the same process once, without nodemon.

Message commands use the `!` prefix (`DISCORD_COMMAND_PREFIX`). Mention the bot, or DM it, to talk in natural language. `!help` lists the Jira commands. Set `DISCORD_AI=0` to disable the model, or `DISCORD_AI_LISTEN=all` to answer every message in channels the bot can see.

### CLI

```bash
npm run cli -- --help
npm run cli -- jira-whoami
npm run cli -- jira-my-issues --max 10
npm run cli -- github-list-repos --org my-org
```

Jira commands cover create, update, comments, assigned issues, and a monthly activity report. GitHub commands cover repo search, tags, pull requests, and a monthly activity report. `wf-release-start`, `wf-release-status`, and `wf-release-advance` drive the release workflow; pass `--confirm` when you want a staged write to run.

## Configuration

[`.env.example`](.env.example) lists every variable. Two groups matter:

**Web (Vite + Lambda).** `VITE_SUPABASE_*_CURTIS` and `ALLOWED_EMAILS` are required. Non-secret integration settings (`JIRA_BASE_URL`, `JIRA_EMAIL`, `GROQ_MODEL`, `REQUIRE_CONFIRMATION`, GitHub activity filters, and so on) are copied into the Lambda at synth time. Secrets (`GROQ_API_KEY`, `GOOGLE_AI_STUDIO_API_KEY`, `OPENROUTER_API_KEY`, `JIRA_API_TOKEN`, `GITHUB_TOKEN`, `SERP_API_KEY`) live in the Amplify sandbox.

**Local bot and CLI.** The same secret names are read from `.env` by `dotenv`. Discord also needs `DISCORD_BOT_TOKEN` and `DISCORD_APP_ID`. Optional: `DISCORD_PUBLIC_KEY`, `DISCORD_CLIENT_SECRET`, `PUBLIC_BASE_URL`, extra Groq keys (`GROQ_API_KEY_2`, `GROQ_API_KEY_3`).

Defaults that are not secrets live in [`src/config.js`](src/config.js) and can be overridden with environment variables. That includes confirmation, the Firefox bridge port, GitHub activity filters, Jira project aliases, and cross-linking Jira issues with GitHub pull requests.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server on port 5173 |
| `npm run build` | Typecheck and production build into `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run typecheck` | `tsc -b` only |
| `npm start` / `npm run bot` | Discord gateway bot (nodemon / once) |
| `npm run cli -- <command>` | Local task runner |
| `npm run register-commands` | Register Discord slash commands |
| `npm run deploy` | Build the SPA and publish `dist/` to an nginx host |
| `npm run amplify:sandbox` | Deploy the chat Lambda to an Amplify sandbox |
| `npm run amplify:secret:*` | Set one sandbox secret |
| `npm run groq:billing` | Check Groq billing |
| `npm run jira:activity` / `npm run github:activity` | Monthly activity reports |
| `npm run extension:pack` | Pack the Firefox bridge into `dist/curtis-bridge.xpi` |
| `npm test` | Smoke-test GitHub repo listing |

## Deploying the web app

The SPA and the Lambda ship separately.

```bash
DEPLOY_HOST=user@host DEPLOY_PATH=/var/www/curtis npm run deploy
```

[`scripts/deploy.sh`](scripts/deploy.sh) typechecks, builds, and uploads `dist/` to `DEPLOY_PATH/releases/<timestamp>`, then points `DEPLOY_PATH/current` at that release and reloads nginx. Deploy the Lambda with `npm run amplify:sandbox` or an Amplify pipeline. The host must be serving a build whose `amplify_outputs.json` matches the deployed function.

## Firefox bridge

[`extensions/firefox`](extensions/firefox) lets the **local** Discord bot drive a Firefox session over `ws://127.0.0.1:8765` (port from `EXTENSION_WS_PORT`). It is not used by the web app.

```bash
npm run extension:pack
```

In Firefox, open `about:debugging` → This Firefox → Load Temporary Add-on, and select `dist/curtis-bridge.xpi`. Set `EXTENSION_WS_TOKEN` if you want the extension to present a shared secret on connect.

## Layout

```
src/                 React app (routes, styles) and the agent (tasks, modules, workflows)
components/          Chat, auth, settings, and UI primitives
hooks/               Auth and conversation state
lib/                 Typed API facades (Supabase, Amplify, chat)
amplify/functions/   Chat Lambda and shared HTTP / auth helpers
bot/client.js        Discord gateway
cli.js               Commander CLI
extensions/firefox/  Local browser bridge
supabase/            schema.sql and migrations
scripts/             Deploy, command registration, reports, tests
```

[`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md) describes the SPA, Amplify, and Supabase layout conventions.

Auth is Supabase only. Postgres row access is limited to `auth.uid()` under RLS. The Amplify stack defines the chat function and its Function URL. It does not define an identity provider. The browser talks to Supabase for sessions and rows, and posts to the Lambda with the session token.
