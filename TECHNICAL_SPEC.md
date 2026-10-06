# Application skeleton

Reusable layout for a Vite + React SPA, an Amplify Gen 2 function backend, and Supabase for auth and Postgres. Copy the directories and conventions below. Replace every `<feature>` slot with the new app’s areas. Do not copy feature-specific modules.

## Layers

```
Browser
  src/            bootstrap, routes, global CSS
  components/     screens and primitives
  hooks/          React state and providers
  lib/            non-React logic and typed API facades
  utils/          process-wide clients
        │
        ├── Supabase JS (session + row access under RLS)
        └── POST to Lambda Function URLs (Bearer session token)
                │
                amplify/functions/<name>/handler.ts
                  amplify/functions/_shared/   HTTP, auth, secrets
                │
                Supabase (same JWT, same RLS)
```

Auth lives only in Supabase. The Amplify stack defines functions and Function URLs. It does not define an identity provider.

## Directory contract

```
.
├── index.html                 # document shell, font links, manifest, #root
├── src/
│   ├── main.tsx               # React root, BrowserRouter, service worker
│   ├── App.tsx                # providers, routes, toaster, analytics gate
│   └── index.css              # Tailwind entry and theme tokens
├── components/
│   ├── ui/                    # presentational primitives only
│   ├── layout/                # app shell: header, nav, <Outlet />
│   ├── auth/                  # sign-in, recovery, route guards
│   ├── settings/              # account and preference screen
│   ├── metrics/               # small stat displays used by screens
│   └── <feature>/             # one folder per screen area
├── hooks/
│   ├── useAuth.tsx            # auth context + hook
│   └── use<Feature>.tsx       # one provider or hook per feature
├── lib/
│   ├── utils.ts               # className helper; keep feature helpers elsewhere
│   ├── amplify/
│   │   ├── client.ts          # generic Function URL caller
│   │   └── <feature>-functions.ts
│   ├── supabase/
│   │   ├── url.ts             # origin normalizer
│   │   ├── types.ts           # hand-written DB types
│   │   └── <table>.ts         # row helpers for one table
│   └── <feature>/             # pure TypeScript, no React
├── utils/
│   └── supabase.ts            # singleton Supabase client + auth callback
├── amplify/
│   ├── backend.ts             # defineBackend, Function URLs, custom outputs
│   ├── loadEnv.ts             # reads .env before synthesize
│   ├── package.json           # { "type": "module" }
│   └── functions/
│       ├── _shared/           # imported by handlers only
│       └── <function-name>/
│           ├── resource.ts    # defineFunction
│           └── handler.ts     # export const handler
├── supabase/
│   ├── schema.sql             # full schema, source of truth
│   └── migrations/            # NNNN_name.sql, applied in order
├── public/
│   ├── manifest.json
│   ├── sw.js
│   └── icons/
├── scripts/
│   ├── deploy.sh              # tsc, vite build, zip, SSH, nginx reload
│   └── test-<integration>.ts  # one-off scripts run with tsx
├── amplify_outputs.json       # generated Function URL map, imported by the SPA
├── components.json            # shadcn aliases
├── vite.config.ts
├── tsconfig.json
├── postcss.config.mjs
├── .env.example
└── package.json
```

`<feature>` folders in `components/`, `hooks/`, `lib/`, and `amplify/functions/` are the only product-specific surface. Infrastructure files stay.

## Path alias

`@/*` maps to the repository root in both `tsconfig.json` (`baseUrl` + `paths`) and `vite.config.ts` (`resolve.alias`). Imports look like `@/components/...`, `@/hooks/...`, `@/lib/...`, `@/utils/...`.

`tsconfig.json` `include` lists `src`, `components`, `hooks`, `lib`, `utils`, `amplify`, `scripts`, and `vite.config.ts`. Compiler flags that matter for this layout: `strict`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`, `noEmit`, `jsx: react-jsx`, `moduleResolution: bundler`.

## Dependency direction

| From | May import | Must not import |
|---|---|---|
| `components/` | `components/ui`, `hooks`, `lib`, `utils` | `amplify/functions` |
| `hooks/` | other hooks, `lib`, `utils` | `components` |
| `lib/` | other `lib` modules, `utils` | React, `components`, `hooks` |
| `utils/` | `lib` helpers, third-party clients | React, `components`, `hooks` |
| `amplify/functions/*/handler.ts` | `../_shared` | React, `components`, `hooks` |
| `amplify/backend.ts` | `./loadEnv.js`, `./functions/*/resource.js` | the SPA |

`amplify/loadEnv.ts` may import a pure helper from `lib/` (URL normalization). Handlers stay on `_shared` plus their own file.

`components/ui` receives props and renders markup. It does not fetch, read context, or know about routes.

## Frontend composition

### Bootstrap

`index.html` mounts `#root` and loads `/src/main.tsx` as a module. `main.tsx` renders `StrictMode` → `BrowserRouter` → `App`, imports `src/index.css`, registers `/sw.js` only when `import.meta.env.PROD`, and unregisters leftover workers in development.

### Providers and routes

`App.tsx` nests providers outside `<Routes>` so every route shares them. Order:

1. Auth provider (session).
2. Feature providers that depend on auth.
3. `<Routes>`.
4. Toaster, sibling of the router tree.
5. Analytics, rendered only when `import.meta.env.PROD`.

Route shape:

| Path | Wrapper | Element |
|---|---|---|
| `/login` | none | sign-in screen |
| `/reset-password` | none | recovery screen |
| layout route | `RequireAuth` → shell | `<Outlet />` |
| index and feature paths | `SignedInOnly` when a guest session must be excluded | feature view |
| `*` inside the shell | same as index | fallback view |

`RequireAuth` waits on the auth hook, then redirects signed-out visitors to `/login` and preserves the attempted path in location state. `SignedInOnly` redirects a guest session away from account-only routes. The shell reads the auth hook to decide which nav links to show and renders a banner when `amplify_outputs.json` has no function URLs.

### Hooks

A feature that many screens share is a context module: `createContext`, a `*Provider`, and a `use*` hook that throws if used outside the provider. Place the provider in `App.tsx`.

A feature used by one screen is a plain hook file (`use<Feature>.ts`) called from that view. Hooks call `lib/` facades. They do not call `fetch` directly.

### Feature view folder

```
components/<feature>/
  <Feature>View.tsx       # route element
  <Thing>Card.tsx         # list item
  <Thing>DetailDialog.tsx # overlay owned by the view
```

Views compose `components/ui` primitives and call hooks. Shared chrome (page width, sticky header, bottom nav) stays in `components/layout`.

### Styling

Tailwind CSS 4 is loaded from `src/index.css` via `@import 'tailwindcss'`. Theme tokens are CSS variables on `:root` and `.dark`, mapped into Tailwind with `@theme inline`. `postcss.config.mjs` registers `@tailwindcss/postcss` only.

`components.json` points shadcn at `src/index.css`, style `new-york`, `components/ui`, and the `@/` aliases. `lib/utils.ts` exports `cn` (`clsx` + `tailwind-merge`). Primitives in `components/ui` use `cn` and `class-variance-authority`. Icons come from `lucide-react`.

### PWA shell

`public/manifest.json` is linked from `index.html` (`display: standalone`, icons under `public/icons/`). `public/sw.js` is a static file, not a Vite plugin. Registration is in `main.tsx`, production only.

## Backend functions

One operation is one directory:

```
amplify/functions/<kebab-name>/
  resource.ts    # defineFunction({ name, entry: './handler.ts', timeoutSeconds, memoryMB, environment })
  handler.ts     # export const handler = withHttp(async (event) => ...)
```

`resource.ts` exports a camelCase binding. Secrets use `secret('NAME')` from `@aws-amplify/backend`. Non-secret values that Lambdas need at runtime are copied from `process.env` inside `environment`. `backend.ts` imports `./loadEnv.js` first so `.env` and `.env.local` exist at synthesize time.

`amplify/backend.ts`:

1. Calls `defineBackend({ ...resources })`.
2. For each resource, adds a Function URL with auth type `NONE`, CORS `POST`, headers `content-type` and `authorization`.
3. Writes `backend.addOutput({ custom })` where each key is `<camelName>Url`.

The SPA never hardcodes function hosts. `lib/amplify/client.ts` imports `amplify_outputs.json` and reads `custom.<name>Url`.

### Shared handler modules

`amplify/functions/_shared/` is the only place handlers share code. Relative imports use a `.js` suffix (Node ESM).

| File | Role |
|---|---|
| `http.ts` | `HttpError`, `json()`, `parseBody()`, `withHttp()` (POST-only, error translation, timing) |
| `verifySupabaseAuth.ts` | required and optional Bearer checks |
| `supabaseJwt.ts` | JWT verification |
| `supabaseUser.ts` | bind the verified user for the request |
| `secrets.ts` | read env baked in by `resource.ts` |
| `rateLimit.ts` | per-caller limit |
| `timing.ts` | request timing log |
| `<vendor>.ts` | HTTP client for an external API used by more than one handler |

A vendor client used by a single handler can stay in that handler’s folder. Promote it to `_shared` when a second handler needs it.

Handler return shape is JSON from `json(status, body)`. Failures throw `HttpError`. `withHttp` turns that into `{ error: message }`.

### Browser call path

`lib/amplify/client.ts` exports `callFunction<TResponse>(key, body, { auth })`. It reads the Supabase access token and `POST`s JSON. `auth: 'optional'` allows a missing session. Missing outputs throw a configuration error that tells the developer to run the sandbox script.

`lib/amplify/<feature>-functions.ts` is a typed facade: request and response types plus functions that call `callFunction`. Hooks and views import the facade, not `client.ts`, except for the “are functions configured” flag.

## Data and auth

`utils/supabase.ts` creates one `createClient<Database>`:

- URL from a `VITE_` project origin, passed through `lib/supabase/url.ts` (strip a `/rest/v1` suffix if present).
- Publishable key from a `VITE_` env var.
- `persistSession`, `autoRefreshToken`, `detectSessionInUrl`.
- `storageKey` includes the project ref so sessions from another project are not reused.
- If env is missing, warn and still construct a client so the UI can show a config state instead of crashing at import time.

Auth callback parsing (recovery hash, error description, token hash) lives in the same file, read before the client is created, because the client consumes the URL.

`hooks/useAuth.tsx` subscribes to `onAuthStateChange` and exposes session, user, loading, and the auth actions the screens call. Route guards only use this hook.

`lib/supabase/types.ts` is the `Database` type and the row aliases the SPA uses. `supabase/schema.sql` is the full schema. `supabase/migrations/NNNN_name.sql` is the incremental history. User-owned tables use `auth.uid()` in RLS. Lambdas call Supabase with the publishable key and the caller’s JWT, so the same policies apply. A service-role key is not used on the request path.

## Environment

| Kind | Where it lives | Who reads it |
|---|---|---|
| `VITE_*` URL and publishable key | `.env` / `.env.local` | Vite, and `loadEnv.ts` so they can be baked into Lambda env |
| Third-party secrets | Amplify sandbox secrets | `secret()` in `resource.ts` |
| Deploy host | shell env for `scripts/deploy.sh` | `DEPLOY_HOST`, `DEPLOY_PATH` |

`.env.example` lists names only. `.gitignore` ignores `.env`, `.env.local`, `dist/`, and `.amplify/`. `amplify_outputs.json` is committed so the SPA can build; other `amplify_outputs*.json` files are ignored.

Secret setter scripts in `package.json` follow `amplify:secret:<name>` → `npx ampx sandbox secret set <ENV_NAME>`.

## Scripts

| Script | Command |
|---|---|
| `dev` | `vite` (port 5173) |
| `build` | `tsc -b && vite build` → `dist/` |
| `preview` | `vite preview` |
| `typecheck` | `tsc -b` |
| `amplify:sandbox` | `npx ampx sandbox` |
| `deploy` | `bash scripts/deploy.sh` |
| `test:<name>` | `tsx scripts/test-<name>.ts` |

`scripts/deploy.sh` typechecks, builds, zips `dist/`, copies it over SSH, swaps the nginx document root, and reloads nginx. It does not deploy Lambdas. Lambda deploy is the Amplify sandbox or pipeline.

## Adding a feature

1. Add `components/<feature>/` with a route element.
2. Add the route under the shell in `App.tsx`. Add a nav item in the shell.
3. If more than one screen needs the data, add `hooks/use<Feature>.tsx` and wrap it in `App.tsx` under the auth provider.
4. Put request types and `callFunction` wrappers in `lib/amplify/<feature>-functions.ts`.
5. Put non-React helpers in `lib/<feature>/`.
6. Add `amplify/functions/<kebab-name>/{resource.ts,handler.ts}`.
7. Register the resource in `amplify/backend.ts` and add a `<camelName>Url` output key.
8. Add the key to the union in `lib/amplify/client.ts`.
9. If the feature stores rows, update `supabase/schema.sql`, add the next migration, extend `lib/supabase/types.ts`, and keep RLS keyed to `auth.uid()`.

## Stack pins

| Layer | Libraries |
|---|---|
| UI runtime | React 19, React Router 7, TypeScript 5 |
| Build | Vite 6, `@vitejs/plugin-react` |
| Style | Tailwind CSS 4, PostCSS, `clsx`, `tailwind-merge`, `class-variance-authority` |
| Primitives | Radix UI, shadcn (New York), `lucide-react`, `next-themes`, Sonner |
| Forms | `react-hook-form`, Zod |
| Auth and data | `@supabase/supabase-js` |
| Functions | `@aws-amplify/backend`, AWS CDK, `@types/aws-lambda` |
| SPA host | static `dist/` behind nginx (`scripts/deploy.sh`) |
| Analytics | `@vercel/analytics`, production build only |
