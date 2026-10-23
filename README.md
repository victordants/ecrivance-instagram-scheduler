# ecrivance-instagram-scheduler

Publishes @ecrivance's scheduled posts from GitHub Actions, so the Mac doesn't need to be on.

- **Schedule + media** live in the Supabase bucket `instagram-media` (`schedule/schedule.json`, `scheduled/<id>/…`), pushed from the app repo with `npx tsx marketing/instagram/scripts/cloud-sync.ts`.
- **This repo** runs `run.mjs` every hour; it publishes posts whose Pacific-time slot has arrived, writes `schedule/state.json`, and deletes the published media.
- **Dedup:** a post whose caption's first line is already on the profile is adopted, never re-posted.
- **Secrets:** `IG_TOKEN`, `IG_USER_ID`, `SUPABASE_URL`, `SUPABASE_KEY`. The Instagram token expires ~2026-12-19 — refresh locally (`npm run token -- --refresh` in marketing/instagram) and update `IG_TOKEN`.
- **Test:** Actions → "Publish scheduled Instagram posts" → Run workflow (dry run is the default for manual runs).
