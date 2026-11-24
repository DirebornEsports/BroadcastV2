# CLAUDE.md — Direborn Broadcast

> **2.0 copy.** This folder is v1 (repo `DirebornEsports/direborn-broadcast`, commit feb3f5c) copied into BroadcastV2.
> Here it runs **locally inside Direborn Studio** (`node dev/local.mjs`, `PORT=8080`, `LOCAL_ADMIN=1`: no login from this PC),
> nothing auto-deploys, and v1's browser player cams are replaced by the native cams in `../bridge` + `../studio`.
> Phases 0–3 are **barebone**: `public/ui/barebone.css` (loaded by `ui/motion.js`) removes the design and makes every
> animation instant; `dev/local.mjs` blanks decorative art under `/assets` and `/themes`. `?barebone=0` / `BAREBONE=0` turn it off.
> The v1 notes below are still accurate for the code itself; the Cloudflare / auto-deploy parts do not apply here yet.

Broadcast tools for Direborn / Dire Battle Dota 2 streams: draft overlay, GSI, stats, bracket, stat cards, next match, ticker, mix draw, player cams and team cam. Everything runs on **Cloudflare** (Worker + one Durable Object + Realtime SFU). The production PC only runs Dota (DotaTV) + OBS.

- Live: https://direborn-broadcast.direbornmedia.workers.dev
- Repo: `DirebornEsports/direborn-broadcast`. **Every push to `main` auto-deploys** (Cloudflare Workers Builds: `npm run build` → `npx wrangler deploy`). Run the tests before pushing.
- The operator writes in casual Bahasa Indonesia; UI text is Indonesian. Keep that style.

## Commands

```bash
npm run build          # tools/build-manifest.mjs → src/generated (asset manifest + __build stamp). Run after changing public/
npm run dev            # dev/local.mjs: Node server that runs the same Worker + Hub code (copy dev/dev.example.json → dev/dev.json)
npm run lan            # same, for the venue's own network: player cams through a local SFU (dev/localsfu.mjs, werift) that mimics the Cloudflare Realtime calls lib/camcore.mjs makes (env.SFU_URL); https on :8443 for the Kirim Cam pages
npm test               # test/run.mjs: Playwright e2e (mock Realtime SFU + mock OpenDota). Needs playwright + chromium
node test/vfs.test.cjs # small unit test
node test/delaycam.test.cjs # cam delay engine: off-screen keyframe-only decoding
node test/bracket16.test.cjs # 16-team double elimination + byes, checked against the Uprising bracket
```
If Playwright is installed globally, run tests with `NODE_PATH=<global node_modules> node test/run.mjs`. Screenshots land in `test/out/` (gitignored).

## Architecture

- `src/worker.mjs` — routing + auth. Admin pages (`/`, `/control`, `/teams`, `/stats`, `/bracket`, `/cards`, `/camcontrol`, `/lihat`, `/camdebug`, `/mix`) need the operator login (`ADMIN_PASSWORD`). OBS overlays are public read-only. `/api/cam/*` uses PUSH_KEY / VIEW_KEY; `/api/cam/admin` and `/api/cam/kick` need admin.
- `src/hub.js` — the Durable Object **Hub**: all live state, actions (`/api/action` with `{type: ...}`), SSE `/events` to every overlay, GSI, teams, stats, bracket, tournaments. Restarts itself when a request carries a newer `x-dbo-build` (`manifest.__build`), and SSE connections live ≤10 min so overlays pick up new code after a deploy.
- `src/nodeadapter.js`, `src/vfs.js` — let the same Hub run under Node for `npm run dev`.
- `lib/camcore.mjs` — Cloudflare Realtime (Serverless SFU) relay for cams. Note: `sessions/new` must be sent **with no body**. Tracks `cam` + `mic`; kick = `tracks/close force:true` + kicked-session list.
- `public/camrtc.js` — client cam engine: `DelayCam` (encoded-frame history, seeks via keyframes) and `DelayAudio` (encoded Opus keyed by RTP timestamp). Max delay 1020 s (17 min). Horn sync: ① mark at the live horn, ② play at the stream horn. Codec: H.264 by default (GPU encode/decode), VP8 as fallback — `playerCam.codec`, picked in the Player cam panel; senders reconnect within ~15 s.
- `public/kirim.html` — player/team camera sender. Forces a keyframe every 4 s by toggling `scaleResolutionDownBy` 1↔1.01 (`generateKeyFrame` isn't available).
- `public/cam.html` — player cam OBS overlay (silhouette when the player has no cam). **Player cam is excluded from tournament theming.**
- `public/teamcam.html` — team cam OBS overlay (one camera per team, set in the Team cam card). `?full=1` = camera only, full 16:9. Shares delay/sync with player cam; team cameras are not pulled by `/cam`.
- `public/camcontrol.html` — Player cam panel (delay, sync, reset buffer, kick, mic audio, team cam).
- `public/overlay.html` — draft overlay. Pick/ban slot positions come from a per-theme `LAYOUTS` table + `layout()`.
- `public/mix.html` / `mixdraw.html` — mix draw panel / overlay (truly random reveal order).
- `public/teams.html` — teams per tournament; import from Dotabuff league link / ticket, or add by team ID. OpenDota calls are made **from the browser** (server got HTTP 429), with a fallback that builds the team list from league matches.

### Tournaments & themes
- Tournaments live in the Hub (`create`, `switch`, `delete`, `theme`, `rename`). Each has a `theme`, its own teams file (`data/teams.json` for the Cup, `data/teams-<id>.json` for others) and its own `live: {nextMatch, ticker}`.
- Current: **Dire Battle Cup** (`battlecup`), **Direbattle Uprising** (`uprising`), **Direborn Match** (`direborn`, template for tournaments Direborn plays in, e.g. EPL SEA S20, league ticket 20277).
- `public/theme.js` sets `html[data-theme]` + `data-page`, loads `/themes/<theme>.css`, follows `tournamentInfo` live over SSE. `?theme=` in a URL forces one. API: `DBTheme.get/set/onChange`.
- `public/ui/shell.js` — left sidebar on every panel, with the tournament picker.
- Theme CSS: `public/themes/battlecup.css`, `direborn.css` (white/red/gold), `uprising.css` (teal/gold/jade; assets in `public/themes/uprising/`, cut from the designer's split draft files).
- Fonts Teko + Oswald are self-hosted in `public/fonts/` (OFL), so OBS doesn't depend on Google Fonts.

## Secrets (Cloudflare → Worker → Settings → Variables and Secrets, type Secret — runtime, NOT build vars)
`ADMIN_PASSWORD`, `GSI_TOKEN`, `CF_APP_ID`, `CF_APP_SECRET`, `PUSH_KEY`, `VIEW_KEY` (optional TURN keys, optional `YT_API_KEY` = YouTube Data API v3 key for `/chatwalk` live chat characters). Never commit them; locally they go in `dev/dev.json` / `.dev.vars` (gitignored).

## Conventions
- Plain JS (ES modules on the server, inline scripts in pages), no framework, no bundler beyond the manifest step.
- After changing anything in `public/`, run `npm run build` (the manifest/build stamp is what makes the DO + overlays reload).
- Add an e2e check to `test/run.mjs` for new features (pattern: `ok(cond, 'message')`).
- Overlays are 1920×1080, scaled to the browser source.
- Player names: Dreamocel, woMy, PotaT2, db-, dalul — exact spelling.
