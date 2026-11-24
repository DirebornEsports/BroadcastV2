> Catatan: dokumen ini menjelaskan semua fitur overlay. Bagian tentang menjalankan di PC (start.bat, localhost:4747, IP LAN) sudah tidak berlaku — versi ini berjalan online di Cloudflare. Ganti `http://localhost:4747` dengan alamat Worker kamu. Cara setup ada di README.md.

# Dota 2 Draft Overlay (OBS browser source)

Major/TI-style ban-pick bar: 7 bans + 5 portrait picks per team, heroes "pop" into their frames, live PICK/BAN clock and reserve time. Runs locally on your stream PC, no install besides Node.js.

## 1. Run it
1. Install **Node.js 18+** (LTS) from https://nodejs.org
2. Double-click **start.bat** (Windows) or `start.command` (Mac). Keep the window open.
3. Open the control panel: **http://localhost:4747/control**
4. Click **Cache icons + portraits** once, before going live, so hero art is served from your PC instead of Valve's CDN mid-broadcast.

## 2. Add it to OBS
- Sources → **+** → **Browser**
- URL: `http://localhost:4747/overlay`
- Width **1920**, Height **1080**
- Untick "Shutdown source when not visible" so animations don't restart.
- Put it above your game capture. The bar sits at the bottom of the canvas; move/scale it in OBS like any source.

Useful URL options: `?bg=1` (preview background, for checking in a normal browser), `?score=1` (show series score under the logos), `?demo=1` (sample draft, no server needed).

## 3. Running a draft — two modes

### Manual (works with any setup)
Operator follows the draft and clicks heroes. The lime-highlighted step in the sequence strip is what gets filled next.
- Type to search → **Enter** picks the top result. **Esc** clears. **Ctrl+Z** undoes.
- Click a slot to fix a specific slot; right-click a slot to clear it.
- "Auto-restart clock" restarts the countdown on every step (15s first ban phase, 30s otherwise — change in `config.json`). When it hits 0 it burns that team's reserve.
- Set **First pick** correctly in Match setup before game 1 — the order follows Captains Mode (7.34+ order, editable in `config.json` if Valve changes it).

### Auto (GSI) — the draft fills itself from the Dota client
Uses Valve's Game State Integration, which shares the draft when the client is **spectating/observing** the lobby.
1. On the observer PC, copy `gsi/gamestate_integration_draftoverlay.cfg` into
   `...\steamapps\common\dota 2 beta\game\dota\cfg\gamestate_integration\` (create the folder if missing).
2. If the overlay server runs on a *different* PC (e.g. observer PC → operator PC), change `127.0.0.1` in that file to the operator PC's LAN IP (start.bat prints it) and allow port 4747 through Windows Firewall when asked.
3. Steam → Dota 2 → Properties → Launch options: add `-gamestateintegration`. Restart Dota.
4. In the control panel switch to **Auto (GSI)**. The pill turns green ("GSI: live") once data arrives.
5. Set **Radiant is on** (Left/Right) so the right team lands on the right side. Switch back to Manual anytime to correct something.

The token in the .cfg must match `gsi.token` in `config.json` (default `direbattle`).

## Teams database
Open **http://localhost:4747/teams** (or **Teams database** in the control panel header).
- Each team: name, tag, color, **logo uploaded from your PC** (click or drag & drop).
- Each player row: **NAME | STEAM ID | ROLE | PICTURE**. Up to 5 starters + 2 stand-ins (**+ Add stand-in**).
  - **Steam ID** accepts a Steam64 ID (7656…) or a Dota friend ID. A player with two accounts: separate them with a comma.
  - **Picture**: click or drop a cut-out PNG. It appears in the middle of the pick card when that player picks a hero.
- **Captain** dropdown under the players (gold name plate with a C badge on the overlay).
- **Import roster .xlsx** (Saved teams panel): reads a sheet with columns TEAM | POSITION | ROLE | NAME | NICKNAME | STEAM ID (like *Teams & Rosters* in "Direbattle CUP by Direborn Esports.xlsx") and sets every player's Steam ID, role, captain and real name, adds missing stand-ins and teams, and moves any account that was linked to the wrong player. Your own name spellings are kept. The bundled Direbattle CUP roster is applied automatically once on the first start of this version; a summary shows on the Teams page.
- In the control panel → Match setup → **Load teams**, choose the left and right team. Loading a different team resets that side's score; reloading the same team keeps it.
- Stored in `data/teams.json`, uploaded pictures/logos in `public/logos/uploads/`. **Back up `data/` and `public/logos/`.**

## Tournament stats + hero popup
Open **http://localhost:4747/stats**. On first start it already contains the Direbattle Cup dashboard (16 matches, 41 player accounts).
- **Link players**: the stats use in-game names (e.g. *jungler* = Kaisora, *Blue* = icysnow). Every account has a suggested roster player — NAME (same name), CONFIRMED, or GUESS (worked out from heroes played; please check those). Tick and press **Link selected**: the Steam IDs are stored on your players, so GSI, the in-game card and the popup all recognise them. **Add missing Dire Battle Cup teams** creates any of the 8 teams you don't have yet (with roles and captains).
- **Update from OpenDota** downloads every match (league 19986) for **bans, hero win rates and average K/D/A/GPM**. The dashboard alone only has pick counts. Run it once with internet; it takes ~20 seconds.
- **Upload dashboard .xlsx** imports a newer version of the dashboard (merged by match ID, nothing is lost).
- **Export Excel** downloads everything for the active tournament as one .xlsx: Ringkasan, Pertandingan (every game with duration, kills, first pick, OpenDota link), Tim, Pemain (K/D/A, KDA, GPM/XPM, kill share, last hits, healing, wards, hero damage, heroes, Steam IDs), Hero (pick/ban/win rate, averages, who played it), Bracket (live scores and status) and, when matches have full detail, Detail pemain per game.
- Finished games seen through GSI are added automatically (switch in the control panel). Remove test lobbies with ✕ in the Matches list.
- **Popup**: when a hero is picked, a card slides in on the left above the bar with pick rate, rank, ban rate, win rate, average K/D/A + GPM and who played it. Control panel → **Hero stats popup & GSI automation**: on/off, also on bans, seconds, position, **Show test popup**. Fields without data are simply left out.

### Several tournaments / test matches
Stats page → **Tournament**:
- **+ New tournament** creates an empty tournament and makes it active. The stats page and the hero popup always use the active tournament; switch back any time with **Active tournament**. Teams are shared by all tournaments. The Dire Battle Cup stats can't be deleted.
- **Add match**: paste a match ID or a Dotabuff / OpenDota link and press **Add match**. The PC downloads it from OpenDota (needs internet) with draft, winner and every player's hero and K/D/A. Ticked options also add both teams to the Teams database (name, tag, logo, players with their Steam IDs) and load them into the overlay with Radiant on the left. If 3+ players already belong to a team in your database, that team is reused instead of creating a copy. Brand-new matches can take OpenDota a few minutes; the page says so and asks OpenDota to parse it, so just try again.
- Each tournament is stored as `data/stats-<name>.json`; the list is in `data/tournaments.json`.

## Stats cards (full-screen stat graphics)
18 animated full-screen cards from the Direbattle Cup stats: 6 tournament facts, 6 player spotlights and 6 team profiles.
1. In OBS add a Browser source `http://localhost:4747/statcards` (1920 × 1080), on top of the scenes where you want them. Leave it in the scene; it's invisible until you press a card.
2. Open the **Stats Cards panel**: **http://localhost:4747/cards** (or **Stats cards** in the control panel header). Every card design is shown as a thumbnail, with a live view of what OBS is showing. Click a thumbnail and it animates in on OBS; click it again to take it off, or click another to swap. Keys: → next, ← prev, Esc hide. The same buttons are also in the control panel → **Stats cards (full screen)**. When a card comes in, the frame and corners slide in, then the title plaque, then the panels; bars grow and numbers count up. Press the same button again or **Hide** to animate it out. **Prev / Next** steps through all cards in order. **Auto-hide after** takes it off by itself after 8–30 s.
3. **Open preview** shows the source in a browser tab. `http://localhost:4747/statcards?card=kaisora&bg=1` previews a single card without pressing anything.
4. **Changing text and numbers:** open `data/statcards.json` in Notepad (created on first start from `seed/statcards.json`). Each card is one block. Edit the text or values and save; the next time you show the card it uses the new version (no restart). `**word**` makes a word gold. For bars, `value` sets the length, `display` is the text shown and `color` is `gold`, `green` or `red`. To add a card, copy a block and give it a new `id` and `button` name. If you break the file (a missing comma or quote), the control panel shows a warning and the built-in cards are used.

### Live stat cards (from the statistics database)
Most cards in the Stats Cards panel are **live** (green LIVE tag): they're calculated from the **active tournament** on the Stats page at the moment you show them, so new games (dashboard import, Update from OpenDota, or games the overlay records through GSI) appear the next time a card is shown. The panel refreshes its thumbnails by itself when the stats change.
- **Fakta turnamen · live**: Angka utama, Top fragger, KDA tertinggi, GPM tertinggi, Hero paling dipick, Radiant vs Dire, First vs second pick, Durasi game.
- **Tim · live**: one card per team. Record, kill/death per game, wins per pick order, head-to-head, and the three things the team ranks best at (unbeaten, most kills, fewest deaths, fastest/longest games, fastest win, assists, its key player). The bottom strip shows the team's next match from the bracket, and the top-right pill its bracket position (Upper / Lower / Tersingkir / Juara).
- **Pemain · <team> · live**: one card per player who has played. Stats, heroes played, the three things they rank best at (KDA, kills, GPM, deaths per game, assists, kill share, last hits, healing, wards, hero damage, unbeaten, best in their team), and a chart against their teammates. The player's photo from the Teams page appears in the name plate.
Players are matched to your rosters by Steam ID (a player's accounts are merged into one card); per-game rankings only count players with at least 2 games once enough players have that many. Hero damage needs matches with full detail (Update from OpenDota or GSI); the dashboard doesn't have it.
The earlier hand-written cards are still there, folded away under "· teks manual"; their numbers don't update.

### Bracket & rundown cards
Two animated cards in the **Bracket & rundown** group of the Stats Cards panel:
- **Bracket** (Bagan Turnamen): the full bracket of the active tournament. Columns appear round by round, scores count up, winners light up and the gold lines draw toward the next round. The next match glows with a BERIKUTNYA tag.
- **Rundown** (Jadwal & Hasil): every match by day (Jumat 16 Oktober …) with time, round, teams, score and status (SELESAI / BERIKUTNYA / MENDATANG / LIVE).
**Edit the bracket yourself** at **http://localhost:4747/bracket** (or **Edit bracket** in the Stats Cards panel / control panel): type the teams, scores (+ / −, or quick buttons 2–0, 2–1 …), date, time and BO of every match, tick **Live** for the series being played, and press **Save bracket** (Ctrl+S). The Bracket and Rundown cards follow right away, with a preview at the bottom of the editor. What you type always wins. Two options: **winners and losers move on to their next match automatically** (on: an empty team box shows the team that advanced, in italics), and **fill empty scores from the statistics** (off: when on, a series you haven't scored yet is counted from the games in the stats database).
**Every tournament has its own bracket.** The editor edits the bracket of the active tournament (the **Turnamen** menu at the top switches it, same as on the Stats page). A new tournament starts without one: pick a format and press **Buat bracket**:
- Double elimination · 8 tim (the Dire Battle Cup layout), Double elimination · 4 tim, Single elimination · 8 tim, Single elimination · 4 tim, 1 match (2 teams / showmatch);
- **Bebas**: your own list of matches. Add / delete matches and name the rounds yourself (e.g. Group Stage, Final Day); one column per round on the card.
**Buat ulang dengan format ini** replaces the whole bracket with another format; **Hapus bracket** removes it (not for the Dire Battle Cup). The Bracket and Rundown cards, the Next match overlay, the running text and the Excel export all use the active tournament's bracket. The Dire Battle Cup bracket stays in `data/statcards.json`; other tournaments are saved as `data/bracket-<tournament>.json`.
When you update the overlay, new built-in cards are added to your existing `data/statcards.json` automatically; your own edits stay, and cards you deleted aren't brought back.

## Next match overlay (square countdown or 16:9)
OBS: Browser source **http://localhost:4747/nextmatch** at **1080 × 1080** (square), or **http://localhost:4747/nextmatch-wide** at **1920 × 1080** (16:9 full screen, for a break scene; it also shows the match after it at the bottom). Both follow the same settings. It shows the event, a NEXT MATCH plaque, round + BO, both team logos (from the Teams page, glowing in each team's color; TBD shows a "?"), a big VS with light rays, a flip-clock countdown in minutes : seconds only (2 hours 12 minutes shows as 132 : 08; more digits appear by themselves) and the date and time. The last minute glows; at zero it shows "Segera dimulai", and "Live sekarang" when the series is marked Live in the bracket editor.
Control panel → **Next match overlay**:
- **Auto**: the next unplayed match of the bracket (a match that should have started more than 3 hours ago without a score is skipped). Updates by itself when you save the bracket.
- **Choose match**: pick any bracket match.
- **Custom**: type team A / B (pick from your teams), round, BO, date and time.
- **−5 / +5 min** shifts the countdown when the schedule slips; **Reset** goes back to the bracket time. **Title** changes the plaque text; **Hide / Show** animates it out and in. A live preview sits next to the controls (switch it between Square and 16:9).

## Running text (ticker)
OBS: Browser source **http://localhost:4747/ticker** at **1920 × 1080**, on top of your scenes. It's a scrolling bar at the bottom with a two-part badge (default NEXT | MATCH; it turns red **LIVE | NOW** when the next match is marked live in the bracket editor).
The text loops by itself:
- the next match (logos, round, BO, day, time) with a live countdown "MULAI DALAM 132:08" (minutes : seconds) that keeps ticking while it scrolls;
- the matches after it;
- the latest results with scores;
- your own messages.
Control panel → **Running text**: Hide/Show, badge text, which parts to show, messages (one per line), scroll speed and the height from the bottom of the screen. Match info comes from the Next match settings and the bracket.

## GSI check (control panel)
The **GSI check** box shows live what Dota is sending, with a fix for each problem: nothing received (wrong folder, file saved as .cfg.txt, missing launch option), wrong token, panel still in Manual (one-click **Switch to Auto (GSI)**), only your own player (you must watch/spectate the game: lobby observer, Watch tab or a replay), no draft data, no selected hero, players not matched to a Steam ID, and why the in-game card is or isn't showing. **Download last GSI data** saves what Dota last sent, to share for troubleshooting.
**Anti-snipe delay** (top of the GSI check): Off / 1:00 / 2:00 / 3:00 / 5:00, or any number of seconds. Everything Dota sends is held back that long before it reaches the overlay: draft picks, bans and clocks, players on heroes, the in-game photo, stats popups and sounds. The GSI check itself still shows what arrives live, plus how much is buffered. Set it to the same delay as the game picture on stream (lobby spectator delay / DotaTV delay / OBS stream delay), otherwise the overlay and the game drift apart. Manual clicks in the control panel are not delayed. The setting is remembered after a restart.
If you join a game or replay after the draft, Dota sends no draft; in Auto mode the picks are then filled from the heroes the players are on (bans can't be recovered that way).

## GSI: who picked which hero
After the draft, every player takes one of their team's heroes during strategy time. Dota then reports (to an observer client) each player's hero, and the overlay puts that player's name + picture on the right card automatically — matched by Steam ID, then by name. Unknown players (not in your roster) still show with their in-game name. Turn it off with **Put players on their heroes automatically** in the control panel; the dropdowns under the picks always work as a manual override.
Your GSI `.cfg` needs `"player" "1"` and `"hero" "1"` in the `data` block (the included file has them).

## Player cam (online, delayed, follows the observer)
For co-streaming Direborn matches watched through DotaTV. Each player sends his webcam from the browser on his own PC (Chrome/Edge, page `/kirim` on the cam server — the separate **direborn-cam** project on Vercel + Cloudflare Realtime). The overlay keeps every cam about as long as the DotaTV delay and shows the cam of the player whose hero the observer has selected (matched by Steam ID through the Teams page, else by name). An enemy hero hides the cam.
- OBS: Browser source **http://localhost:4747/cam** (1920 × 1080) above the game capture. Default spot: bottom, left of the hero HUD (x 222, y 924, 232 px wide).
- Panel: **http://localhost:4747/camcontrol** (also *Player cam* in the control panel header): show/hide, Auto / Manual / Off, delay (±0.1 s for calibration), position & size, cam status (connection, delay buffer filling, real delay), server settings and copy-ready links for each player.
- Set the anti-snipe GSI delay to **Off** (DotaTV already delays the GSI data). The panel warns you when it's on.
- Calibrate: ask a player to clap on cam at the 0:00 horn and nudge the delay until the clap lands on the horn.
- A cam that just connected needs one full delay (≈2 min) before it can show: players should start their cam before the draft.

## In-game player card (lower third)
A second OBS source that shows the player the observer is following. **Photo only** (default) shows just the player's picture standing beside the hero portrait; **Photo + name & stats** adds the name plate with team, hero and live K/D/A, GPM, net worth and level. The player is found by Steam ID (Teams page), so the right photo follows every hero the observer selects. In photo-only mode a player without a photo shows nothing.
1. In OBS add a Browser source `http://localhost:4747/ingame` (1920 × 1080) above the game capture.
2. Your GSI file needs `"player" "1"` and `"hero" "1"` in the `data` block (the included .cfg has them). Restart Dota after changing it.
3. Teams page: give each player a **photo** (cut-out PNG works best) and, optionally, their **Dota account ID**.
4. Control panel → **In-game player card**:
   - **Auto (observer)** follows the hero the observer has *selected* (click the portrait or use the hero hotkeys). **Manual** lets you pick a player yourself. **Off** hides it.
   - Use ◀ ▶ ▲ ▼ and Size to sit the card right beside the hero portrait on your HUD (fine steps = 2 px). Saved automatically.
   - **Players Dota is sending** lists all 10 in-game players. ✓ = matched by account ID, ≈ = matched by name. Use **Link to…** on any player to save their account ID to the database, so they're always recognised even after a Steam name change.

Matching order: account ID → exact name → name without a team prefix (`ULAR.NotDrew` matches `NotDrew`). Unmatched players still show with their in-game name and a silhouette.

## 4. Branding
- The bar follows the Direbattle Cup mockup and uses its own artwork (see Bar artwork below). Headings use **Oswald** (condensed, like the mockup), small labels Montserrat — both from Google Fonts; install them on the overlay PC if it may be offline.
- Upload the **event logo** (Dire Battle Cup emblem) in Match setup → Event — it fills the empty pick and ban slots.
- Drop logos (transparent PNG/SVG) into `public/logos/` and enter `/logos/yourfile.png` in Match setup. The event logo also fills empty pick frames.
- Team colors drive the whole panel tint, glow and active-slot pulse.
- `config.json` → `display`:
  - `animatedPortraits`: `true` loops Valve's animated hero renders (default), `false` uses still images.
  - Portraits are framed waist-up automatically: the overlay finds the hero in the render and crops from just above the head to the waist. `portraitWaist` (default 0.58 = head to waist; lower = tighter, higher = more body) and `portraitTop` (headroom) tune it for everyone. Wide creatures always keep at least 70% of their width (`portraitMinWidth`).
  - **Portrait framing tool** (control panel, bottom right): pick a hero, nudge it ◀ ▶ ▲ ▼, zoom in/out, with a live preview. Saved per hero in `data/framing.json` and used in every match. ● re-centres, Reset returns to automatic.
  - Automatic centring finds the hero's body (the tallest column of pixels), so wings, mounts, pets and spirits beside the hero don't pull it off-centre.
  - `heroFraming` in config.json does the same by hand, e.g. `"jakiro": { "waist": 0.9, "top": 0.02, "x": 0.05 }` (`x` nudges left/right).
  - `showScore`: series score (number + diamond pips for the wins needed in the BO format). Update it with the **− / +** buttons next to each team name in the control panel; the overlay animates every new point.
- **Sound effects:** every animation has a short sound: pick, ban, player name, player photo, score, next turn, stats popup, stat cards and the in-game card swap. Turn them on or off, set the volume and test each one in the control panel under **Sound effects**. In OBS tick **Control audio via OBS** on every Browser source (/overlay, /statcards, /ingame). Replace a sound by putting your own .mp3 with the same name in `public/sounds/sfx/` (list in `public/sounds/README.txt`).
- **Empty slot logo:** empty picks and bans show the Direbattle Cup logo (`public/assets/bar/dbc-logo.png`), or the event logo if you upload one in Match setup → Event.
- **Hero name calls:** put one audio file per hero in `public/sounds/heroes/` (e.g. `pudge.mp3`); it plays the moment that hero is picked, while the name pops up on the card. Optional `public/sounds/pick.mp3` and `ban.mp3` replace the pick / ban sound effect. In OBS tick **Control audio via OBS** on the Browser source so the sound reaches the mixer. Details in `public/sounds/README.txt`.
- **Player names:** type each team's 5 players in Match setup → Apply. Under the pick cards on the control board, choose who plays each hero from the dropdown (a player can only be on one hero; picking them again moves them). The overlay shows the player on a gold plate at the bottom of the card with the hero name above. Turn off with `display.showPlayerNames: false`.
- The control panel's warning strip flags problems before they reach the stream: server disconnected, no GSI data in Auto mode, logo files that don't load, overlay hidden, picks without a player.
- Match setup → **Stage** (e.g. GRAND FINAL) is the big title in the center panel.
- **Bar artwork** is the Direbattle asset set in `public/assets/bar/`: `panel-left.png`, `panel-right.png`, `center.png`, `spike.png`, `pick-frame.png`, `ban-frame.png`, `logo-frame-left.png`, `logo-frame-right.png`. The bar is laid out on the 1600 × 900 grid of the mockup and scaled ×1.2 to 1920 × 1080, so every asset sits exactly where it is in the mockup. To update the art, save a new PNG with the same name and size. For sharper output in OBS, export the assets at 2× (same layout) and keep the names; the CSS sizes stay the same, so nothing else changes. The FIRST PICK tag sits above the crest with an arrow pointing to the team that picks first.

## Animated hero portraits (pre-rendered, full frame)
The cards play pre-rendered hero videos from `public/heroes/`. Build them once from Valve's official animated hero renders (the dota2.com animations):
1. Install ffmpeg: open PowerShell and run `winget install Gyan.FFmpeg`.
2. Double-click **build-portraits.bat**. For every hero it downloads the render, finds where the hero is in the frame, crops it to fill the card, bakes in the cloud background and saves `public/heroes/<hero>.webm`. First run takes a while; after that it only builds new heroes.
3. Not happy with one hero's framing? Rebuild just that one tighter or looser:
   `node tools/build-portraits.js jakiro --force --fill 0.8` (lower `--fill` = bigger hero, `--top` = headroom).
4. Your motion grapher can also drop their own files there (`.webm` recommended, `.mp4`/`.png` also work). See `public/heroes/HERO-FILENAMES.txt` for names and size. Their file simply replaces the generated one.

These are plain videos with no transparency, so OBS decodes them cheaply on the GPU, and the cards never show the dark box or tiny hero you get from the live transparent renders.

## Performance (CPU/GPU)
The overlay is built so the GPU does the animation work: everything moves with transform/opacity only, and while nothing is happening the only thing animating is the glow on the active slot. To make sure OBS actually renders it on the GPU:
1. OBS → **Settings → Advanced → Sources** → tick **Enable Browser Source Hardware Acceleration**, then restart OBS.
2. In the Browser source properties, tick **Use custom frame rate** and set **30** (the overlay doesn't need 60).
3. If CPU gets tight, set `animatedPortraits` to `false` in `config.json` (still images).
4. Click **Cache icons + portraits** before the stream so images load from disk.

## Files
- `server.js` — local server (sync, GSI receiver, image cache, stats)
- `lib/xlsx.js`, `lib/stats.js` — dashboard import and hero statistics
- `lib/livecards.js` — live stat cards and live bracket built from the statistics
- `lib/xlsxwrite.js` — Excel export
- `public/stats.html` — tournament stats page
- `public/statcards.html` — full-screen stat cards (OBS source); content in `data/statcards.json`
- `seed/` — Direbattle Cup dashboard data, official roster (Steam IDs), suggested account links (used on first start)
- `lib/roster.js` — official roster sheet import
- `public/overlay.html` — the OBS source
- `public/control.html` — operator panel (open it on a laptop/tablet on the same network via the LAN link)
- `state.json` — auto-saved draft, so a restart doesn't lose anything
