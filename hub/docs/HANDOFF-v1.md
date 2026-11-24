# Direborn Broadcast v1 — write-off note (handoff to Broadcast Software 2.0)

Written 24 Nov 2026, after Direbattle Uprising 1 (20–22 Nov) and before Uprising 2 (11–13 Dec).
v1 stays live and working at https://direborn-broadcast.direbornmedia.workers.dev (repo `DirebornEsports/direborn-broadcast`,
every push to `main` deploys). 2.0 is a rebuild from the ground up; this note is what v1 learned, so 2.0 doesn't relearn it.

---

## 1. What v1 is

One Cloudflare Worker + one Durable Object ("Hub") that holds all live state and pushes it over SSE to every OBS
browser source. Plain JS, no framework, inline scripts per page, ~60 commits.

| Area | Pages | Notes |
|---|---|---|
| Draft | `/overlay`, `/control` | Captains Mode draft: manual or Dota GSI (auto). Pick/ban slots, timers, reserve, first pick, sides |
| In-game | `/ingame`, `/banner`, `/caster`, `/ticker` | Player card from GSI (observer's selected hero), rotating banner, caster name plates, running text |
| Between games | `/nextmatch`, `/countdown`, `/statcards`, `/mixdraw` | Next match + countdown, stat cards (bracket, schedule & results, hero stats), mix-team draw |
| Data | `/teams`, `/stats`, `/bracket`, `/cards` | Teams per tournament (OpenDota import), tournament stats, brackets incl. 16-team double elim |
| Cams | `/kirim`, `/cam`, `/teamcam`, `/camcontrol`, `/lihat`, `/camcheck` | Player + team cams over WebRTC with a 0–17 min anti-sniping delay |
| Fun | `/chatwalk` | YouTube live-chat characters (Hub polls the YouTube Data API, needs `YT_API_KEY`) |
| Offline | `npm run lan` / `start-lan.bat` | Whole thing on one venue PC; cams through a local SFU |

Themes per tournament (`battlecup` dark green, `uprising` teal/gold, `direborn` white/red) via `html[data-theme]` + `public/themes/*.css`.
All overlays are 1920×1080, scaled to the source.

## 2. Architecture worth keeping

- **One state object, pushed whole over SSE.** Every overlay is a pure function of the state. Simple and robust;
  reconnects are trivial (`retry: 1000`, streams end after ~10 min so overlays pick up new code after a deploy).
  Cost: every small change re-sends everything. 2.0: keep the model, but send per-module patches/versions.
- **Actions as `{type, ...}` POSTs, validated server-side** (`src/hub.js` `case '...'`). Clamp every number, whitelist
  every enum. Keep.
- **Public read-only overlays vs. logged-in panels.** OBS sources need no login; keys (`?k=`) only for cam media.
- **Secrets only as runtime secrets** (`ADMIN_PASSWORD`, `GSI_TOKEN`, `CF_APP_ID/SECRET`, `PUSH_KEY`, `VIEW_KEY`,
  optional TURN, `YT_API_KEY`). Locally `dev/.dev.json` (gitignored).
- **Build stamp restarts the Durable Object** (`manifest.__build` vs. `x-dbo-build`): new code reaches the live Hub
  without manual restarts.
- **Same Hub code runs under Node** (`dev/local.mjs` emulates DO storage, R2, assets). That is what made LAN mode cheap.

What hurt: `hub.js` grew to ~2,300 lines and `control.html` to ~1,300; one Durable Object = one global state for every
tournament; tests are thin (3 unit tests + a Playwright e2e that needs installing).

## 3. Player cams — the hardest part, and what we learned

**Design:** sender page (`/kirim`) publishes camera + mic to an SFU. The OBS page (`/cam`) pulls every cam, keeps the
*encoded* frames (WebRTC encoded insertable streams) in a history buffer and decodes them `delay` later with WebCodecs
(`public/camrtc.js`: `DelayCam`, `DelayAudio`). This gives a 15-min delay at ~30 MB per cam instead of GBs of raw video.
Horn sync: mark the horn live, press again when it sounds on stream → that gap is the delay.

Lessons (all paid for in production):
1. **Packet loss → smeared blocks** until the next keyframe, because insertable streams hand you frames *before* the
   browser's reference check. Fix in v1: watch the receiver's PLI/FIR count in `getStats`; when it rises, mark the
   recent frames bad and hold the last good picture until a keyframe. Senders force a keyframe every 4 s
   (toggle `scaleResolutionDownBy` 1↔1.01; `generateKeyFrame` isn't available).
2. **VP8 is CPU-only on both ends.** 720p30 VP8 while the player also runs Dota was unstable; OBS decoding many VP8
   cams was heavy. v1 moved to **H.264 by default** (VP8 fallback, operator switch, auto-fallback when an OBS can't decode).
3. **Browsers decide GPU vs software encoding, you can't force it.** Chrome and Edge both chose OpenH264 (software) on
   the team-cam PC even with "Video Encode: Hardware accelerated". It was still light (~6 ms/frame at 540p).
4. **OBS's browser could not decode H.264 via WebCodecs** (frames arrived, picture stayed 0×0). **vMix's browser
   (V115) could.** Always check the target app with `/camcheck` first.
5. **The receiving PC is the real bottleneck**, not the network: decoding every cam in a browser source next to Dota,
   OBS/vMix and the stream encode. Off-screen cams in v1 decode keyframes only; still ~30% CPU for one 720p cam in vMix.
   2.0 ideas: decode on a separate "cam PC" and send to the stream PC via NDI; or a native app with hardware decoding.
6. **Over the internet, cams go up to Cloudflare and back down even when everyone is in the same room.**
   Cloudflare Realtime: $0.05/GB egress, 1,000 GB/month free (SFU + TURN together). 2 cams at 2K + 10 at 1080p ≈ 61 Mbps
   ≈ 27.5 GB per streaming hour per viewer that pulls all cams.
7. **LAN mode** (`dev/localsfu.mjs`, werift) mimics the few Cloudflare Realtime calls `lib/camcore.mjs` makes, so the same
   relay code runs locally. Needs TWCC feedback (else Chrome never raises the bitrate), the sender's codec order honoured,
   PLI forwarded. Cameras only open on **https** (self-signed on :8443, "Advanced → Proceed" once per PC).
8. A browser that is hidden or a tab in the background throttles timers → heartbeats late (online window is 180 s).

## 4. Overlay performance — rules learned

- **Never loop-animate `box-shadow`, `filter`, `text-shadow`, `background-position`, `left/top`.** They repaint on the CPU
  every frame, and OBS copies every new frame. Loop only `transform` and `opacity`; put glows on a separate layer and
  fade its opacity. (Fixed in v1: `/overlay` pulses, logo glow, Direborn scan, statcards/nextmatch glows.)
- **Valve's animated hero portraits are 1440×1440 VP9 with alpha at 24 fps.** VP9-alpha never decodes on the GPU; ten in
  a full draft took ~50% CPU. v1 serves 480 px copies from `public/heroes-anim/` (`tools/shrink-portraits.mjs`, ffmpeg).
  2.0: ship pre-sized media, or play only the latest pick and freeze the rest.
- Don't rewrite unchanged text on a timer (a 10 Hz clock re-laid out the overlay 10×/s).
- anime.js v4 (`public/ui/motion.js`) takes over every CSS animation via `anime.waapi` with identical keyframes.
  Gotcha: anime's composition calls `commitStyles()` when replacing an animation, leaving inline styles that beat
  class rules (a hidden overlay stayed visible) — neutralised by overriding `commitStyles`. In 2.0, pick one animation
  system on purpose rather than translating CSS at runtime.

## 5. Dota GSI — gotchas

- Spectator GSI gives all 10 players (`player.team2/team3`, `hero.team2/team3`) and the `draft` block; a player's own
  client gives only themselves.
- Pick→player assignment must be cleared when a slot empties or changes hero, or the next game shows last game's
  player on a fresh pick (fixed in v1 in `applyGsi`).
- Teams and Radiant side can be detected from Steam IDs (3 of 5 players matched) — needs every roster's Steam IDs.
- Anti-snipe delay for GSI is separate from the cam delay; keep them in one place in 2.0.
- In CM the heroes reach players only after the draft (strategy time).

## 6. Things that bit us outside the code

- **Secure cookies + http** on a LAN IP silently drop the login → serve https or use localhost.
- Windows: `import(path)` with a `C:\` path fails — use `pathToFileURL`. `.bat` files need CRLF.
- OpenDota rate-limits the Worker (HTTP 429) → v1 calls OpenDota from the browser.
- YouTube Data API: ~5 units per live-chat poll, 10k/day → poll every 12 s ≈ 6 h of chat per day.
- Data in LAN mode is separate from the online data (teams, stats, brackets); there is no sync/export yet.

## 7. Recommendations for 2.0

1. **Decide the cam path first**, it drives everything else: browser-based (WebRTC + WebCodecs, as v1) vs. native
   (NDI / SRT / a small desktop app with hardware decode). Requirement that rules out most off-the-shelf tools:
   **a 15-minute delay** with horn sync.
2. **Local-first with cloud as option** (v1 ended up there): one server process on the venue PC, the same code on
   Cloudflare for remote shows, data sync between them.
3. **Modules with their own state slices and versions** (draft, in-game, cams, bracket, stats, chat) instead of one
   object; typed actions; tests per module.
4. **A performance budget per overlay**, checked in CI: count of running animations, only transform/opacity loops,
   media sizes.
5. **Design system for themes** (tokens per tournament) instead of three hand-written CSS overrides per page.
6. Keep what operators liked: one panel with tabs, Indonesian UI, Copy-URL buttons, `/camcheck`, horn sync, status table.

## 8. Where things are in v1

| Path | What |
|---|---|
| `src/worker.mjs` | routing, login, page access, static assets |
| `src/hub.js` | the Durable Object: state, actions, SSE, GSI, teams, stats, bracket, tournaments, YouTube chat |
| `lib/camcore.mjs` | cam relay (Cloudflare Realtime or local SFU via `env.SFU_URL`) |
| `public/camrtc.js` | browser cam engine: publish/pull, `DelayCam`, `DelayAudio`, loss handling, codecs |
| `dev/local.mjs`, `dev/localsfu.mjs` | Node emulator + LAN mode |
| `tools/build-manifest.mjs`, `tools/shrink-portraits.mjs` | build stamp, small hero videos |
| `test/*.cjs`, `test/run.mjs` | unit tests (vfs, delay cam, 16-team bracket), Playwright e2e |
| `CLAUDE.md` | conventions for agents working on v1 |
