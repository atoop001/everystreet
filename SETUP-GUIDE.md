# Every Street — Phase 1 Setup Guide (Windows)

Follow these steps in order. Nothing here assumes programming experience.
Total time: about 45–60 minutes the first time. Where you see `commands
in a box`, you'll type them into a terminal window (instructions below).

---

## Step 1 — Install the three tools (one time only)

1. **Node.js** (runs the app's code)
   - Go to https://nodejs.org and download the **LTS** version for Windows.
   - Run the installer, click Next through everything (defaults are fine).

2. **Git** (manages the code; Claude Code needs it)
   - Go to https://git-scm.com/download/win and run the installer.
   - Defaults are fine — click Next through everything.

3. **VS Code** (a friendly window for viewing code and opening terminals)
   - Go to https://code.visualstudio.com and install it.

To check it worked: open the Start menu, type `powershell`, open **Windows
PowerShell**, and type:

```
node --version
git --version
```

Each should print a version number. If you see "not recognized," restart
your computer and try again (installers sometimes need a restart).

---

## Step 2 — Put the project on your computer

1. Unzip the `everystreet` folder you downloaded from Claude to somewhere
   easy, like `C:\Users\<you>\Documents\everystreet`.
2. Open VS Code → **File → Open Folder** → choose the `everystreet` folder.
3. In VS Code, open a terminal with **Terminal → New Terminal**. All
   commands below are typed there.

---

## Step 3 — Set up Supabase (your database + user accounts)

You said you already have a Supabase account — good.

1. Go to https://supabase.com/dashboard → **New project**.
   - Name: `everystreet` · pick a strong database password (save it) ·
     choose the region closest to you → **Create**.
   - Wait ~2 minutes while it provisions.

2. **Create the database tables.** In your project's left sidebar click
   **SQL Editor** → **New query**. Open the file `supabase/schema.sql`
   from this project in VS Code, copy ALL of it, paste it into the SQL
   editor, and click **Run**. You should see "Success."

3. **Turn on email sign-in links.** Left sidebar → **Authentication →
   Providers → Email**: make sure Email is enabled (it is by default).

4. **Collect your keys.** Left sidebar → **Project Settings → API Keys**:
   - **Project URL** (looks like `https://abcdxyz.supabase.co`)
   - **Publishable key** (starts `sb_publishable_...`) — safe to expose in
     the browser.
   - **Secret key** (starts `sb_secret_...`) — click **Reveal**, or
     **Create new secret key** if none exists yet. Keep this one secret!

   > If this page shows only an **anon** and **service_role** key under a
   > **Legacy API Keys** tab, look for a nearby **API Keys** tab and click
   > **Enable** (or **Create publishable/secret keys**) to generate the
   > new-format keys this app expects. Supabase keeps the legacy keys
   > working too, but don't use them here.

5. **Check your JWT signing key.** Left sidebar → **Project Settings →
   JWT Keys**. New projects already sign sessions with a rotatable key
   pair, so there's usually nothing to do here. If the page shows a
   banner about your project still using a **legacy JWT secret**, click
   through the migration prompt (e.g. **Migrate JWT secret** / **start
   using JWT signing keys**) to switch — it's a one-click, zero-downtime
   change, and no secret needs copying anywhere: the app verifies
   sign-ins against your project's *public* keys automatically.

---

## Step 4 — Give the app your keys

Two small text files to create (they're deliberately NOT included in the
project, because they contain secrets).

1. In VS Code's file list, inside the **server** folder, find
   `.env.example`. Right-click it → Copy, then Paste, then rename the
   copy to exactly `.env`. Open it and fill in:

```
SUPABASE_URL=your Project URL
SUPABASE_SECRET_KEY=your Secret key (sb_secret_...)
PORT=3001
WEB_ORIGIN=http://localhost:5173
```

2. Do the same inside the **web** folder (`.env.example` → `.env`):

```
VITE_SUPABASE_URL=your Project URL
VITE_SUPABASE_PUBLISHABLE_KEY=your Publishable key (sb_publishable_...)
VITE_API_URL=http://localhost:3001
```

> The Secret key belongs ONLY in the server's file. Never put it in the
> web file — the web file's contents are visible to anyone using the
> site. The Publishable key is designed to be public, so it's fine in
> the web file.

---

## Step 5 — Start it up

In the VS Code terminal:

```
cd server
npm install
npm run dev
```

Leave that running. You should see:
`Every Street server → http://localhost:3001`

Open a **second** terminal (**Terminal → New Terminal**) and run:

```
cd web
npm install
npm run dev
```

It will print a local address — usually `http://localhost:5173`.
Open that in your browser.

---

## Step 6 — Use it

1. Enter your email → click the sign-in link Supabase emails you.
2. Search a **neighborhood or small town** (start small — a first import
   fetches real street data and takes up to a minute; after that it's
   cached and instant for everyone).
3. Pick a start mode, set your distance, **Generate route**.
4. **Download GPX** → import into Garmin Connect (web: Training →
   Courses → Import) or open in any GPS app.
5. After you actually run it, click **Mark run complete** — the heatmap
   turns those streets green, and your next generated route will steer
   toward what's left.

Your data lives in your Supabase cloud account, so when the mobile apps
arrive in Phase 2 they'll show the same heatmap automatically.

---

## Everyday use after setup

Just the two `npm run dev` commands (Step 5) — everything else was
one-time. To stop the app, click a terminal and press `Ctrl+C`.

## If something goes wrong

| Symptom | Likely fix |
|---|---|
| "Set SUPABASE_URL..." error when starting server | The server `.env` file is missing or misnamed (must be exactly `.env`) |
| Sign-in email never arrives | Check spam; Supabase's built-in email is slow-ish and capped at ~4/hour on free tier |
| "Session expired — sign in again" | `SUPABASE_URL` in server `.env` doesn't match your project, or your project's JWT signing keys were recently rotated/revoked — double-check the URL and try signing in again |
| Area search fails / times out (504) | The free dev data source can't handle a whole city in one query — search a **neighborhood or small town** instead (limit ~12 km across). If a small area also fails, it may just be briefly overloaded — wait 1–2 min and retry |
| Search works but map is blank | Hard-refresh the browser (Ctrl+Shift+R) |

## Working on this with Claude Code (recommended next step)

Install Claude Code (https://claude.com/claude-code) and open it in the
project folder. It can run these commands for you, fix errors, and build
Phase 2 with you. Good first prompts:

- "Run the server and web app and confirm everything works."
- "Add a delete button to the run history list."
- When ready: "Start Phase 2 from the architecture doc: scaffold the
  Expo mobile app that talks to this same API."
