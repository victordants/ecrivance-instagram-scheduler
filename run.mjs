// Cloud publisher for @ecrivance. Runs hourly on GitHub Actions; publishes every scheduled post whose
// Pacific-time slot has arrived. The schedule and media are pushed by marketing/instagram/scripts/cloud-sync.ts
// in the app repo. No dependencies — Node 20 fetch only.
//   DRY_RUN=1 node run.mjs   → print what would be published, touch nothing
const { IG_TOKEN, IG_USER_ID, SUPABASE_URL, SUPABASE_KEY, DRY_RUN } = process.env;
for (const [k, v] of Object.entries({ IG_TOKEN, IG_USER_ID, SUPABASE_URL, SUPABASE_KEY })) if (!v) throw new Error(`missing secret ${k}`);
const dry = DRY_RUN === "1" || DRY_RUN === "true";
const BUCKET = "instagram-media";
const GRAPH = "https://graph.instagram.com/v24.0";
const base = SUPABASE_URL.replace(/\/$/, "");
const sbHeaders = { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY };
const summary = [];
const say = (s) => (console.log(s), summary.push(s));

// ── storage ──
async function getJson(path, fallback) {
  const r = await fetch(`${base}/storage/v1/object/${BUCKET}/${path}`, { headers: sbHeaders });
  return r.ok ? r.json() : fallback;
}
async function putJson(path, data) {
  const r = await fetch(`${base}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: { ...sbHeaders, "Content-Type": "application/json", "x-upsert": "true", "cache-control": "no-cache" },
    body: JSON.stringify(data, null, 2),
  });
  if (!r.ok) throw new Error(`save ${path}: ${r.status} ${await r.text()}`);
}
async function removePrefix(prefix) {
  const list = await fetch(`${base}/storage/v1/object/list/${BUCKET}`, {
    method: "POST",
    headers: { ...sbHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ prefix, limit: 100 }),
  }).then((r) => r.json());
  const paths = (Array.isArray(list) ? list : []).map((o) => `${prefix}${o.name}`);
  if (paths.length)
    await fetch(`${base}/storage/v1/object/${BUCKET}`, { method: "DELETE", headers: { ...sbHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: paths }) });
}

// ── graph ──
async function graph(method, endpoint, params = {}) {
  const url = new URL(`${GRAPH}/${endpoint}`);
  const body = new URLSearchParams();
  const target = method === "GET" ? url.searchParams : body;
  for (const [k, v] of Object.entries(params)) if (v !== undefined) target.set(k, String(v));
  target.set("access_token", IG_TOKEN);
  const r = await fetch(url, method === "GET" ? undefined : { method, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Graph ${method} ${url.pathname}: ${j.error?.code ?? r.status} ${j.error?.message ?? ""}`);
  return j;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFinished(id, label) {
  for (let i = 0; i < 60; i++) {
    const { status_code, status } = await graph("GET", id, { fields: "status_code,status" });
    if (status_code === "FINISHED") return;
    if (status_code === "ERROR" || status_code === "EXPIRED") throw new Error(`${label} container ${status_code}: ${status ?? ""}`);
    await sleep(5000);
  }
  throw new Error(`${label} still processing after 5 min`);
}

// ── time (Pacific, DST-aware) ──
function pacificNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

const firstLine = (s) => (s ?? "").split("\n")[0].trim();

async function main() {
  const now = pacificNow();
  const schedule = await getJson("schedule/schedule.json", []);
  const state = await getJson("schedule/state.json", { published: {} });
  const open = schedule.filter((p) => !state.published[p.id]);
  const due = open.filter((p) => p.date === now.date && p.time <= now.time);
  const missed = open.filter((p) => p.date < now.date).slice(0, 1); // catch up at most one old post per run
  say(`Pacific ${now.date} ${now.time} · ${schedule.length} scheduled · ${open.length} open · ${due.length} due · ${missed.length} catch-up${dry ? " · DRY RUN" : ""}`);

  // Dedup guard: anything already on the profile (e.g. posted by the local Mac agent) is adopted, not re-posted.
  const recent = (await graph("GET", "me/media", { fields: "id,permalink,timestamp,caption", limit: 25 })).data;
  let failed = 0;
  for (const p of [...missed, ...due]) {
    const twin = recent.find((m) => firstLine(m.caption) === firstLine(p.caption));
    if (twin) {
      state.published[p.id] = { mediaId: twin.id, permalink: twin.permalink, at: twin.timestamp, adopted: true };
      if (!dry) await putJson("schedule/state.json", state);
      say(`= ${p.id} already on the profile → ${twin.permalink}`);
      continue;
    }
    if (dry) {
      say(`→ would publish ${p.id} (${p.type}, ${p.media.length} file(s))`);
      continue;
    }
    try {
      let creationId;
      if (p.type === "carousel") {
        const children = [];
        for (const [i, url] of p.media.entries()) {
          const { id } = await graph("POST", `${IG_USER_ID}/media`, { image_url: url, is_carousel_item: true });
          await waitFinished(id, `slide ${i + 1}`);
          children.push(id);
        }
        ({ id: creationId } = await graph("POST", `${IG_USER_ID}/media`, { media_type: "CAROUSEL", children: children.join(","), caption: p.caption }));
      } else {
        ({ id: creationId } = await graph("POST", `${IG_USER_ID}/media`, { media_type: "REELS", video_url: p.media[0], caption: p.caption, share_to_feed: true, thumb_offset: p.thumbOffsetMs }));
      }
      await waitFinished(creationId, "post");
      const { id: mediaId } = await graph("POST", `${IG_USER_ID}/media_publish`, { creation_id: creationId });
      const { permalink } = await graph("GET", mediaId, { fields: "permalink" });
      state.published[p.id] = { mediaId, permalink, at: new Date().toISOString() };
      await putJson("schedule/state.json", state); // save right away: a later failure must not cause a re-post
      await removePrefix(`scheduled/${p.id}/`);
      say(`✓ ${p.id} → ${permalink}`);
    } catch (e) {
      failed++;
      say(`✗ ${p.id}: ${e.message}`);
    }
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.map((s) => `- ${s}`).join("\n") + "\n");
  }
  if (failed) process.exit(1); // red run → GitHub emails the owner
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
