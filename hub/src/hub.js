'use strict';
/*
 * Direborn broadcast — the server that used to run on the stream PC (server.js), now inside one
 * Cloudflare Durable Object. Files live in the Durable Object's storage through a small virtual fs
 * (src/vfs.js), uploads in R2, and requests arrive through a Node-style req/res adapter (src/nodeadapter.js),
 * so the logic below is the same code that was tested locally.
 *
 *   /overlay   -> OBS browser source (1920x1080, transparent)
 *   /control   -> operator panel
 *   /gsi       -> Dota 2 Game State Integration endpoint (auto draft)
 */
const path = require('path');
const { readXlsx } = require('../lib/xlsx');
const ST = require('../lib/stats');
const { parseRosterBook } = require('../lib/roster');
const LC = require('../lib/livecards');
const { writeXlsx } = require('../lib/xlsxwrite');

module.exports = function createHub(platform) {
const fs = platform.fs;
const fsp = fs.promises;
const ROOT = '/app';
const PUBLIC_DIR = path.join(ROOT, 'public');
const CACHE_DIR = path.join(ROOT, 'cache');
const IMG_DIR = path.join(CACHE_DIR, 'img');
const HEROES_FILE = path.join(CACHE_DIR, 'heroes.json');
const STATE_FILE = path.join(ROOT, 'state.json');
const TEAMS_FILE = path.join(ROOT, 'data', 'teams.json');      // team database
const UPLOAD_DIR = path.join(ROOT, 'public', 'logos', 'uploads');
const FRAMING_FILE = path.join(ROOT, 'data', 'framing.json');   // per-hero portrait nudges made in the control panel
const TOURNAMENTS_FILE = path.join(ROOT, 'data', 'tournaments.json');   // list of tournaments + which one is active
const DEFAULT_STATS = 'stats.json';                                     // Dire Battle Cup statistics (seeded on first start)
const SEED_DIR = path.join(ROOT, 'seed');
const ROSTER_SYNC_FILE = path.join(ROOT, 'data', 'roster-sync.json');
const STATCARDS_FILE = path.join(ROOT, 'data', 'statcards.json');  // full-screen stat cards (edit freely)
const MAX_PLAYERS = 7;                                           // 5 starters + stand-ins
const ROLES = ['carry', 'mid', 'offlane', 'soft', 'hard', 'standin', 'coach'];
let framingDb = readJSON(FRAMING_FILE, {});
if (!framingDb || typeof framingDb !== 'object' || Array.isArray(framingDb)) framingDb = {};

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

const config = readJSON(path.join(ROOT, 'config.json'), {});
if (platform.env && platform.env.GSI_TOKEN) config.gsi = { ...(config.gsi || {}), token: platform.env.GSI_TOKEN };   // secret in Cloudflare overrides config.json
const CDN = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/';
const BAN_COUNT = 7;
const PICK_COUNT = 5;
const SIDES = ['left', 'right'];
const other = (s) => (s === 'left' ? 'right' : 'left');


/* ------------------------------------------------------------------ */
/* Captains Mode sequence (7.34+). F = first-pick team, S = second.    */
/* ------------------------------------------------------------------ */
const DEFAULT_SEQUENCE =
  'F:ban F:ban S:ban S:ban F:ban S:ban S:ban F:pick S:pick F:ban F:ban S:ban S:pick ' +
  'F:pick F:pick S:pick S:pick F:pick F:ban S:ban S:ban F:ban F:pick S:pick';

function parseSequence(str) {
  const counters = {};
  const firstPickStep = { v: Infinity };
  const seq = String(str).trim().split(/\s+/).map((tok, step) => {
    const [who, type] = tok.split(':');
    if (!['F', 'S'].includes(who) || !['ban', 'pick'].includes(type)) {
      throw new Error(`Bad sequence token "${tok}" (use F:ban, S:pick, ...)`);
    }
    const key = who + type;
    counters[key] = (counters[key] ?? -1) + 1;
    if (type === 'pick') firstPickStep.v = Math.min(firstPickStep.v, step);
    return { who, type, index: counters[key], step };
  });
  for (const s of seq) {
    const max = s.type === 'ban' ? BAN_COUNT : PICK_COUNT;
    if (s.index >= max) throw new Error(`Sequence has more than ${max} ${s.type}s for one team`);
    s.firstPhase = s.type === 'ban' && s.step < firstPickStep.v;
  }
  return seq;
}
const SEQ = parseSequence(config.sequence || DEFAULT_SEQUENCE);

/* ------------------------------------------------------------------ */
/* Heroes                                                              */
/* ------------------------------------------------------------------ */
// Fallback list (id:slug:name). The live list is refreshed from OpenDota on start,
// so heroes added after this file was written still show up.
const FALLBACK = `1:antimage:Anti-Mage|2:axe:Axe|3:bane:Bane|4:bloodseeker:Bloodseeker|5:crystal_maiden:Crystal Maiden|6:drow_ranger:Drow Ranger|7:earthshaker:Earthshaker|8:juggernaut:Juggernaut|9:mirana:Mirana|10:morphling:Morphling|11:nevermore:Shadow Fiend|12:phantom_lancer:Phantom Lancer|13:puck:Puck|14:pudge:Pudge|15:razor:Razor|16:sand_king:Sand King|17:storm_spirit:Storm Spirit|18:sven:Sven|19:tiny:Tiny|20:vengefulspirit:Vengeful Spirit|21:windrunner:Windranger|22:zuus:Zeus|23:kunkka:Kunkka|25:lina:Lina|26:lion:Lion|27:shadow_shaman:Shadow Shaman|28:slardar:Slardar|29:tidehunter:Tidehunter|30:witch_doctor:Witch Doctor|31:lich:Lich|32:riki:Riki|33:enigma:Enigma|34:tinker:Tinker|35:sniper:Sniper|36:necrolyte:Necrophos|37:warlock:Warlock|38:beastmaster:Beastmaster|39:queenofpain:Queen of Pain|40:venomancer:Venomancer|41:faceless_void:Faceless Void|42:skeleton_king:Wraith King|43:death_prophet:Death Prophet|44:phantom_assassin:Phantom Assassin|45:pugna:Pugna|46:templar_assassin:Templar Assassin|47:viper:Viper|48:luna:Luna|49:dragon_knight:Dragon Knight|50:dazzle:Dazzle|51:rattletrap:Clockwerk|52:leshrac:Leshrac|53:furion:Nature's Prophet|54:life_stealer:Lifestealer|55:dark_seer:Dark Seer|56:clinkz:Clinkz|57:omniknight:Omniknight|58:enchantress:Enchantress|59:huskar:Huskar|60:night_stalker:Night Stalker|61:broodmother:Broodmother|62:bounty_hunter:Bounty Hunter|63:weaver:Weaver|64:jakiro:Jakiro|65:batrider:Batrider|66:chen:Chen|67:spectre:Spectre|68:ancient_apparition:Ancient Apparition|69:doom_bringer:Doom|70:ursa:Ursa|71:spirit_breaker:Spirit Breaker|72:gyrocopter:Gyrocopter|73:alchemist:Alchemist|74:invoker:Invoker|75:silencer:Silencer|76:obsidian_destroyer:Outworld Destroyer|77:lycan:Lycan|78:brewmaster:Brewmaster|79:shadow_demon:Shadow Demon|80:lone_druid:Lone Druid|81:chaos_knight:Chaos Knight|82:meepo:Meepo|83:treant:Treant Protector|84:ogre_magi:Ogre Magi|85:undying:Undying|86:rubick:Rubick|87:disruptor:Disruptor|88:nyx_assassin:Nyx Assassin|89:naga_siren:Naga Siren|90:keeper_of_the_light:Keeper of the Light|91:wisp:Io|92:visage:Visage|93:slark:Slark|94:medusa:Medusa|95:troll_warlord:Troll Warlord|96:centaur:Centaur Warrunner|97:magnataur:Magnus|98:shredder:Timbersaw|99:bristleback:Bristleback|100:tusk:Tusk|101:skywrath_mage:Skywrath Mage|102:abaddon:Abaddon|103:elder_titan:Elder Titan|104:legion_commander:Legion Commander|105:techies:Techies|106:ember_spirit:Ember Spirit|107:earth_spirit:Earth Spirit|108:abyssal_underlord:Underlord|109:terrorblade:Terrorblade|110:phoenix:Phoenix|111:oracle:Oracle|112:winter_wyvern:Winter Wyvern|113:arc_warden:Arc Warden|114:monkey_king:Monkey King|119:dark_willow:Dark Willow|120:pangolier:Pangolier|121:grimstroke:Grimstroke|123:hoodwink:Hoodwink|126:void_spirit:Void Spirit|128:snapfire:Snapfire|129:mars:Mars|131:ringmaster:Ringmaster|135:dawnbreaker:Dawnbreaker|136:marci:Marci|137:primal_beast:Primal Beast|138:muerta:Muerta|145:kez:Kez|155:largo:Largo`
  .split('|').map((r) => { const [id, slug, name] = r.split(':'); return { id: +id, slug, name, attr: '' }; });

let heroes = readJSON(HEROES_FILE, null) || FALLBACK;
let heroById = new Map();
let heroBySlug = new Map();
function indexHeroes() {
  heroes.sort((a, b) => a.name.localeCompare(b.name));
  heroById = new Map(heroes.map((h) => [h.id, h]));
  heroBySlug = new Map(heroes.map((h) => [h.slug, h]));
}
indexHeroes();

async function refreshHeroes() {
  try {
    const r = await fetch('https://api.opendota.com/api/heroes', { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const list = (await r.json())
      .filter((h) => h && h.id && h.name)
      .map((h) => ({
        id: h.id,
        slug: String(h.name).replace('npc_dota_hero_', ''),
        name: h.localized_name || h.name,
        attr: h.primary_attr || '',
      }));
    if (list.length > 100) {
      heroes = list;
      indexHeroes();
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(HEROES_FILE, JSON.stringify(heroes));
      console.log(`  Hero list updated from OpenDota (${heroes.length} heroes)`);
    }
  } catch (e) {
    console.log(`  Could not refresh hero list (${e.message}) — using ${heroes.length} cached heroes`);
  }
}

/* ------------------------------------------------------------------ */
/* Team database (data/teams.json)                                     */
/* ------------------------------------------------------------------ */
let teamDb = readJSON(TEAMS_FILE, []);
if (!Array.isArray(teamDb)) teamDb = [];
const capIndex = (v) => (v !== null && v !== '' && v !== undefined && Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) < MAX_PLAYERS ? Number(v) : null);
const arrN = (a, fn) => Array.from({ length: MAX_PLAYERS }, (_, i) => fn((a || [])[i]));
function cleanTeam(t, id) {
  return {
    id,
    name: String(t.name || '').trim().slice(0, 60) || 'TEAM',
    tag: String(t.tag || '').trim().slice(0, 8),
    color: /^#[0-9a-f]{6}$/i.test(t.color || '') ? t.color : '#d6bd86',
    logo: String(t.logo || '').slice(0, 300),
    players: arrN(t.players, (v) => String(v || '').trim().slice(0, 40)),
    roles: arrN(t.roles, (v) => (ROLES.includes(v) ? v : '')),
    captain: capIndex(t.captain),
    photos: arrN(t.photos, (v) => String(v || '').slice(0, 300)),
    accountIds: arrN(t.accountIds, (v) => ST.idsOf(v).join(',')),          // several accounts allowed: "123,456"
    realNames: arrN(t.realNames, (v) => String(v || '').trim().slice(0, 80)),
  };
}
teamDb = teamDb.map((t) => cleanTeam(t, t.id));
// each tournament has its own teams & players (Dire Battle Cup keeps data/teams.json, others data/teams-<id>.json)
let toursReady = false;                         // until the tournaments are loaded (start-up), the Cup file
const teamsFile = (t) => (!t || t.file === DEFAULT_STATS ? TEAMS_FILE : path.join(ROOT, 'data', 'teams-' + t.id + '.json'));
function loadTeamDb() {
  const d = readJSON(teamsFile(toursReady ? activeTournament() : null), []);
  return (Array.isArray(d) ? d : []).map((t) => cleanTeam(t, t.id));
}
function saveTeamDb() {
  const file = teamsFile(toursReady ? activeTournament() : null);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(teamDb, null, 1));
  statsCache = null; statsVersion++;          // roster names feed the stats popup
}
// one Dota account belongs to one roster player; a player may have several accounts
function linkAccount(acc, t, index) {
  for (const x of teamDb) x.accountIds = x.accountIds.map((v) => ST.idsOf(v).filter((a) => a !== acc).join(','));
  t.accountIds[index] = [...new Set([...ST.idsOf(t.accountIds[index]), acc])].join(',');
}
function rosterByAccount(acc) {
  if (!acc) return null;
  for (const t of teamDb) { const i = t.accountIds.findIndex((a) => ST.idsOf(a).includes(acc)); if (i >= 0) return { team: t, index: i }; }
  return null;
}
// copy a database team onto a side of the live overlay
function loadTeamToSide(side, t, keepScore) {
  const cur = state.teams[side];
  state.teams[side] = { name: t.name, tag: t.tag, logo: t.logo, color: t.color, players: [...t.players], roles: [...(t.roles || [])], captain: t.captain ?? null, photos: [...(t.photos || [])], accountIds: [...(t.accountIds || [])], score: keepScore ? cur.score : 0, dbId: t.id };
  if (!keepScore) state.pickPlayers[side] = [null, null, null, null, null];
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */
const emptySlots = () => ({ bans: Array(BAN_COUNT).fill(null), picks: Array(PICK_COUNT).fill(null) });
const emptyRoster = () => ['', '', '', '', ''];
const emptyAssign = () => [null, null, null, null, null];
function teamFrom(t = {}, name, color) {
  const players = arrN(t.players, (v) => String(v || ''));
  return { name: t.name || name, tag: t.tag || '', logo: t.logo || '', color: t.color || color, score: Number(t.score) || 0, players, captain: capIndex(t.captain) };
}
function freshState() {
  const reserve = Number(config.reserveSeconds) || 130;
  return {
    mode: 'manual',
    visible: true,
    event: { title: '', stage: '', logo: '', format: 'BO3', ...(config.event || {}) },
    teams: {
      left: teamFrom(config.teams?.left, 'TEAM A', '#ff2d87'),
      right: teamFrom(config.teams?.right, 'TEAM B', '#3d5afe'),
    },
    firstPick: 'left',
    radiantSide: 'left',
    slots: { left: emptySlots(), right: emptySlots() },
    pickPlayers: { left: emptyAssign(), right: emptyAssign() },   // roster index playing each pick
    active: null,
    step: 0,
    timer: { running: false, endsAt: 0, remaining: 0 },
    reserve: { left: reserve, right: reserve },
    autoTimer: true,
    ingameCard: { mode: 'auto', manual: null, x: 300, y: 0, scale: 1, style: 'photo' },   // style: 'photo' = picture only, 'full' = picture + name + stats
    statPopup: { enabled: true, onBan: false, x: 24, y: 132, seconds: 7 },
    statCard: { id: null, at: 0, autoHide: 0 },          // full-screen stat card on /statcards
    sfx: { enabled: true, volume: 0.6, test: null },     // animation sound effects on every OBS source
    gsiDelay: 0,                  // seconds every GSI message is held back (anti match-sniping)
    // /nextmatch overlay: auto = next unplayed match of the bracket, match = a chosen bracket match, custom = typed in
    // /ticker running text: next match + countdown, following matches, recent results and your own messages
    // /cam overlay: player cams from the online relay (Cloudflare), delayed and switched with the observer's hero
    playerCam: { visible: true, mode: 'auto', manual: '', codec: 'h264', url: '', viewKey: '', pushKey: '', team: '', delay: 120, minHold: 1.5, noCam: 'silhouette', noCamV: 2, x: 293, y: 871, w: 254, aspect: '16:9', frame: 2, showName: true, audio: true, master: 1, mics: {}, syncAt: null, lastSync: null, v: 0,
      // /teamcam overlay: one camera filming a whole team (sent from /kirim like a player cam), its own OBS source; uses the same delay
      teamCam: { visible: true, show: 'off', left: '', right: '', x: 1392, y: 96, w: 480, showName: true } },
    ticker: { visible: true, label1: 'Next', label2: 'Match', showNext: true, showUpcoming: true, showResults: true, messages: ['Dire Battle Cup — untuk regenerasi Dota 2 Indonesia', 'Follow @direbornesports untuk update turnamen'], speed: 110, bottom: 40, v: 0 },
    nextMatch: { visible: true, mode: 'auto', matchId: null, custom: { a: '', b: '', round: '', date: '', time: '', bo: 3 }, delayMin: 0, title: 'Next Match', v: 0 },
    // /countdown overlay ("starting soon" scene): time left until the stream goes live (endsAt 0 = no countdown) + next match VS
    countdown: { endsAt: 0, label: 'Live dalam', visible: true, v: 0 },
    // /banner overlay (in-game): a small title bar whose lines take turns, placed in 1920 x 1080 screen pixels
    banner: { visible: true, messages: ['DIREBATTLE UPRISING - GRAND FINALS'], seconds: 6, x: 0, y: 0, w: 430, v: 0 },
    // /caster overlay: one name per caster cam frame, text only, fitted to the frame's name plate (1920 x 1080 px);
    // every few seconds the name rolls out and back in, letter by letter
    caster: { visible: true, seconds: 6, slots: [
      { name: 'Veenomon', x: 160, y: 990, w: 400, h: 50 }, { name: 'Deko', x: 760, y: 990, w: 400, h: 50 }, { name: 'Aville', x: 1360, y: 990, w: 400, h: 50 }], v: 0 },
    // /chatwalk overlay: a little character walks around for each YouTube live chatter (polled by the Hub, key YT_API_KEY)
    chat: { visible: true, on: false, video: '', max: 12, ground: 785, status: '', v: 0 },
    // /mixdraw overlay: mix players (outside tournaments) drawn into two teams, one of each position per team
    mix: { players: [], left: 'TEAM KIRI', right: 'TEAM KANAN', title: 'MIX DRAW', speed: 'slow', sound: true, visible: true, draw: null, v: 0 },
    autoAssignPlayers: true,      // GSI: put each player on the hero they took
    autoTeams: true,              // GSI: load the two teams from the players' Steam IDs and put Radiant on the right side
    recordStats: true,            // GSI: save finished games into the stats database
    history: [],
  };
}

function normalize(s) {
  const base = freshState();
  const out = { ...base, ...s };
  out.event = { ...base.event, ...(s.event || {}) };
  out.teams = { left: { ...base.teams.left, ...(s.teams?.left || {}) }, right: { ...base.teams.right, ...(s.teams?.right || {}) } };
  out.slots = {};
  for (const side of SIDES) {
    const sl = s.slots?.[side] || {};
    out.slots[side] = {
      bans: Array.from({ length: BAN_COUNT }, (_, i) => sl.bans?.[i] ?? null),
      picks: Array.from({ length: PICK_COUNT }, (_, i) => sl.picks?.[i] ?? null),
    };
  }
  out.reserve = { ...base.reserve, ...(s.reserve || {}) };
  for (const side of SIDES) {
    out.teams[side].players = arrN(out.teams[side].players, (v) => String(v || ''));
  }
  out.ingameCard = { ...base.ingameCard, ...(s.ingameCard || {}) };
  out.statPopup = { ...base.statPopup, ...(s.statPopup || {}) };
  out.sfx = { ...base.sfx, ...(s.sfx || {}), test: null };
  out.ticker = { ...base.ticker, ...(s.ticker || {}) };
  out.playerCam = { ...base.playerCam, ...(s.playerCam || {}) };
  out.playerCam.teamCam = { ...base.playerCam.teamCam, ...((s.playerCam && s.playerCam.teamCam) || {}) };
  // new frame artwork: move a cam still on the old default spot to where the artwork sits
  if (out.playerCam.frame !== 2) { const p = out.playerCam; if (p.x === 222 && p.y === 924 && p.w === 232) { p.x = 293; p.y = 871; p.w = 254; } p.frame = 2; }
  if (out.playerCam.noCamV !== 2) { if (out.playerCam.noCam === 'hide') out.playerCam.noCam = 'silhouette'; out.playerCam.noCamV = 2; }   // Nov 2026: silhouette for players without a cam
  out.chat = { ...base.chat, ...(s.chat || {}), status: '' };
  out.mix = { ...base.mix, ...(s.mix || {}) };
  if (!Array.isArray(out.mix.players) || !out.mix.players.length) out.mix.players = mixSeed();
  out.nextMatch = { ...base.nextMatch, ...(s.nextMatch || {}), custom: { ...base.nextMatch.custom, ...((s.nextMatch || {}).custom || {}) } };
  if (!Array.isArray(out.caster && out.caster.slots)) out.caster = { ...base.caster, visible: out.caster ? out.caster.visible !== false : true };   // older saves had one rotating name banner
  out.statCard = { ...base.statCard, autoHide: Number(s.statCard?.autoHide) || 0, id: null, at: 0 };   // never comes back on its own after a restart
  out.pickPlayers = {};
  for (const side of SIDES) out.pickPlayers[side] = Array.from({ length: PICK_COUNT }, (_, i) => {
    const v = s.pickPlayers?.[side]?.[i];
    if (Number.isInteger(v)) return v;
    if (v && typeof v === 'object' && v.name) return { name: String(v.name).slice(0, 40), accountId: String(v.accountId || '') };
    return null;
  });
  out.timer = { ...base.timer, ...(s.timer || {}) };
  if (!Array.isArray(out.history)) out.history = [];
  return out;
}

let state = normalize(readJSON(STATE_FILE, {}));
let gsiLastAt = 0;
let precache = { running: false, done: 0, total: 0, failed: 0 };

const sideOfWho = (who) => (who === 'F' ? state.firstPick : other(state.firstPick));
const slotArr = (side, type) => state.slots[side][type === 'ban' ? 'bans' : 'picks'];
const usedHeroIds = () => SIDES.flatMap((s) => [...state.slots[s].bans, ...state.slots[s].picks]).filter(Boolean);

function recomputeStep() {
  if (state.mode !== 'manual') return;
  for (const s of SEQ) {
    const side = sideOfWho(s.who);
    if (slotArr(side, s.type)[s.index] == null) {
      state.step = s.step;
      state.active = { side, type: s.type, index: s.index };
      return;
    }
  }
  state.step = SEQ.length;
  state.active = null;
}

function stepDuration() {
  const s = SEQ[state.step];
  if (!s) return 0;
  const t = config.timers || {};
  return s.firstPhase ? Number(t.firstBanPhase ?? 15) : Number(t.default ?? 30);
}

function startTimer(sec) {
  sec = Math.max(0, Number(sec) || 0);
  state.timer = { running: true, endsAt: Date.now() + sec * 1000, remaining: sec };
}
function stopTimer(remaining = 0) {
  state.timer = { running: false, endsAt: 0, remaining };
}
// When the main clock has run out, the overflow is taken from the active team's reserve.
function commitOvertime() {
  const t = state.timer;
  if (!t.running || !state.active) return;
  const over = (Date.now() - t.endsAt) / 1000;
  if (over > 0) {
    const side = state.active.side;
    state.reserve[side] = Math.max(0, Math.round((state.reserve[side] - over) * 10) / 10);
  }
}

function validTarget(t) {
  return t && SIDES.includes(t.side) && ['ban', 'pick'].includes(t.type) &&
    Number.isInteger(t.index) && t.index >= 0 && t.index < (t.type === 'ban' ? BAN_COUNT : PICK_COUNT);
}
const sameSlot = (a, b) => a && b && a.side === b.side && a.type === b.type && a.index === b.index;

class UserError extends Error {}

let statCardTimer = null;
function loadStatCards() {
  const seed = readJSON(path.join(SEED_DIR, 'statcards.json'), {}) || {};
  if (!fs.existsSync(STATCARDS_FILE)) {
    try { fs.mkdirSync(path.dirname(STATCARDS_FILE), { recursive: true }); fs.copyFileSync(path.join(SEED_DIR, 'statcards.json'), STATCARDS_FILE); } catch {}
  }
  let d = readJSON(STATCARDS_FILE, null);
  if (d && Array.isArray(d.cards)) {
    // new built-in cards from an update are added once; cards you deleted yourself stay deleted
    const offered = new Set(Array.isArray(d.seeded) ? d.seeded : d.cards.map((c) => c.id));
    const have = new Set(d.cards.map((c) => c.id));
    let dirty = !Array.isArray(d.seeded);
    (seed.cards || []).forEach((c, i) => {
      if (have.has(c.id) || offered.has(c.id)) return;
      d.cards.splice(Math.min(i, d.cards.length), 0, c); dirty = true;
    });
    d.groups = Array.isArray(d.groups) ? d.groups : [];
    for (const g of seed.groups || []) if (!d.groups.some((x) => x.id === g.id)) { d.groups.splice(seed.groups.indexOf(g), 0, g); dirty = true; }
    if (!d.bracket && seed.bracket) { d.bracket = seed.bracket; dirty = true; }
    d.seeded = [...new Set([...offered, ...(seed.cards || []).map((c) => c.id)])];
    if (!d.cleared) {                                  // Nov 2026: start the stat cards empty (only the bracket stays)
      d.cards = d.cards.filter((c) => c.group === 'bracket'); d.groups = d.groups.filter((g) => g.id === 'bracket'); d.cleared = 1; dirty = true;
    }
    if (dirty) { try { fs.writeFileSync(STATCARDS_FILE, JSON.stringify(d, null, 2)); } catch {} }
  }
  d = d || seed;
  return { event: d.event || 'Direbattle Cup', groups: Array.isArray(d.groups) ? d.groups : [], cards: Array.isArray(d.cards) ? d.cards.filter((c) => c && c.id) : [], bracket: d.bracket || null };
}

// ---- bracket per tournament: Dire Battle Cup keeps it in data/statcards.json, others in data/bracket-<id>.json ----
const BF = require('../public/bracket-formats');
const isDefaultT = (t = activeTournament()) => t.file === DEFAULT_STATS;
const bracketFile = (t = activeTournament()) => path.join(ROOT, 'data', 'bracket-' + t.id + '.json');
function rawBracket(t = activeTournament()) {
  const b = isDefaultT(t) ? loadStatCards().bracket : readJSON(bracketFile(t), null);
  return b && Array.isArray(b.matches) ? b : null;
}
function writeBracket(clean, t = activeTournament()) {
  if (isDefaultT(t)) {
    const file = readJSON(STATCARDS_FILE, null);
    if (!file || !Array.isArray(file.cards)) throw new UserError('data/statcards.json could not be read — fix it first (missing comma or quote?)');
    if (clean) file.bracket = clean; else delete file.bracket;
    fs.writeFileSync(STATCARDS_FILE, JSON.stringify(file, null, 2));
  } else if (clean) {
    fs.mkdirSync(path.dirname(bracketFile(t)), { recursive: true });
    fs.writeFileSync(bracketFile(t), JSON.stringify(clean, null, 2));
  } else { try { fs.unlinkSync(bracketFile(t)); } catch {} }
}
// the active tournament's bracket, filled in from the statistics (null when it has none)
function liveBracketNow() {
  const raw = rawBracket();
  if (!raw) return null;
  try { return LC.liveBracket({ bracket: raw, db: statsDb, teamDb, liveTeams: gameOnAir() ? [state.teams.left.name, state.teams.right.name] : null }) || raw; }
  catch (e) { console.error('  Live bracket failed:', e); return raw; }
}
const eventName = () => (isDefaultT() ? loadStatCards().event || 'Direbattle Cup' : activeTournament().name);

// ---- Excel export of the active tournament ----
function statsWorkbook() {
  const d = allStatCards();                                   // includes the live bracket
  const heroName = (id) => heroById.get(Number(id))?.name || '#' + id;
  const live = LC.buildLiveCards({ db: statsDb, teamDb, heroName, heroStats: heroStats(), rosterByAccount, bracket: d.bracket, tournament: activeTournament().name });
  const { players, teams } = live.tables;
  const hs = heroStats();
  const wib = (ts) => (ts ? new Date(ts + 7 * 3600000).toISOString().slice(0, 16).replace('T', ' ') : '');
  const ms = Object.values(statsDb.matches).sort((a, b) => (a.endedTs || 0) - (b.endedTs || 0));
  const done = ms.filter((m) => m.winner);
  const kills = (m, s) => (m.kills && m.kills[s] != null ? m.kills[s] : m.players ? m.players.filter((p) => p.side === s).reduce((a, p) => a + (p.kills || 0), 0) : null);
  const totalKills = done.reduce((a, m) => a + (kills(m, 'radiant') || 0) + (kills(m, 'dire') || 0), 0);
  const durs = done.filter((m) => m.duration);
  const fp = done.filter((m) => m.firstPick);
  const sheets = [];
  sheets.push({ name: 'Ringkasan', filter: false, columns: [{ header: 'Item', width: 34 }, { header: 'Nilai', type: 'auto', width: 46 }], rows: [
    ['Turnamen', activeTournament().name], ['Diekspor (WIB)', wib(Date.now())], ['Game', done.length], ['Tim', teams.length], ['Pemain', players.length],
    ['Total kill', totalKills], ['Rata-rata kill per game', done.length ? Math.round(totalKills / done.length * 10) / 10 : null],
    ['Rata-rata durasi', durs.length ? (() => { const s = Math.round(durs.reduce((a, m) => a + m.duration, 0) / durs.length); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); })() : ''],
    ['Radiant menang', done.length ? `${done.filter((m) => m.winner === 'radiant').length} dari ${done.length}` : ''],
    ['First pick menang', fp.length ? `${fp.filter((m) => m.firstPick === m.winner).length} dari ${fp.length}` : ''],
    ['Game dengan draft', ms.filter((m) => m.picksBans && m.picksBans.length).length], ['Game dengan detail pemain', ms.filter((m) => m.players && m.players.length).length],
    ['Sumber', (statsDb.imports.length ? 'dashboard .xlsx, ' : '') + 'OpenDota / GSI'] ] });
  sheets.push({ name: 'Pertandingan', columns: [
    { header: 'Match ID', width: 13 }, { header: 'Selesai (WIB)', width: 17 }, { header: 'Durasi', type: 'duration', width: 10 }, { header: 'Radiant', width: 18 }, { header: 'Dire', width: 18 },
    { header: 'Pemenang', width: 18 }, { header: 'Kill Radiant', type: 'int', width: 11 }, { header: 'Kill Dire', type: 'int', width: 10 }, { header: 'First pick', width: 18 },
    { header: 'Draft', width: 7 }, { header: 'Detail pemain', width: 13 }, { header: 'Sumber', width: 18 }, { header: 'OpenDota', width: 42 }],
    rows: ms.map((m) => [m.matchId, wib(m.endedTs), m.duration || null, m.radiant.name, m.dire.name, m.winner ? m[m.winner].name : '', kills(m, 'radiant'), kills(m, 'dire'),
      m.firstPick ? m[m.firstPick].name : '', m.picksBans && m.picksBans.length ? 'Ya' : 'Tidak', m.players && m.players.length ? 'Ya' : 'Tidak', (m.sources || []).join(', '),
      /^\d+$/.test(m.matchId) ? 'https://www.opendota.com/matches/' + m.matchId : '']) });
  const wg = (w, g) => (g ? `${w} dari ${g}` : '');
  sheets.push({ name: 'Tim', columns: [
    { header: 'Tim', width: 20 }, { header: 'Game', type: 'int', width: 7 }, { header: 'Menang', type: 'int', width: 8 }, { header: 'Kalah', type: 'int', width: 7 }, { header: 'Win rate', type: 'pct', width: 9 },
    { header: 'Total kill', type: 'int', width: 10 }, { header: 'Kill / game', type: 'dec1', width: 11 }, { header: 'Death / game', type: 'dec1', width: 12 }, { header: 'Assist / game', type: 'dec1', width: 12 },
    { header: 'Rata-rata durasi', type: 'duration', width: 15 }, { header: 'First pick menang', width: 16 }, { header: 'Second pick menang', width: 18 }, { header: 'Radiant menang', width: 15 }, { header: 'Dire menang', width: 12 },
    { header: 'Head-to-head', width: 46 }],
    rows: teams.slice().sort((a, b) => b.wr - a.wr || b.wins - a.wins).map((t) => [t.name, t.games, t.wins, t.losses, t.wr, t.kills, t.kpg, t.dpg, t.apg, t.avgDur ? Math.round(t.avgDur) : null,
      wg(t.fpW, t.fpG), wg(t.spW, t.spG), wg(t.radW, t.radG), wg(t.direW, t.direG), [...t.h2h.values()].map((h) => `${h.name} ${h.w}-${h.l}`).join(', ')]) });
  sheets.push({ name: 'Pemain', columns: [
    { header: 'Pemain', width: 18 }, { header: 'Tim', width: 18 }, { header: 'Steam ID (Dota)', width: 22 }, { header: 'Game', type: 'int', width: 7 }, { header: 'Menang', type: 'int', width: 8 },
    { header: 'Win rate', type: 'pct', width: 9 }, { header: 'Kill', type: 'int', width: 6 }, { header: 'Death', type: 'int', width: 7 }, { header: 'Assist', type: 'int', width: 7 },
    { header: 'KDA', type: 'dec2', width: 7 }, { header: 'Avg GPM', type: 'int', width: 9 }, { header: 'Avg XPM', type: 'int', width: 9 }, { header: 'Porsi kill tim', type: 'pct', width: 13 },
    { header: 'Last hit', type: 'thousands', width: 9 }, { header: 'Healing', type: 'thousands', width: 10 }, { header: 'Ward', type: 'int', width: 7 }, { header: 'Hero damage', type: 'thousands', width: 12 },
    { header: 'Hero', width: 60 }],
    rows: players.slice().sort((a, b) => a.team.localeCompare(b.team) || b.kills - a.kills).map((p) => [p.name, p.team, [...p.accounts].join(', '), p.games, p.wins, p.wins / p.games,
      p.kills, p.deaths, p.assists, Math.round(p.kda * 100) / 100, Math.round(p.gpm), Math.round(p.xpm), p.share, p.lastHits || null, p.healing || null, p.wards || null,
      p.hasDmg ? p.dmg : null, p.heroList.map((h) => (h.n > 1 ? `${h.name} ×${h.n}` : h.name)).join(', ')]) });
  const H = Object.entries(hs.heroes || {}).filter(([, x]) => x.picks || x.bans).sort((a, b) => b[1].picks - a[1].picks || b[1].bans - a[1].bans);
  sheets.push({ name: 'Hero', columns: [
    { header: 'Hero', width: 20 }, { header: 'Pick', type: 'int', width: 6 }, { header: 'Ban', type: 'int', width: 6 }, { header: 'Pick rate', type: 'pct', width: 10 }, { header: 'Ban rate', type: 'pct', width: 10 },
    { header: 'Menang', type: 'int', width: 8 }, { header: 'Win rate', type: 'pct', width: 9 }, { header: 'Avg kill', type: 'dec1', width: 9 }, { header: 'Avg death', type: 'dec1', width: 10 },
    { header: 'Avg assist', type: 'dec1', width: 10 }, { header: 'Avg GPM', type: 'int', width: 9 }, { header: 'Dimainkan oleh', width: 50 }],
    rows: H.map(([id, x]) => [heroName(id), x.picks, x.bans || 0, x.picks / (x.pickBase || hs.matches || 1), x.banBase ? x.bans / x.banBase : null,
      x.winBase ? x.wins : null, x.winBase ? x.wins / x.winBase : null, x.avg ? x.avg.kills : null, x.avg ? x.avg.deaths : null, x.avg ? x.avg.assists : null, x.avg ? Math.round(x.avg.gpm) : null,
      (x.players || []).map((p) => `${p.name} ×${p.games}`).join(', ')]) });
  if (d.bracket && Array.isArray(d.bracket.matches)) {
    sheets.push({ name: 'Bracket', columns: [
      { header: 'Match', type: 'int', width: 7 }, { header: 'Round', width: 20 }, { header: 'Tanggal', width: 9 }, { header: 'Jam (WIB)', width: 10 }, { header: 'BO', type: 'int', width: 5 },
      { header: 'Tim A', width: 18 }, { header: 'Skor A', type: 'int', width: 8 }, { header: 'Skor B', type: 'int', width: 8 }, { header: 'Tim B', width: 18 }, { header: 'Status', width: 11 }, { header: 'Skor dari', width: 16 }],
      rows: d.bracket.matches.map((m) => [m.id, m.round, m.date || 'TBA', m.time || '', m.bo || 3, m.a.name || 'TBD', m.a.score ?? null, m.b.score ?? null, m.b.name || 'TBD',
        m.winnerSide ? 'Selesai' : m.live ? 'Live' : 'Mendatang', m.fromStats ? `statistik (${m.fromStats} game)` : m.a.score != null ? 'diisi manual' : '']) });
  }
  const det = ms.filter((m) => m.players && m.players.length);
  if (det.length) sheets.push({ name: 'Detail pemain per game', columns: [
    { header: 'Match ID', width: 13 }, { header: 'Selesai (WIB)', width: 17 }, { header: 'Pemain', width: 18 }, { header: 'Steam ID (Dota)', width: 14 }, { header: 'Tim', width: 18 }, { header: 'Hero', width: 18 },
    { header: 'Menang', width: 8 }, { header: 'Kill', type: 'int', width: 6 }, { header: 'Death', type: 'int', width: 7 }, { header: 'Assist', type: 'int', width: 7 }, { header: 'GPM', type: 'int', width: 7 },
    { header: 'XPM', type: 'int', width: 7 }, { header: 'Last hit', type: 'int', width: 9 }, { header: 'Hero damage', type: 'thousands', width: 12 }, { header: 'Net worth', type: 'thousands', width: 11 }],
    rows: det.flatMap((m) => m.players.map((x) => { const r = rosterByAccount(x.accountId);
      return [m.matchId, wib(m.endedTs), r ? r.team.players[r.index] : x.name, x.accountId, m[x.side]?.name, heroName(x.heroId), m.winner ? (m.winner === x.side ? 'Ya' : 'Tidak') : '',
        x.kills, x.deaths, x.assists, x.gpm, x.xpm, x.lastHits, x.heroDamage || null, x.netWorth || null]; })) });
  return writeXlsx(sheets);
}

// ---- next match for the /nextmatch overlay ----
const DAYS_ID = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const MONTHS_ID = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
function resolveNextMatch() {
  const nm = state.nextMatch;
  const br = liveBracketNow() || { matches: [] };
  const year = Number(br.year) || new Date().getFullYear(), tz = br.timezone || 'WIB';
  const when = (date, time) => {                         // dd/mm + hh.mm in WIB -> epoch ms
    const [dd, mm] = String(date || '').split('/').map(Number), t = String(time || '').match(/(\d{1,2})[.:](\d{2})/);
    if (!dd || !mm) return { day: null, ts: null };
    return { day: Date.UTC(year, mm - 1, dd), ts: t ? Date.UTC(year, mm - 1, dd, Number(t[1]) - 7, Number(t[2])) : null };
  };
  let m = null;
  if (nm.mode === 'custom') m = { id: null, round: nm.custom.round, bo: nm.custom.bo, date: nm.custom.date, time: nm.custom.time, a: { name: nm.custom.a || 'TBD' }, b: { name: nm.custom.b || 'TBD' } };
  else if (nm.mode === 'match') m = (br.matches || []).find((x) => x.id === nm.matchId) || null;
  else {
    // unplayed matches; one that should have started more than 3 hours ago without a score is skipped (score not entered yet)
    let open = (br.matches || []).filter((x) => !x.winnerSide).map((x) => ({ x, t: when(x.date, x.time) }));
    const fresh = open.filter((o) => o.x.live || o.t.ts == null || o.t.ts > Date.now() - 3 * 3600000);
    if (fresh.length) open = fresh;
    open.sort((p, q) => (p.t.ts ?? p.t.day ?? 9e15) - (q.t.ts ?? q.t.day ?? 9e15) || p.x.id - q.x.id);
    m = open.length ? open[0].x : null;
  }
  const team = (name) => {
    const tbd = !name || /^tbd$/i.test(String(name).trim());
    const t = tbd ? null : teamDb.find((x) => ST.normKey(x.name) === ST.normKey(name)) || teamDb.find((x) => ST.teamKeyMatch(x.name, name));
    return { name: tbd ? 'TBD' : t ? t.name : name, tag: t ? t.tag : '', logo: t ? t.logo : '', color: t ? t.color : '', tbd };
  };
  const base = { title: nm.title || 'Next Match', visible: nm.visible, mode: nm.mode, delayMin: nm.delayMin || 0, serverNow: Date.now(), event: eventName(), tz,
    choices: (br.matches || []).map((x) => ({ id: x.id, label: `M${x.id} · ${x.round} · ${x.a?.name || 'TBD'} vs ${x.b?.name || 'TBD'}${x.winnerSide ? ' (selesai)' : ''}` })) };
  const all = (br.matches || []).map((x) => ({ x, t: when(x.date, x.time) }));
  const label = (x, t) => ({ id: x.id, round: x.round || '', bo: Number(x.bo) || 3, time: x.time || '', dayTxt: t.day != null ? (() => { const dt = new Date(t.day); return `${DAYS_ID[dt.getUTCDay()]} · ${dt.getUTCDate()} ${MONTHS_ID[dt.getUTCMonth()]}`; })() : '',
    startTs: t.ts, live: !!x.live, a: team(x.a?.name), b: team(x.b?.name), score: [x.a?.score ?? null, x.b?.score ?? null], winner: x.winnerSide || null });
  base.upcoming = all.filter((o) => !o.x.winnerSide && (!m || o.x.id !== m.id)).sort((p, q) => (p.t.ts ?? 9e15) - (q.t.ts ?? 9e15) || p.x.id - q.x.id).slice(0, 3).map((o) => label(o.x, o.t));
  base.recent = all.filter((o) => o.x.winnerSide).sort((p, q) => (q.t.ts ?? 0) - (p.t.ts ?? 0) || q.x.id - p.x.id).slice(0, 4).map((o) => label(o.x, o.t));
  if (!m) return { ...base, none: true };
  const w = when(m.date, m.time);
  const dayTxt = w.day != null ? (() => { const dt = new Date(w.day); return `${DAYS_ID[dt.getUTCDay()]} · ${dt.getUTCDate()} ${MONTHS_ID[dt.getUTCMonth()]}`; })() : '';
  return { ...base, matchId: m.id, round: m.round || '', bo: Number(m.bo) || 3, date: m.date || '', time: m.time || '', dayTxt,
    startTs: w.ts != null ? w.ts + (nm.delayMin || 0) * 60000 : null, live: !!m.live, done: !!m.winnerSide,
    score: m.a?.score != null || m.b?.score != null ? [m.a?.score ?? 0, m.b?.score ?? 0] : null, a: team(m.a?.name), b: team(m.b?.name) };
}

// a game is being drafted or played right now (GSI in the last minute)
const gameOnAir = () => Date.now() - gsiLastAt < 60000 && /HERO_SELECTION|STRATEGY|SHOWCASE|PRE_GAME|GAME_IN_PROGRESS|WAIT_FOR_MAP/.test(gsiDiag.gameState || '');

// hand-written cards (data/statcards.json) + live cards computed from the active tournament's statistics
// the cards panel loads many thumbnails at once: build the live cards once per change, not per request
let scMemo = { key: '', at: 0, val: null };
function allStatCards() {
  const key = [statsVersion, tournaments.active, gameOnAir(), state.teams.left.name, state.teams.right.name].join('|');
  if (scMemo.val && scMemo.key === key && Date.now() - scMemo.at < 60000) return JSON.parse(scMemo.json);
  const d = buildStatCards();
  scMemo = { key, at: Date.now(), val: true, json: JSON.stringify(d) };
  return d;
}
function buildStatCards() {
  const d = loadStatCards();
  // each tournament has its own bracket; it fills itself from the games in the statistics (and marks the series on air as live)
  d.bracket = liveBracketNow();
  d.event = eventName();
  let live = { groups: [], cards: [] };
  try {
    live = LC.buildLiveCards({ db: statsDb, teamDb, heroName: (id) => heroById.get(id)?.name || '#' + id, heroStats: heroStats(), rosterByAccount,
      bracket: d.bracket, tournament: d.event });
  } catch (e) { console.error('  Live stat cards failed:', e); d.liveError = e.message; }
  const isBracket = (g) => g === 'bracket';
  if (!d.bracket) { d.groups = d.groups.filter((g) => !isBracket(g.id)); d.cards = d.cards.filter((c) => !isBracket(c.group)); }   // no bracket made for this tournament yet
  d.groups = [...d.groups.filter((g) => isBracket(g.id)), ...live.groups, ...d.groups.filter((g) => !isBracket(g.id)).map((g) => ({ ...g, label: g.label + ' · teks manual' }))];
  d.cards = [...d.cards.filter((c) => isBracket(c.group)), ...live.cards, ...d.cards.filter((c) => !isBracket(c.group))];
  return d;
}

/* ---- mix draw ---- */
const MIX_POS = { 1: 'Carry', 2: 'Mid', 3: 'Offlane', 4: 'Soft Support', 5: 'Hard Support' };
function mixId() { return Math.random().toString(36).slice(2, 10); }
function mixSeed() {
  const list = [[2, 'IYD'], [2, 'MIKOTO'], [3, 'OURA'], [3, 'AVILLE'], [1, 'RUSMAN'], [1, 'Varizh'], [4, 'Rine'], [4, 'Nafari'], [5, 'Mada'], [5, 'Kelly']];
  return list.map(([pos, name]) => ({ id: mixId(), name, pos, active: true, photo: '' }));
}
function rnd(n) { const a = new Uint32Array(1); globalThis.crypto.getRandomValues(a); return a[0] % n; }
function shuffle(arr) { const x = [...arr]; for (let i = x.length - 1; i > 0; i--) { const j = rnd(i + 1); [x[i], x[j]] = [x[j], x[i]]; } return x; }
// every position goes to both teams (one each, random who gets whom); extra players fill the smaller team
function mixDraw(m) {
  const pool = m.players.filter((p) => p.active !== false && String(p.name).trim());
  const picks = [], extra = [], size = { left: 0, right: 0 };
  for (const pos of [1, 2, 3, 4, 5]) {
    const list = shuffle(pool.filter((p) => p.pos === pos));
    if (list.length < 2) throw new UserError(`Posisi ${pos} (${MIX_POS[pos]}) butuh minimal 2 pemain aktif — sekarang ${list.length}`);
    picks.push({ side: 'left', pos, id: list[0].id }, { side: 'right', pos, id: list[1].id });
    extra.push(...list.slice(2));
  }
  size.left = size.right = 5;
  for (const p of shuffle(extra)) {
    const side = size.left === size.right ? (rnd(2) ? 'left' : 'right') : size.left < size.right ? 'left' : 'right';
    size[side]++; picks.push({ side, pos: p.pos, id: p.id });
  }
  return {
    id: mixId(), at: Date.now() + 1200, seed: rnd(2 ** 31), speed: m.speed, all: false,
    left: m.left, right: m.right, title: m.title,
    players: pool.map((p) => ({ id: p.id, name: p.name, pos: p.pos, photo: p.photo || '' })),      // frozen for this draw
    picks: shuffle(picks),                                                                          // reveal order: fully random (any team, any position)
  };
}

function act(a) {
  switch (a.type) {
    case 'mix': {
      const m = state.mix, str = (v, k) => String(v ?? '').trim().slice(0, k);
      const posOf = (v) => { const n = Number(v); if (![1, 2, 3, 4, 5].includes(n)) throw new UserError('Posisi harus 1–5'); return n; };
      const find = (id) => { const p = m.players.find((x) => x.id === id); if (!p) throw new UserError('Pemain tidak ditemukan'); return p; };
      switch (a.op) {
        case 'add': {
          const name = str(a.name, 24); if (!name) throw new UserError('Nama pemain kosong');
          if (m.players.some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new UserError(name + ' sudah ada');
          if (m.players.length >= 60) throw new UserError('Maksimal 60 pemain');
          m.players.push({ id: mixId(), name, pos: posOf(a.pos), active: true, photo: str(a.photo, 300) });
          break;
        }
        case 'update': {
          const p = find(a.id);
          if (a.name !== undefined) { const n = str(a.name, 24); if (!n) throw new UserError('Nama pemain kosong'); p.name = n; }
          if (a.pos !== undefined) p.pos = posOf(a.pos);
          if (a.active !== undefined) p.active = !!a.active;
          if (a.photo !== undefined) p.photo = str(a.photo, 300);
          break;
        }
        case 'remove': m.players = m.players.filter((x) => x.id !== a.id); break;
        case 'settings':
          if (a.left !== undefined) m.left = str(a.left, 30) || 'TEAM KIRI';
          if (a.right !== undefined) m.right = str(a.right, 30) || 'TEAM KANAN';
          if (a.title !== undefined) m.title = str(a.title, 40);
          if (a.speed !== undefined) { if (!['slow', 'normal', 'fast'].includes(a.speed)) throw new UserError('Bad speed'); m.speed = a.speed; }
          if (a.sound !== undefined) m.sound = !!a.sound;
          if (a.visible !== undefined) m.visible = !!a.visible;
          if (m.draw) { m.draw.left = m.left; m.draw.right = m.right; m.draw.title = m.title; }
          break;
        case 'draw': m.draw = mixDraw(m); m.visible = true; break;
        case 'revealAll': if (m.draw) m.draw.all = true; break;
        case 'reset': m.draw = null; break;
        case 'toDraft': {
          // the drawn teams become the two teams of the draft overlay (players in position order)
          const d = m.draw; if (!d) throw new UserError('Belum ada hasil mix');
          for (const side of SIDES) {
            const ps = d.picks.filter((x) => x.side === side).sort((x, y) => x.pos - y.pos).map((x) => d.players.find((p) => p.id === x.id)).filter(Boolean);
            const t = state.teams[side];
            state.teams[side] = { ...t, name: d[side], tag: '', logo: '', players: arrN(ps.map((p) => p.name), (v) => String(v || '')), photos: arrN(ps.map((p) => p.photo), (v) => String(v || '')), captain: null, accountIds: [], score: 0 };
            delete state.teams[side].dbId;
            state.pickPlayers[side] = [null, null, null, null, null];
          }
          break;
        }
        default: throw new UserError('Bad mix op');
      }
      m.v = (m.v || 0) + 1;
      break;
    }
    case 'assign': {
      if (state.mode !== 'manual') throw new UserError('Switch to Manual mode to pick heroes by hand');
      const id = Number(a.heroId);
      if (!heroById.has(id)) throw new UserError('Unknown hero');
      const target = a.target || state.active;
      if (!target) throw new UserError('Draft is complete — click a slot to edit it');
      if (!validTarget(target)) throw new UserError('Bad slot');
      const arr = slotArr(target.side, target.type);
      const prev = arr[target.index];
      if (prev !== id && usedHeroIds().includes(id)) throw new UserError(`${heroById.get(id).name} is already picked/banned`);
      const wasActive = sameSlot(target, state.active);
      if (wasActive) commitOvertime();
      state.history.push({ ...target, prev });
      arr[target.index] = id;
      recomputeStep();
      if (wasActive && state.autoTimer) state.active ? startTimer(stepDuration()) : stopTimer();
      break;
    }
    case 'clear': {
      if (state.mode !== 'manual') throw new UserError('Switch to Manual mode to edit the draft');
      if (!validTarget(a.target)) throw new UserError('Bad slot');
      const arr = slotArr(a.target.side, a.target.type);
      state.history.push({ ...a.target, prev: arr[a.target.index] });
      arr[a.target.index] = null;
      recomputeStep();
      break;
    }
    case 'undo': {
      const h = state.history.pop();
      if (!h) throw new UserError('Nothing to undo');
      slotArr(h.side, h.type)[h.index] = h.prev;
      recomputeStep();
      if (state.autoTimer && state.active) startTimer(stepDuration());
      break;
    }
    case 'reset': {
      state.slots = { left: emptySlots(), right: emptySlots() };
      state.pickPlayers = { left: emptyAssign(), right: emptyAssign() };
      state.history = [];
      const r = Number(config.reserveSeconds) || 130;
      state.reserve = { left: r, right: r };
      stopTimer();
      recomputeStep();
      break;
    }
    case 'teams': {
      for (const side of SIDES) {
        const t = a.teams?.[side];
        if (!t) continue;
        const cur = state.teams[side];
        for (const k of ['name', 'tag', 'logo', 'color']) if (typeof t[k] === 'string') cur[k] = t[k].slice(0, 300);
        if (Array.isArray(t.players)) cur.players = arrN(t.players, (v) => String(v ?? '').slice(0, 40));
        if ('captain' in t) cur.captain = capIndex(t.captain);
        if (t.score !== undefined) cur.score = Math.max(0, Number(t.score) || 0);
      }
      break;
    }
    case 'assignPlayer': {
      // which roster player (0-4, or null) plays the hero in pick slot `index`
      if (!SIDES.includes(a.side) || !Number.isInteger(a.index) || a.index < 0 || a.index >= PICK_COUNT) throw new UserError('Bad slot');
      const v = a.player === null || a.player === '' ? null : Number(a.player);
      if (v !== null && !(Number.isInteger(v) && v >= 0 && v < MAX_PLAYERS)) throw new UserError('Bad player');
      const arr = state.pickPlayers[a.side];
      if (v !== null) arr.forEach((x, i) => { if (x === v) arr[i] = null; });   // one hero per player
      arr[a.index] = v;
      break;
    }
    case 'loadTeam': {
      if (!SIDES.includes(a.side)) throw new UserError('Bad side');
      const t = teamDb.find((x) => x.id === a.teamId);
      if (!t) throw new UserError('Team not found in the database');
      loadTeamToSide(a.side, t, state.teams[a.side].dbId === t.id);   // same team again keeps its score
      break;
    }
    case 'framing': {
      const slug = String(a.slug || '');
      if (!/^[a-z0-9_]+$/.test(slug)) throw new UserError('Bad hero');
      if (a.reset) delete framingDb[slug];
      else {
        const cur = { ...(framingDb[slug] || {}) };
        const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v) * 1000) / 1000));
        if (a.x !== undefined) cur.x = clamp(a.x, -0.6, 0.6);
        if (a.y !== undefined) cur.y = clamp(a.y, -0.6, 0.6);
        if (a.zoom !== undefined) cur.zoom = clamp(a.zoom, 0.5, 3);
        framingDb[slug] = cur;
      }
      fs.mkdirSync(path.dirname(FRAMING_FILE), { recursive: true });
      fs.writeFileSync(FRAMING_FILE, JSON.stringify(framingDb, null, 1));
      break;
    }
    case 'ingameCard': {
      const c = state.ingameCard;
      if (a.mode !== undefined) { if (!['auto', 'manual', 'off'].includes(a.mode)) throw new UserError('Bad mode'); c.mode = a.mode; }
      if (a.manual !== undefined) c.manual = a.manual && SIDES.includes(a.manual.side) && Number.isInteger(a.manual.index) ? { side: a.manual.side, index: a.manual.index } : null;
      if (a.x !== undefined) c.x = Math.round(Math.min(1900, Math.max(-200, Number(a.x) || 0)));
      if (a.y !== undefined) c.y = Math.round(Math.min(1000, Math.max(-100, Number(a.y) || 0)));
      if (a.style !== undefined) c.style = a.style === 'full' ? 'full' : 'photo';
      if (a.scale !== undefined) c.scale = Math.round(Math.min(2.5, Math.max(0.4, Number(a.scale) || 1)) * 100) / 100;
      break;
    }
    case 'linkPlayer': {
      // remember an in-game account ID for a database player, so the card always finds them
      const t = teamDb.find((x) => x.id === a.teamId);
      if (!t || !Number.isInteger(a.index) || a.index < 0 || a.index >= MAX_PLAYERS) throw new UserError('Player not found');
      const acc = ST.toAccountId(a.accountId);
      if (!acc) throw new UserError('No account ID');
      linkAccount(acc, t, a.index);
      saveTeamDb();
      for (const side of SIDES) if (state.teams[side].dbId === t.id) loadTeamToSide(side, t, true);
      break;
    }
    case 'statPopup': {
      const c = state.statPopup;
      if (a.enabled !== undefined) c.enabled = !!a.enabled;
      if (a.onBan !== undefined) c.onBan = !!a.onBan;
      if (a.x !== undefined) c.x = Math.round(Math.min(1700, Math.max(-100, Number(a.x) || 0)));
      if (a.y !== undefined) c.y = Math.round(Math.min(700, Math.max(-300, Number(a.y) || 0)));
      if (a.seconds !== undefined) c.seconds = Math.min(30, Math.max(2, Number(a.seconds) || 7));
      if (a.test) { state.popupTest = { heroId: Number(a.test) || null, side: SIDES.includes(a.side) ? a.side : 'left', at: Date.now() }; }
      break;
    }
    case 'statCard': {
      const c = state.statCard;
      if (a.autoHide !== undefined) c.autoHide = Math.min(120, Math.max(0, Math.round(Number(a.autoHide) || 0)));
      if (a.id !== undefined) {
        const ids = allStatCards().cards.map((x) => x.id);
        if (a.id && !ids.includes(a.id)) throw new UserError('Unknown stat card');
        c.id = a.id || null; c.at = Date.now();
        clearTimeout(statCardTimer);
        if (c.id && c.autoHide) {
          const at = c.at;
          statCardTimer = setTimeout(() => { if (state.statCard.at === at) { state.statCard.id = null; state.statCard.at = Date.now(); changed(); } }, c.autoHide * 1000);
        }
      }
      break;
    }
    case 'playerCam': {
      const c = state.playerCam, str = (v, k) => String(v ?? '').trim().slice(0, k);
      const num = (v, lo, hi, dp = 0) => { const n = Number(v); if (!Number.isFinite(n)) throw new UserError('Bad number'); const f = 10 ** dp; return Math.round(Math.min(hi, Math.max(lo, n)) * f) / f; };
      if (a.visible !== undefined) c.visible = !!a.visible;
      if (a.showName !== undefined) c.showName = !!a.showName;
      if (a.mode !== undefined) { if (!['auto', 'manual', 'off'].includes(a.mode)) throw new UserError('Bad mode'); c.mode = a.mode; }
      if (a.manual !== undefined) c.manual = str(a.manual, 24);
      if (a.url !== undefined) { const u = str(a.url, 200).replace(/\/+$/, ''); if (u && !/^https?:\/\/[^\s]+$/i.test(u)) throw new UserError('URL must start with https://'); c.url = u; }
      if (a.viewKey !== undefined) c.viewKey = str(a.viewKey, 200);
      if (a.pushKey !== undefined) c.pushKey = str(a.pushKey, 200);
      if (a.team !== undefined) c.team = str(a.team, 60);
      if (a.delay !== undefined) c.delay = num(a.delay, 0, 1020, 1);
      if (a.delayBy !== undefined) c.delay = num(c.delay + Number(a.delayBy), 0, 1020, 1);
      // horn sync: mark the horn when it sounds live, then press again when it sounds on the stream -> that gap is the delay
      if (a.sync !== undefined) {
        const t = Number(a.at), at = Number.isFinite(t) && Math.abs(t - Date.now()) < 60000 ? t : Date.now();
        if (a.sync === 'mark') c.syncAt = at;
        else if (a.sync === 'play') {
          if (!c.syncAt) throw new UserError('Tekan "Horn LIVE" dulu');
          const sec = (at - c.syncAt) / 1000;
          if (sec > 1020) { c.syncAt = null; throw new UserError('Lebih dari 17 menit sejak tanda horn — ulangi'); }
          c.delay = num(sec, 0, 1020, 1); c.lastSync = { delay: c.delay, at }; c.syncAt = null;
        } else if (a.sync === 'cancel') c.syncAt = null;
        else throw new UserError('Bad sync');
      }
      // empty the delay buffer in the OBS /cam source (all cams, or one player)
      if (a.resetBuffer !== undefined) c.reset = { seq: ((c.reset && c.reset.seq) || 0) + 1, name: str(a.resetBuffer, 24) };
      if (a.minHold !== undefined) c.minHold = num(a.minHold, 0, 10, 1);
      if (a.noCam !== undefined) { if (!['hide', 'keep', 'silhouette'].includes(a.noCam)) throw new UserError('Bad option'); c.noCam = a.noCam; }
      if (a.codec !== undefined) { if (!['h264', 'vp8'].includes(a.codec)) throw new UserError('Bad codec'); c.codec = a.codec; c.codecNote = ''; }
      if (a.x !== undefined) c.x = num(a.x, -2000, 3840);
      if (a.y !== undefined) c.y = num(a.y, -2000, 2160);
      if (a.w !== undefined) c.w = num(a.w, 120, 1920);
      if (a.aspect !== undefined) { if (!['16:9', '4:3', '1:1'].includes(a.aspect)) throw new UserError('Bad aspect'); c.aspect = a.aspect; }
      // mic audio: master on/off + volume, per player mute + volume
      if (a.audio !== undefined) c.audio = !!a.audio;
      if (a.master !== undefined) c.master = num(a.master, 0, 2, 2);
      if (a.mic && typeof a.mic === 'object') {
        const k = str(a.mic.name, 24).toLowerCase();
        if (!k) throw new UserError('Nama pemain kosong');
        if (!c.mics || typeof c.mics !== 'object') c.mics = {};
        const m = c.mics[k] || (c.mics[k] = { muted: false, vol: 1 });
        if (a.mic.muted !== undefined) m.muted = !!a.mic.muted;
        if (a.mic.vol !== undefined) m.vol = num(a.mic.vol, 0, 2, 2);
        const keys = Object.keys(c.mics); if (keys.length > 40) delete c.mics[keys[0]];
      }
      if (a.muteAll !== undefined) { c.mics = c.mics || {}; for (const n of (Array.isArray(a.names) ? a.names : [])) { const k = str(n, 24).toLowerCase(); if (k) (c.mics[k] = c.mics[k] || { muted: false, vol: 1 }).muted = !!a.muteAll; } }
      if (a.teamCam && typeof a.teamCam === 'object') {
        const t = c.teamCam || (c.teamCam = {}), b = a.teamCam;
        if (b.visible !== undefined) t.visible = !!b.visible;
        if (b.showName !== undefined) t.showName = !!b.showName;
        if (b.show !== undefined) { if (!['off', 'left', 'right'].includes(b.show)) throw new UserError('Bad option'); t.show = b.show; }
        if (b.left !== undefined) t.left = str(b.left, 24);
        if (b.right !== undefined) t.right = str(b.right, 24);
        if (b.x !== undefined) t.x = num(b.x, -2000, 3840);
        if (b.y !== undefined) t.y = num(b.y, -2000, 2160);
        if (b.w !== undefined) t.w = num(b.w, 160, 1920);
      }
      c.v = (c.v || 0) + 1;
      break;
    }
    case 'countdown': {
      const c = state.countdown, now = Date.now(), mins = (v) => { const m = Number(v); if (!Number.isFinite(m) || Math.abs(m) > 600) throw new UserError('Menit harus antara 0 dan 600'); return m; };
      if (a.visible !== undefined) c.visible = !!a.visible;
      if (a.label !== undefined) c.label = String(a.label ?? '').trim().slice(0, 30);
      if (a.minutes !== undefined) { const m = mins(a.minutes); c.endsAt = m > 0 ? now + Math.round(m * 60000) : 0; }
      if (a.add !== undefined) { const end = Math.max(now, c.endsAt || now) + Math.round(mins(a.add) * 60000); c.endsAt = end > now ? end : 0; }
      if (a.stop) c.endsAt = 0;
      c.v = (c.v || 0) + 1;
      break;
    }
    case 'caster': {
      const c = state.caster, num = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
      if (a.visible !== undefined) c.visible = !!a.visible;
      if (a.seconds !== undefined) c.seconds = num(a.seconds, 2, 60);
      if (Array.isArray(a.slots)) c.slots = a.slots.slice(0, 8).map((x) => ({ name: String(x?.name ?? '').trim().slice(0, 30),
        x: num(x?.x, 0, 1900), y: num(x?.y, 0, 1060), w: num(x?.w, 40, 1920), h: num(x?.h, 16, 400) })).filter((x) => x.name);
      c.v = (c.v || 0) + 1;
      break;
    }
    case 'chat': {
      const c = state.chat, num = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
      if (a.visible !== undefined) c.visible = !!a.visible;
      if (a.max !== undefined) c.max = num(a.max, 1, 40);
      if (a.ground !== undefined) c.ground = num(a.ground, 80, 1080);
      if (a.video !== undefined) c.video = ytVideoId(a.video);
      if (a.on !== undefined) { c.on = !!a.on && !!c.video; c.status = c.on ? 'Menyambung…' : ''; chatLoop(); }
      if (a.test) chatPush([{ id: 'tes' + Math.floor(Math.random() * 6), name: 'Penonton ' + (1 + Math.floor(Math.random() * 6)), text: 'Halo Direborn! 🔥' }]);
      c.v = (c.v || 0) + 1;
      break;
    }
    case 'banner': {
      const b = state.banner, num = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
      if (a.visible !== undefined) b.visible = !!a.visible;
      if (Array.isArray(a.messages)) b.messages = a.messages.map((m) => String(m ?? '').trim().slice(0, 80)).filter(Boolean).slice(0, 10);
      if (a.seconds !== undefined) b.seconds = num(a.seconds, 2, 60);
      if (a.x !== undefined) b.x = num(a.x, 0, 1900);
      if (a.y !== undefined) b.y = num(a.y, 0, 1060);
      if (a.w !== undefined) b.w = num(a.w, 160, 1920);
      b.v = (b.v || 0) + 1;
      break;
    }
    case 'ticker': {
      const t = state.ticker, str = (v, k) => String(v ?? '').trim().slice(0, k);
      for (const k of ['visible', 'showNext', 'showUpcoming', 'showResults']) if (a[k] !== undefined) t[k] = !!a[k];
      if (a.label1 !== undefined) t.label1 = str(a.label1, 20);
      if (a.label2 !== undefined) t.label2 = str(a.label2, 20);
      if (Array.isArray(a.messages)) t.messages = a.messages.map((m) => str(m, 200)).filter(Boolean).slice(0, 20);
      if (a.speed !== undefined) t.speed = Math.max(30, Math.min(400, Math.round(Number(a.speed) || 110)));
      if (a.bottom !== undefined) t.bottom = Math.max(0, Math.min(1000, Math.round(Number(a.bottom) || 0)));
      t.v = (t.v || 0) + 1;
      break;
    }
    case 'nextMatch': {
      const n = state.nextMatch, str = (v, k) => String(v ?? '').trim().slice(0, k);
      if (a.visible !== undefined) n.visible = !!a.visible;
      if (a.mode !== undefined) { if (!['auto', 'match', 'custom'].includes(a.mode)) throw new UserError('Bad mode'); n.mode = a.mode; }
      if (a.matchId !== undefined) n.matchId = Number(a.matchId) || null;
      if (a.title !== undefined) n.title = str(a.title, 40);
      if (a.delayMin !== undefined) n.delayMin = Math.max(-600, Math.min(600, Math.round(Number(a.delayMin) || 0)));
      if (a.custom) for (const k of ['a', 'b', 'round', 'date', 'time']) if (a.custom[k] !== undefined) n.custom[k] = str(a.custom[k], 40);
      if (a.custom && a.custom.bo !== undefined) n.custom.bo = [1, 2, 3, 5, 7].includes(Number(a.custom.bo)) ? Number(a.custom.bo) : 3;
      n.v = (n.v || 0) + 1;
      break;
    }
    case 'gsiDelay': {
      const v = Math.round(Math.min(600, Math.max(0, Number(a.seconds) || 0)));
      if (v === 0 && gsiQueue.length) { const last = gsiQueue[gsiQueue.length - 1]; gsiQueue.length = 0; try { processGsi(parseLooseJSON(last.raw)); } catch {} }
      state.gsiDelay = v;
      break;
    }
    case 'sfx': {
      if (a.enabled !== undefined) state.sfx.enabled = !!a.enabled;
      if (a.volume !== undefined) state.sfx.volume = Math.min(1, Math.max(0, Number(a.volume) || 0));
      if (a.test) state.sfx.test = { name: String(a.test).slice(0, 40), at: Date.now() };
      break;
    }
    case 'autoAssign':
      state.autoAssignPlayers = !!a.value;
      break;
    case 'autoTeams':
      state.autoTeams = !!a.value;
      break;
    case 'recordStats':
      state.recordStats = !!a.value;
      break;
    case 'event': {
      for (const k of ['title', 'stage', 'logo', 'format']) if (typeof a.event?.[k] === 'string') state.event[k] = a.event[k].slice(0, 300);
      break;
    }
    case 'firstPick':
      if (!SIDES.includes(a.side)) throw new UserError('Bad side');
      state.firstPick = a.side;
      recomputeStep();
      break;
    case 'radiantSide':
      if (!SIDES.includes(a.side)) throw new UserError('Bad side');
      state.radiantSide = a.side;
      break;
    case 'swap': {
      state.teams = { left: state.teams.right, right: state.teams.left };
      state.slots = { left: state.slots.right, right: state.slots.left };
      state.pickPlayers = { left: state.pickPlayers.right, right: state.pickPlayers.left };
      state.reserve = { left: state.reserve.right, right: state.reserve.left };
      state.firstPick = other(state.firstPick);
      state.radiantSide = other(state.radiantSide);
      state.history = state.history.map((h) => ({ ...h, side: other(h.side) }));
      if (state.active) state.active.side = other(state.active.side);
      recomputeStep();
      break;
    }
    case 'mode':
      if (!['manual', 'gsi'].includes(a.mode)) throw new UserError('Bad mode');
      state.mode = a.mode;
      if (a.mode === 'manual') { stopTimer(); recomputeStep(); }
      break;
    case 'visible':
      state.visible = !!a.visible;
      break;
    case 'autoTimer':
      state.autoTimer = !!a.value;
      break;
    case 'timer': {
      const t = state.timer;
      const left = t.running ? Math.max(0, (t.endsAt - Date.now()) / 1000) : t.remaining;
      if (a.cmd === 'start') startTimer(a.seconds ?? stepDuration());
      else if (a.cmd === 'pause') stopTimer(Math.round(left * 10) / 10);
      else if (a.cmd === 'resume') startTimer(left);
      else if (a.cmd === 'stop') stopTimer();
      else throw new UserError('Bad timer command');
      break;
    }
    case 'reserve':
      for (const side of SIDES) if (a.reserve?.[side] !== undefined) state.reserve[side] = Math.max(0, Number(a.reserve[side]) || 0);
      break;
    case 'precache':
      startPrecache(!!a.anim);
      break;
    default:
      throw new UserError('Unknown action ' + a.type);
  }
  if (state.history.length > 200) state.history = state.history.slice(-200);
  changed();
}

/* ------------------------------------------------------------------ */
/* Dota 2 GSI                                                          */
/* ------------------------------------------------------------------ */
function resolveGsiHero(id, cls) {
  if (Number(id) > 0 && heroById.has(Number(id))) return Number(id);
  if (cls) { const h = heroBySlug.get(String(cls).replace('npc_dota_hero_', '')); if (h) return h.id; }
  return Number(id) > 0 ? Number(id) : null;
}
// ---- what Dota is sending, shown in the control panel's GSI check ----
const GSI_LAST_FILE = path.join(ROOT, 'data', 'gsi-last.json');
const gsiDiag = { count: 0, rejected: 0, lastRejectAt: 0, lastRejectToken: '', provider: '', gameState: '', matchId: '', blocks: [], spectator: false,
  ownPlayer: '', players: 0, selected: null, draftPresent: false, draftPicks: 0, draftBans: 0, heroFallback: false };
let gsiLastSaved = 0;
function noteGsi(body, players) {
  const D = gsiDiag;
  D.count++;
  D.provider = body?.provider?.name ? `${body.provider.name} (${body.provider.appid})` : D.provider;
  D.gameState = String(body?.map?.game_state || '').replace('DOTA_GAMERULES_STATE_', '');
  D.matchId = body?.map?.matchid ? String(body.map.matchid) : '';
  D.blocks = Object.keys(body || {}).filter((k) => !['auth', 'previously', 'added'].includes(k));
  D.spectator = !!players;
  D.ownPlayer = !players && body?.player?.name ? String(body.player.name) : '';
  D.players = players ? players.length : 0;
  const sel = players && players.find((p) => p.selected);
  D.selected = sel ? { name: sel.name, hero: heroById.get(sel.heroId)?.name || '' } : null;
  const d = body?.draft;
  D.draftPresent = !!(d && (d.team2 || d.team3));
  D.draftPicks = 0; D.draftBans = 0;
  if (D.draftPresent) for (const t of [d.team2, d.team3]) for (const [k, v] of Object.entries(t || {})) {
    if (!/_id$/.test(k) || !(Number(v) > 0)) continue;
    if (/^pick\d/.test(k)) D.draftPicks++; else if (/^ban\d/.test(k)) D.draftBans++;
  }
  if (D.draftPicks) D.heroFallback = false;
  if (Date.now() - gsiLastSaved > 3000) {        // keep the latest message so it can be shared for troubleshooting
    gsiLastSaved = Date.now();
    const copy = { ...body }; delete copy.auth;
    fsp.mkdir(path.dirname(GSI_LAST_FILE), { recursive: true }).then(() => fsp.writeFile(GSI_LAST_FILE, JSON.stringify(copy, null, 1))).catch(() => {});
  }
}
// joined after the draft (or Dota sent no draft block): take the picks from the heroes the players are on
function fillPicksFromHeroes(players) {
  let any = false;
  for (const [team, side] of [['radiant', state.radiantSide], ['dire', other(state.radiantSide)]]) {
    const ids = players.filter((p) => p.team === team && p.heroId).sort((a, b) => a.slot - b.slot).map((p) => p.heroId);
    const picks = state.slots[side].picks;
    for (const id of ids) {
      if (picks.includes(id)) continue;
      const i = picks.findIndex((x) => x == null);
      if (i < 0) break;
      picks[i] = id; any = true;
    }
  }
  return any;
}

function applyGsi(body) {
  const d = body && body.draft;
  if (!d || typeof d !== 'object') return false;
  const radiant = state.radiantSide;
  const map = { team2: radiant, team3: other(radiant) };
  const slots = { left: emptySlots(), right: emptySlots() };
  let any = false;
  for (const [key, side] of Object.entries(map)) {
    const t = d[key];
    if (!t) continue;
    any = true;
    const resolve = (id, cls) => {
      if (Number(id) > 0 && heroById.has(Number(id))) return Number(id);
      if (cls) {
        const h = heroBySlug.get(String(cls).replace('npc_dota_hero_', ''));
        if (h) return h.id;
      }
      return Number(id) > 0 ? Number(id) : null;
    };
    for (let i = 0; i < PICK_COUNT; i++) slots[side].picks[i] = resolve(t[`pick${i}_id`], t[`pick${i}_class`]);
    for (let i = 0; i < BAN_COUNT; i++) slots[side].bans[i] = resolve(t[`ban${i}_id`], t[`ban${i}_class`]);
  }
  if (!any) return false;
  // a pick slot that is empty or holds another hero than before (next game) no longer belongs to the player put on it
  for (const side of SIDES) slots[side].picks.forEach((h, i) => { if (h !== state.slots[side].picks[i]) state.pickPlayers[side][i] = null; });
  state.slots = slots;

  const team = Number(d.activeteam);
  if (team === 2 || team === 3) {
    const side = team === 2 ? radiant : other(radiant);
    const type = d.pick ? 'pick' : 'ban';
    const index = slots[side][type === 'pick' ? 'picks' : 'bans'].findIndex((x) => x == null);
    state.active = index >= 0 ? { side, type, index } : null;
    const rem = Number(d.activeteam_time_remaining);
    if (Number.isFinite(rem)) startTimer(rem);
  } else {
    state.active = null;
    stopTimer();
  }
  if (d.radiant_bonus_time !== undefined) state.reserve[radiant] = Number(d.radiant_bonus_time) || 0;
  if (d.dire_bonus_time !== undefined) state.reserve[other(radiant)] = Number(d.dire_bonus_time) || 0;
  return true;
}

/* ------------------------------------------------------------------ */
/* In-game: who is the observer looking at? (GSI player + hero blocks)  */
/* ------------------------------------------------------------------ */
let gsiPlayers = [];      // all 10 players as the observer client sees them
let gsiPlayersAt = 0;
const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';
function parseGsiPlayers(body) {
  const P = body && body.player, Hb = body && body.hero;
  if (!P || typeof P !== 'object' || !(P.team2 || P.team3)) return null;   // only the spectator format lists all players
  const out = [];
  for (const tk of ['team2', 'team3']) {
    const pt = P[tk] || {}, ht = (Hb && Hb[tk]) || {};
    for (const [pk, p] of Object.entries(pt)) {
      if (!p || typeof p !== 'object') continue;
      const h = ht[pk] || {};
      let acc = p.accountid != null ? String(p.accountid).replace(/\D/g, '') : '';
      if (!acc && p.steamid) { try { acc = String(BigInt(String(p.steamid)) - 76561197960265728n); } catch {} }
      const slug = h.name ? String(h.name).replace('npc_dota_hero_', '') : '';
      const hero = (slug && heroBySlug.get(slug)) || (h.id ? heroById.get(Number(h.id)) : null);
      out.push({
        slot: Number(String(pk).replace(/\D/g, '')) || 0, team: tk === 'team2' ? 'radiant' : 'dire',
        name: String(p.name || ''), accountId: acc, heroId: hero ? hero.id : null,
        kills: +p.kills || 0, deaths: +p.deaths || 0, assists: +p.assists || 0,
        gpm: +p.gpm || 0, xpm: +p.xpm || 0, netWorth: +p.net_worth || 0, level: +h.level || 0,
        selected: truthy(h.selected_unit),
      });
    }
  }
  return out.sort((a, b) => a.slot - b.slot);
}
const normName = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
const stripTag = (s) => normName(s).replace(/^[^.]*\./, '');          // "ULAR.NotDrew" -> "notdrew"
function findDbPlayer(gp) {
  const pools = SIDES.map((side) => ({ team: state.teams[side], side })).concat(teamDb.map((team) => ({ team })));
  if (gp.accountId) for (const { team, side } of pools) {
    const i = (team.accountIds || []).findIndex((a) => ST.idsOf(a).includes(gp.accountId));
    if (i >= 0) return { team, side, index: i, how: 'id' };
  }
  for (const { team, side } of pools) {
    const i = (team.players || []).findIndex((n) => n && (normName(n) === normName(gp.name) || stripTag(n) === stripTag(gp.name)));
    if (i >= 0) return { team, side, index: i, how: 'name' };
  }
  return null;
}
function cardData() {
  const c = state.ingameCard;
  if (!c || c.mode === 'off') return null;
  const fresh = Date.now() - gsiPlayersAt < 30000;   // Dota only sends every 10 s when nothing changes (e.g. a paused replay)
  let gp = null, m = null;
  if (c.mode === 'manual') {
    if (!c.manual || !SIDES.includes(c.manual.side)) return null;
    const t = state.teams[c.manual.side];
    if (!t.players[c.manual.index]) return null;
    m = { team: t, side: c.manual.side, index: c.manual.index };
    const accs = ST.idsOf((t.accountIds || [])[c.manual.index]);
    gp = fresh && accs.length ? gsiPlayers.find((p) => accs.includes(p.accountId)) || null : null;
  } else {
    gp = fresh ? gsiPlayers.find((p) => p.selected) : null;
    if (!gp) return null;
    m = findDbPlayer(gp);
  }
  const team = m ? m.team : null;
  return {
    key: m ? `${team.dbId || team.id || team.name}:${m.index}` : `gsi:${gp.accountId || gp.name}`,
    name: m ? team.players[m.index] : gp.name,
    // photo from the Teams database (fresh even if it was uploaded after the team was loaded), matched by Steam ID first
    photo: m ? (((team.dbId && teamDb.find((x) => x.id === team.dbId)) || team).photos?.[m.index] || (team.photos || [])[m.index] || '') : '',
    captain: !!(m && team.captain === m.index),
    teamName: team ? team.name : '', teamTag: team ? team.tag : '', teamLogo: team ? team.logo : '', teamColor: team ? team.color : '#d6bd86',
    heroId: gp ? gp.heroId : null,
    stats: gp ? { kills: gp.kills, deaths: gp.deaths, assists: gp.assists, gpm: gp.gpm, netWorth: gp.netWorth, level: gp.level } : null,
    matched: m ? (m.how || 'manual') : null,
  };
}

// whose cam the /cam overlay should show: the hero the observer has selected (or the one picked by hand)
function camSelection() {
  const c = state.playerCam;
  if (!c || !c.visible || c.mode === 'off') return null;
  if (c.mode === 'manual') return c.manual ? { name: c.manual, how: 'manual' } : null;
  const gp = Date.now() - gsiPlayersAt < 30000 ? gsiPlayers.find((p) => p.selected) : null;
  if (!gp) return null;
  const m = findDbPlayer(gp);
  return { name: m ? m.team.players[m.index] : gp.name, gsiName: gp.name, team: m ? m.team.name : '', tag: m ? m.team.tag || '' : '', heroId: gp.heroId, how: m ? m.how : 'gsi' };
}

/* ------------------------------------------------------------------ */
/* GSI: put each player on the hero they took (after the draft)         */
/* ------------------------------------------------------------------ */
const samePick = (a, b) => a === b || (a && b && typeof a === 'object' && typeof b === 'object' && a.name === b.name && a.accountId === b.accountId);
function autoAssignFromGsi() {
  if (!state.autoAssignPlayers) return false;
  let any = false;
  for (const gp of gsiPlayers) {
    if (!gp.heroId) continue;
    const side = SIDES.find((sd) => state.slots[sd].picks.includes(gp.heroId));
    if (!side) continue;
    const slot = state.slots[side].picks.indexOf(gp.heroId);
    const team = state.teams[side];
    let idx = gp.accountId ? (team.accountIds || []).findIndex((a) => ST.idsOf(a).includes(gp.accountId)) : -1;
    if (idx < 0 && gp.accountId && team.dbId) {          // linked in the database but the on-screen copy is older
      const r = rosterByAccount(gp.accountId);
      if (r && r.team.id === team.dbId) idx = r.index;
    }
    if (idx < 0) idx = (team.players || []).findIndex((n) => n && (ST.normKey(n) === ST.normKey(gp.name) || ST.stripTagKey(n) === ST.stripTagKey(gp.name)));
    const val = idx >= 0 ? idx : (gp.name ? { name: gp.name, accountId: gp.accountId } : null);
    if (val == null) continue;
    const arr = state.pickPlayers[side];
    if (samePick(arr[slot], val)) continue;
    if (Number.isInteger(val)) arr.forEach((x, i) => { if (x === val) arr[i] = null; });
    arr[slot] = val;
    any = true;
  }
  return any;
}

// which database team plays Radiant / Dire: most of its players found by Steam ID (or name); 3 of 5 needed
function detectGsiTeams() {
  const out = {};
  for (const team of ['radiant', 'dire']) {
    const votes = new Map();
    for (const gp of gsiPlayers) {
      if (gp.team !== team) continue;
      const t = (gp.accountId && rosterByAccount(gp.accountId)?.team)
        || teamDb.find((x) => (x.players || []).some((n) => n && (ST.normKey(n) === ST.normKey(gp.name) || ST.stripTagKey(n) === ST.stripTagKey(gp.name))));
      if (t) votes.set(t, (votes.get(t) || 0) + 1);
    }
    const best = [...votes].sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= 3) out[team] = best[0];
  }
  return out;
}
function autoTeamsFromGsi() {
  if (state.autoTeams === false || state.mode !== 'gsi') return false;
  const T = detectGsiTeams();
  if ((!T.radiant && !T.dire) || T.radiant === T.dire) return false;
  const sideOf = (t) => t && SIDES.find((sd) => state.teams[sd].dbId === t.id);
  // a team already on screen keeps its side; neither on screen: keep the current Radiant side
  const rs = sideOf(T.radiant) || (sideOf(T.dire) && other(sideOf(T.dire))) || state.radiantSide;
  let any = false;
  if (state.radiantSide !== rs) { state.radiantSide = rs; any = true; }
  for (const [t, side] of [[T.radiant, rs], [T.dire, other(rs)]]) if (t && state.teams[side].dbId !== t.id) { loadTeamToSide(side, t, false); any = true; }
  return any;
}

/* ------------------------------------------------------------------ */
/* Tournament statistics (data/stats.json)                             */
/* ------------------------------------------------------------------ */
const seedLinks = readJSON(path.join(SEED_DIR, 'links.json'), {});
const seedRoster = readJSON(path.join(SEED_DIR, 'roster.json'), []);
let statsVersion = 1;
let statsCache = null;
let statsSync = { running: false, done: 0, total: 0, ok: 0, failed: 0, message: '' };

// ---- tournaments: each has its own stats file; the active one feeds the stats page and the hero popup ----
function loadTournaments() {
  let t = readJSON(TOURNAMENTS_FILE, null);
  if (!t || !Array.isArray(t.list) || !t.list.length) t = { active: 'direbattle-cup', list: [{ id: 'direbattle-cup', name: 'Dire Battle Cup', file: DEFAULT_STATS }] };
  t.list = t.list.filter((x) => x && x.id && x.file);
  // each tournament has a design (theme) for the overlays and the panel
  for (const x of t.list) if (!THEMES.includes(x.theme)) x.theme = /uprising/i.test(x.name) ? 'uprising' : /direborn/i.test(x.name) ? 'direborn' : 'battlecup';
  if (!t.builtins) {                                // Nov 2026: the three broadcasts we run
    if (!t.list.some((x) => x.theme === 'uprising')) t.list.push({ id: 'direbattle-uprising', name: 'Direbattle Uprising', file: 'stats-direbattle-uprising.json', theme: 'uprising', created: Date.now() });
    if (!t.list.some((x) => x.theme === 'direborn')) t.list.push({ id: 'direborn-match', name: 'Direborn Match', file: 'stats-direborn-match.json', theme: 'direborn', created: Date.now() });
    t.builtins = 1;
  }
  if (!t.list.some((x) => x.id === t.active)) t.active = t.list[0].id;
  return t;
}
const THEMES = ['battlecup', 'uprising', 'direborn'];
const tournamentInfo = (x) => ({ id: x.id, name: x.name, theme: x.theme || 'battlecup' });
let tournaments = loadTournaments();
const activeTournament = () => tournaments.list.find((x) => x.id === tournaments.active) || tournaments.list[0];
toursReady = true;
teamDb = loadTeamDb();
const statsFile = () => path.join(ROOT, 'data', activeTournament().file);
function saveTournaments() {
  fs.mkdirSync(path.dirname(TOURNAMENTS_FILE), { recursive: true });
  fs.writeFileSync(TOURNAMENTS_FILE, JSON.stringify(tournaments, null, 1));
}
function loadStatsDb() {
  const t = activeTournament(), file = statsFile();
  let db = readJSON(file, null);
  if (!db && t.file === DEFAULT_STATS) {
    db = readJSON(path.join(SEED_DIR, 'stats.json'), null);    // first start: Direbattle Cup dashboard already imported
    if (db) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(db)); } catch {} }
  }
  if (db && t.file === DEFAULT_STATS) {             // fill in fields newer versions read from the dashboard (deaths, wards, healing, ...)
    const seed = readJSON(path.join(SEED_DIR, 'stats.json'), null);
    let added = 0;
    if (seed) {
      for (const [id, m] of Object.entries(seed.matches || {})) { const cur = db.matches?.[id]; if (cur) for (const k of ['deaths', 'assists', 'gpm', 'xpm']) if (cur[k] == null && m[k] != null) { cur[k] = m[k]; added++; } }
      for (const [id, a] of Object.entries(seed.accounts || {})) { const cur = db.accounts?.[id]; if (cur) for (const k of ['lastHits', 'denies', 'healing', 'obsWards', 'sentryWards', 'goldEarned']) if (cur[k] == null && a[k] != null) { cur[k] = a[k]; added++; } }
    }
    if (added) { try { fs.writeFileSync(file, JSON.stringify(db)); } catch {} }
  }
  db = db || {};
  db.matches ||= {}; db.accounts ||= {}; db.teams ||= {}; db.imports ||= [];
  db.label ||= t.file === DEFAULT_STATS ? 'DIRE BATTLE CUP' : String(t.name).toUpperCase();
  return db;
}
let statsDb = loadStatsDb();
function saveStats() {
  fs.mkdirSync(path.dirname(statsFile()), { recursive: true });
  fs.writeFileSync(statsFile(), JSON.stringify(statsDb));
  statsCache = null; statsVersion++;
}
function switchTournament(id) {
  if (!tournaments.list.some((x) => x.id === id)) throw new UserError('Unknown tournament');
  if (statsSync.running) throw new UserError('Wait until the OpenDota update has finished');
  // next match + running text belong to the tournament: park the current ones, bring back the new tournament's
  const from = activeTournament(), to = tournaments.list.find((x) => x.id === id), fresh = freshState();
  if (from && from.id !== id) {
    from.live = { nextMatch: state.nextMatch, ticker: state.ticker };
    const keepV = (o, cur) => ({ ...o, v: ((cur && cur.v) || 0) + 1 });
    state.nextMatch = keepV((to.live && to.live.nextMatch) || fresh.nextMatch, state.nextMatch);
    state.ticker = keepV((to.live && to.live.ticker) || { ...fresh.ticker, messages: [to.name] }, state.ticker);
  }
  tournaments.active = id; saveTournaments();
  statsDb = loadStatsDb(); statsCache = null; statsVersion++;
  // teams & players of the new tournament; the draft drops teams that belong to another tournament
  teamDb = loadTeamDb();
  if (from && from.id !== id) for (const side of SIDES) {
    if (!teamDb.some((x) => x.id === state.teams[side].dbId)) { state.teams[side] = fresh.teams[side]; state.pickPlayers[side] = [null, null, null, null, null]; }
  }
  if (isDefaultT()) { try { autoSyncOfficialRoster(); } catch {} }
  statsSync = { running: false, done: 0, total: 0, ok: 0, failed: 0, message: '' };
}
function createTournament(name, theme) {
  name = String(name || '').trim().slice(0, 60);
  if (!name) throw new UserError('Give the tournament a name');
  let id = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tournament';
  while (tournaments.list.some((x) => x.id === id)) id += '-2';
  tournaments.list.push({ id, name, file: 'stats-' + id + '.json', theme: THEMES.includes(theme) ? theme : 'battlecup', created: Date.now() });
  saveTournaments(); switchTournament(id); saveStats();
  return id;
}
function deleteTournament(id) {
  const t = tournaments.list.find((x) => x.id === id);
  if (!t) throw new UserError('Unknown tournament');
  if (t.file === DEFAULT_STATS) throw new UserError('The Dire Battle Cup stats can\'t be deleted');
  try { fs.renameSync(path.join(ROOT, 'data', t.file), path.join(ROOT, 'data', t.file.replace(/\.json$/, '') + '.deleted-' + Date.now() + '.json')); } catch {}
  try { fs.renameSync(bracketFile(t), bracketFile(t).replace(/\.json$/, '') + '.deleted-' + Date.now() + '.json'); } catch {}
  try { fs.renameSync(teamsFile(t), teamsFile(t).replace(/\.json$/, '') + '.deleted-' + Date.now() + '.json'); } catch {}
  tournaments.list = tournaments.list.filter((x) => x.id !== id);
  if (tournaments.active === id) { tournaments.active = tournaments.list[0].id; }
  saveTournaments(); statsDb = loadStatsDb(); teamDb = loadTeamDb(); statsCache = null; statsVersion++;
}

// ---- add one match by ID (OpenDota) and, if asked, create both teams from it ----
const newTeamId = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
async function saveRemoteLogo(url, teamId) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return '';
    const type = r.headers.get('content-type') || '';
    const ext = /png/.test(type) ? 'png' : /jpe?g/.test(type) ? 'jpg' : /webp/.test(type) ? 'webp' : /svg/.test(type) ? 'svg' : '';
    if (!ext) return '';
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 5e6) return '';
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const file = `team-${String(teamId).replace(/\W/g, '')}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
    return '/logos/uploads/' + file;
  } catch { return ''; }
}
async function teamsFromMatch(j, m) {
  const out = [];
  for (const side of ['radiant', 'dire']) {
    const tj = (side === 'radiant' ? j.radiant_team : j.dire_team) || {};
    const raw = (j.players || []).filter((p) => ((p.isRadiant != null ? p.isRadiant : p.player_slot < 128) ? 'radiant' : 'dire') === side);
    const ps = raw.map((p) => ({ accountId: p.account_id != null ? String(p.account_id) : '', name: String(p.name || p.personaname || '').trim() || 'Player ' + ((p.player_slot % 128) + 1) }));
    const name = m[side].name;
    // a team whose roster already holds 3+ of these accounts is the same team: reuse it
    const hits = {};
    for (const p of ps) { const r = rosterByAccount(p.accountId); if (r) hits[r.team.id] = (hits[r.team.id] || 0) + 1; }
    const best = Object.entries(hits).sort((a, b) => b[1] - a[1])[0];
    let t = best && best[1] >= 3 ? teamDb.find((x) => x.id === best[0]) : teamDb.find((x) => ST.normKey(x.name) === ST.normKey(name));
    const rep = { side, team: null, created: false, added: [], linked: 0, elsewhere: [] };
    if (!t) {
      t = cleanTeam({ name, tag: tj.tag || name.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase(), color: side === 'radiant' ? '#3fbf7f' : '#d8453c' }, newTeamId());
      if (tj.logo_url) t.logo = await saveRemoteLogo(tj.logo_url, tj.team_id || t.id);
      teamDb.push(t); rep.created = true;
    }
    for (const p of ps) {
      const r = rosterByAccount(p.accountId);
      if (r && r.team === t) continue;
      let i = findRosterPlayer(t, p.name);
      if (i < 0) i = t.players.findIndex((x) => !x);
      if (i < 0) continue;
      if (!t.players[i]) { t.players[i] = p.name.slice(0, 40); rep.added.push(p.name); }
      if (p.accountId && !r) { linkAccount(p.accountId, t, i); rep.linked++; }
      else if (r) rep.elsewhere.push(`${p.name} (already ${r.team.players[r.index]} in ${r.team.name})`);
    }
    rep.team = { id: t.id, name: t.name, players: t.players.filter(Boolean) };
    out.push({ rep, t });
  }
  teamDb.sort((a, b) => a.name.localeCompare(b.name));
  saveTeamDb();
  return out;
}
async function addMatchById(rawId, opts = {}) {
  const id = (String(rawId || '').match(/\d{6,}/) || [])[0];
  if (!id) throw new UserError('Enter a match ID (or paste the Dotabuff / OpenDota link)');
  let r;
  try { r = await fetch(`https://api.opendota.com/api/matches/${id}`, { signal: AbortSignal.timeout(25000) }); }
  catch (e) { throw new UserError('Could not reach OpenDota (' + e.message + '). Is this PC online?'); }
  if (r.status === 404) {
    fetch(`https://api.opendota.com/api/request/${id}`, { method: 'POST', signal: AbortSignal.timeout(10000) }).catch(() => {});
    throw new UserError(`OpenDota doesn't have match ${id} yet. I asked it to parse the match; try again in a few minutes.`);
  }
  if (!r.ok) throw new UserError('OpenDota answered HTTP ' + r.status + ' — try again in a minute');
  const j = await r.json();
  const m = ST.fromOpenDota(j);
  if (!m || !m.players) throw new UserError('OpenDota has no player data for this match yet; try again in a few minutes');
  if (!m.radiant.name) m.radiant.name = 'Radiant';
  if (!m.dire.name) m.dire.name = 'Dire';
  const isNew = !statsDb.matches[m.matchId];
  ST.mergeDetail(statsDb, m, 'opendota');
  if (isNew && !statsDb.imports.length) {            // tournaments without a dashboard keep their player list from the matches
    for (const p of m.players) {
      if (!p.accountId) continue;
      const a = (statsDb.accounts[p.accountId] ||= { accountId: p.accountId, name: p.name, team: m[p.side].name, games: 0, wins: 0, avgGpm: 0, heroIds: {} });
      a.avgGpm = (a.avgGpm * a.games + p.gpm) / (a.games + 1); a.games++;
      if (m.winner === p.side) a.wins++;
      if (p.heroId) a.heroIds[p.heroId] = (a.heroIds[p.heroId] || 0) + 1;
    }
  }
  saveStats();
  let teams = [];
  if (opts.createTeams) {
    teams = await teamsFromMatch(j, m);
    if (opts.loadTeams) {
      loadTeamToSide('left', teams[0].t, false); loadTeamToSide('right', teams[1].t, false);
      state.radiantSide = 'left';
    }
  }
  changed();
  const fmtD = (s) => (s ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : '?');
  return {
    match: { matchId: m.matchId, radiant: m.radiant.name, dire: m.dire.name, winner: m.winner, duration: fmtD(m.duration), league: j.league?.name || '', isNew,
      score: `${j.radiant_score ?? '?'}–${j.dire_score ?? '?'}`, hasDraft: !!(m.picksBans && m.picksBans.length) },
    teams: teams.map((x) => x.rep), loaded: !!(opts.createTeams && opts.loadTeams),
  };
}
function heroStats() {
  if (!statsCache) {
    const nameOf = (acc, fallback) => { const r = rosterByAccount(acc); return r ? r.team.players[r.index] || fallback : fallback; };
    statsCache = { label: statsDb.label, ...ST.computeHeroStats(statsDb, nameOf) };
  }
  return statsCache;
}
const seedRole = (teamName, playerName) => {
  const t = seedRoster.find((x) => ST.teamKeyMatch(x.name, teamName));
  const row = t && t.players.find(([n]) => ST.normKey(n) === ST.normKey(playerName) || ST.stripTagKey(n) === ST.stripTagKey(playerName));
  return row ? row[1] : '';
};
const findRosterPlayer = (t, name) => t.players.findIndex((p) => p && (ST.normKey(p) === ST.normKey(name) || ST.stripTagKey(p) === ST.stripTagKey(name)));
function accountSuggestions() {
  return Object.values(statsDb.accounts).map((a) => {
    const out = {
      accountId: a.accountId, name: a.name, team: a.team, games: a.games, wins: a.wins, avgGpm: Math.round(a.avgGpm || 0),
      heroes: Object.entries(a.heroIds || {}).sort((x, y) => y[1] - x[1]).map(([id, n]) => (heroById.get(Number(id))?.name || '#' + id) + (n > 1 ? ' ×' + n : '')),
      link: null,
    };
    const L = (t, i, how, note) => ({ teamId: t.id, index: i, player: t.players[i], teamName: t.name, how, note: note || '' });
    const linked = rosterByAccount(a.accountId);
    if (linked) { out.link = L(linked.team, linked.index, 'linked'); return out; }
    const sd = seedLinks[a.accountId];
    if (sd) {
      const t = teamDb.find((x) => ST.teamKeyMatch(x.name, sd.team));
      const i = t ? findRosterPlayer(t, sd.player) : -1;
      if (i >= 0) { out.link = L(t, i, sd.how, sd.note); return out; }
      out.hint = `${sd.player} (${sd.team})`;
    }
    const pool = teamDb.filter((t) => ST.teamKeyMatch(t.name, a.team));
    for (const t of pool.length ? pool : teamDb) {
      const i = findRosterPlayer(t, a.name);
      if (i >= 0) { out.link = L(t, i, 'name'); return out; }
    }
    return out;
  }).sort((x, y) => String(x.team).localeCompare(y.team) || String(x.name).localeCompare(y.name));
}
// add the Direbattle Cup teams that aren't in the database yet, and fill empty roles
function createSeedTeams() {
  let created = 0, roles = 0;
  for (const r of seedRoster) {
    const t = teamDb.find((x) => ST.teamKeyMatch(x.name, r.name));
    if (!t) {
      teamDb.push(cleanTeam({ name: r.name, tag: r.tag, color: r.color, captain: r.captain, players: r.players.map((x) => x[0]), roles: r.players.map((x) => x[1]) },
        't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)));
      created++;
    } else {
      r.players.forEach(([n, role]) => { const i = findRosterPlayer(t, n); if (i >= 0 && !t.roles[i]) { t.roles[i] = role; roles++; } });
    }
  }
  teamDb.sort((a, b) => a.name.localeCompare(b.name));
  saveTeamDb();
  return { created, roles };
}

// ---- official roster sheet: Steam IDs, roles, captains, stand-ins ----
let lastRosterSync = readJSON(ROSTER_SYNC_FILE, {}).last || null;
function applyRoster(parsed, source) {
  const r = { source, at: Date.now(), teamsCreated: [], playersAdded: [], idsAdded: 0, moved: [], kept: [], roles: 0, captains: 0, skipped: [] };
  const official = [];
  for (const rt of parsed.teams) {
    let t = teamDb.find((x) => ST.teamKeyMatch(x.name, rt.name));
    if (!t) {
      const sr = seedRoster.find((x) => ST.teamKeyMatch(x.name, rt.name)) || {};
      t = cleanTeam({ name: rt.name, tag: sr.tag || rt.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase(), color: sr.color }, 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
      teamDb.push(t); r.teamsCreated.push(rt.name);
    }
    for (const p of rt.players) {
      // the player's slot: name first (an older, wrong link must not decide who is who), then real name, then Steam ID
      let i = findRosterPlayer(t, p.nick);
      if (i < 0 && p.realName) i = t.realNames.findIndex((n) => n && ST.normKey(n) === ST.normKey(p.realName));
      if (i < 0 && p.accountId) i = t.accountIds.findIndex((a) => ST.idsOf(a).includes(p.accountId));
      if (i < 0) {
        const pref = p.role === 'standin' ? [5, 6, 0, 1, 2, 3, 4] : [(p.roleNo || 1) - 1, 0, 1, 2, 3, 4, 5, 6];
        i = pref.find((k) => k >= 0 && k < MAX_PLAYERS && !t.players[k]);
        if (i == null) { r.skipped.push(`${p.nick} (${t.name}: no free player slot)`); continue; }
        t.players[i] = p.nick; r.playersAdded.push(`${p.nick} (${t.name})`);
      }
      if (p.accountId) {
        const prev = rosterByAccount(p.accountId);
        if (!prev) r.idsAdded++;
        else if (!(prev.team.id === t.id && prev.index === i)) r.moved.push(`${p.accountId}: ${prev.team.players[prev.index]} → ${t.players[i]} (${t.name})`);
        linkAccount(p.accountId, t, i);
        official.push({ t, i, acc: p.accountId });
      }
      if (p.role && t.roles[i] !== p.role) { t.roles[i] = p.role; r.roles++; }
      if (p.captain && t.captain !== i) { t.captain = i; r.captains++; }
      if (p.realName) t.realNames[i] = p.realName;
    }
  }
  // extra accounts a player still has besides the official one (e.g. a second account seen in the stats)
  for (const { t, i, acc } of official) {
    const extra = ST.idsOf(t.accountIds[i]).filter((a) => a !== acc);
    if (extra.length) r.kept.push(`${t.players[i]} (${t.name}): official ${acc}, also kept ${extra.join(', ')}` + (extra.some((a) => statsDb.accounts[a]) ? ' — played games on it' : ''));
  }
  teamDb.sort((a, b) => a.name.localeCompare(b.name));
  saveTeamDb();
  for (const side of SIDES) { const t = teamDb.find((x) => x.id === state.teams[side].dbId); if (t) loadTeamToSide(side, t, true); }
  lastRosterSync = r;
  return r;
}
// the bundled official roster is applied once per version of the sheet
function autoSyncOfficialRoster() {
  if (!isDefaultT()) return;                       // the official roster sheet is the Dire Battle Cup's
  const seed = readJSON(path.join(SEED_DIR, 'official-roster.json'), null);
  if (!seed || !Array.isArray(seed.teams)) return;
  const done = readJSON(ROSTER_SYNC_FILE, {});
  const key = require('crypto').createHash('sha1').update(JSON.stringify(seed.teams)).digest('hex').slice(0, 12);
  if ((done.applied || []).includes(key)) return;
  const r = applyRoster(seed, seed.source || 'official roster');
  done.applied = [...(done.applied || []), key]; done.last = r;
  fs.mkdirSync(path.dirname(ROSTER_SYNC_FILE), { recursive: true });
  fs.writeFileSync(ROSTER_SYNC_FILE, JSON.stringify(done, null, 1));
  console.log(`  Synced Steam IDs from ${r.source}: ${r.idsAdded} new IDs, ${r.moved.length} moved, ${r.playersAdded.length} players and ${r.teamsCreated.length} teams added`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function syncOpenDota({ league = true, force = false } = {}) {
  if (statsSync.running) return;
  statsSync = { running: true, done: 0, total: 0, ok: 0, failed: 0, notFound: 0, message: 'Contacting OpenDota…' };
  broadcast();
  try {
    if (league && statsDb.leagueId) {
      // only games inside the tournament window (the league also contains the Open Series)
      const xl = Object.values(statsDb.matches).filter((m) => m.sources.includes('xlsx') && m.endedTs);
      const since = xl.length ? Math.min(...xl.map((m) => m.endedTs)) - 12 * 3600000 : 0;
      try {
        const r = await fetch(`https://api.opendota.com/api/leagues/${statsDb.leagueId}/matches`, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        let added = 0;
        for (const m of (await r.json()) || []) {
          const id = String(m.match_id || '');
          const end = m.start_time ? (m.start_time + (m.duration || 0)) * 1000 : null;
          if (!id || statsDb.matches[id] || (since && end && end < since)) continue;
          statsDb.matches[id] = { matchId: id, endedTs: end, duration: m.duration || null, radiant: { name: m.radiant_name || '', teamId: String(m.radiant_team_id || '') }, dire: { name: m.dire_name || '', teamId: String(m.dire_team_id || '') }, winner: m.radiant_win === true ? 'radiant' : m.radiant_win === false ? 'dire' : null, firstPick: null, picksBans: null, players: null, sources: ['opendota'] };
          added++;
        }
        statsSync.leagueAdded = added;
      } catch (e) { statsSync.leagueError = e.message; }
    }
    const ids = Object.values(statsDb.matches).filter((m) => force || !(m.players && m.players.length && m.picksBans)).map((m) => m.matchId);
    statsSync.total = ids.length;
    for (const id of ids) {
      statsSync.message = `Match ${id}`;
      try {
        const r = await fetch(`https://api.opendota.com/api/matches/${id}`, { signal: AbortSignal.timeout(25000) });
        if (r.status === 404) {
          statsSync.notFound++;
          fetch(`https://api.opendota.com/api/request/${id}`, { method: 'POST', signal: AbortSignal.timeout(10000) }).catch(() => {});
        } else if (!r.ok) throw new Error('HTTP ' + r.status);
        else {
          const m = ST.fromOpenDota(await r.json());
          if (m && m.players) { ST.mergeDetail(statsDb, m, 'opendota'); statsSync.ok++; } else statsSync.failed++;
        }
      } catch (e) { statsSync.failed++; statsSync.lastError = e.message; }
      statsSync.done++;
      broadcast();
      if (statsSync.done < ids.length) await sleep(1100);       // OpenDota free tier: 60 requests/minute
    }
    saveStats();
    statsSync.message = `Updated ${statsSync.ok} of ${statsSync.total} matches` +
      (statsSync.leagueAdded ? ` · ${statsSync.leagueAdded} new from the league` : '') +
      (statsSync.notFound ? ` · ${statsSync.notFound} not on OpenDota yet (requested — try again in a few minutes)` : '') +
      (statsSync.failed ? ` · ${statsSync.failed} failed${statsSync.lastError ? ' (' + statsSync.lastError + ')' : ''}` : '');
    statsSync.finishedAt = Date.now();
  } finally {
    statsSync.running = false;
    changed();
  }
}

// ---- record finished games through GSI ----
let draftSnap = null;
function snapshotDraft(body) {
  const d = body && body.draft;
  if (!d || !(d.team2 || d.team3)) return;
  const pb = [];
  for (const [k, side] of [['team2', 'radiant'], ['team3', 'dire']]) {
    const t = d[k]; if (!t) continue;
    for (let i = 0; i < PICK_COUNT; i++) { const id = resolveGsiHero(t[`pick${i}_id`], t[`pick${i}_class`]); if (id) pb.push({ heroId: id, isPick: true, side, order: i }); }
    for (let i = 0; i < BAN_COUNT; i++) { const id = resolveGsiHero(t[`ban${i}_id`], t[`ban${i}_class`]); if (id) pb.push({ heroId: id, isPick: false, side, order: i }); }
  }
  if (pb.length) draftSnap = { matchId: String(body.map?.matchid || ''), picksBans: pb };
}
function manualDraft() {
  const pb = [];
  for (const side of SIDES) {
    const team = side === state.radiantSide ? 'radiant' : 'dire';
    state.slots[side].picks.forEach((id, i) => id && pb.push({ heroId: id, isPick: true, side: team, order: i }));
    state.slots[side].bans.forEach((id, i) => id && pb.push({ heroId: id, isPick: false, side: team, order: i }));
  }
  return pb;
}
function recordFinishedGame(body) {
  const map = body && body.map;
  if (!state.recordStats || !map || map.game_state !== 'DOTA_GAMERULES_STATE_POST_GAME') return false;
  const winner = String(map.win_team || '').toLowerCase();
  const id = String(map.matchid || '').replace(/\D/g, '');
  if (!['radiant', 'dire'].includes(winner) || !id || id === '0') return false;
  const cur = statsDb.matches[id];
  if (cur && cur.players && cur.players.length && cur.picksBans) return false;     // already complete
  if (cur && cur.sources.includes('overlay')) return false;
  const radSide = state.radiantSide;
  const pb = draftSnap && (!draftSnap.matchId || draftSnap.matchId === id) ? draftSnap.picksBans : manualDraft();
  const players = gsiPlayers.filter((p) => p.heroId).map((p) => ({ accountId: p.accountId, name: p.name, side: p.team, heroId: p.heroId, kills: p.kills, deaths: p.deaths, assists: p.assists, gpm: p.gpm, xpm: p.xpm, netWorth: p.netWorth }));
  const m = {
    matchId: id, endedTs: Date.now(), duration: Number(map.clock_time) > 0 ? Number(map.clock_time) : null,
    radiant: { name: state.teams[radSide].name, teamId: '' }, dire: { name: state.teams[other(radSide)].name, teamId: '' },
    winner, firstPick: state.firstPick === radSide ? 'radiant' : 'dire',
    picksBans: pb.length ? pb : null, players: players.length ? players : null,
  };
  ST.mergeDetail(statsDb, m, 'overlay');
  saveStats();
  state.lastRecorded = { matchId: id, at: Date.now(), winner: m[winner].name || winner };
  console.log(`  Recorded match ${id} to stats (${m[winner].name || winner} won)`);
  return true;
}

/* ------------------------------------------------------------------ */
/* Broadcast (Server-Sent Events) + persistence                        */
/* ------------------------------------------------------------------ */
const clients = new Set();
function publicState() {
  const { history, ...rest } = state;
  return {
    ...rest,
    historyLength: history.length,
    serverNow: Date.now(),
    display: { animatedPortraits: true, portraitWaist: 0.58, portraitTop: 0.06, showScore: true, showHeroNames: true, showPlayerNames: true, sounds: true, soundVolume: 0.9, heroFraming: {}, ...(config.display || {}) , heroFraming: { ...((config.display || {}).heroFraming || {}), ...framingDb } },
        sequence: SEQ.map((s) => ({ side: sideOfWho(s.who), type: s.type, index: s.index, step: s.step })),
    gsi: { lastAt: gsiLastAt, diag: gsiDiag, tokenExpected: !!config.gsi?.token, delay: Number(state.gsiDelay) || 0,
      queued: gsiQueue.length, oldest: gsiQueue.length ? gsiQueue[0].at : 0 },
    precache,
    card: cardData(),
    camSel: camSelection(),
    statsVersion,
    tournament: activeTournament().name,
    tournamentInfo: tournamentInfo(activeTournament()),
    tournamentList: tournaments.list.map(tournamentInfo),
    statsSync,
    gsiPlayers: gsiPlayers.map((p) => { const m = findDbPlayer(p); return { ...p, match: m ? { name: m.team.players[m.index], team: m.team.name, how: m.how } : null }; }),
  };
}
// what an OBS source (not logged in) may see: no keys, no GSI diagnostics
function stateFor(admin) {
  const s = publicState();
  if (admin) return s;
  const { playerCam, gsi, ...rest } = s;
  const { url, viewKey, pushKey, ...pc } = playerCam || {};
  return { ...rest, playerCam: pc, gsi: { lastAt: gsi.lastAt, delay: gsi.delay } };
}
function broadcast() {
  let full = null, pub = null;
  for (const res of clients) {
    if (res.isAdmin) res.write(full ||= `data: ${JSON.stringify(stateFor(true))}\n\n`);
    else res.write(pub ||= `data: ${JSON.stringify(stateFor(false))}\n\n`);
  }
}
let saveTimer = null;
function changed() {
  broadcast();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fsp.writeFile(STATE_FILE, JSON.stringify(state, null, 1)).catch(() => {}), 400);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15000);

/* ------------------------------------------------------------------ */
/* Hero image cache (downloads from Valve's CDN once, then serves local) */
/* ------------------------------------------------------------------ */
const IMG_KINDS = {
  icon: ['images/dota_react/heroes/', '.png', 'image/png'],
  render: ['videos/dota_react/heroes/renders/', '.png', 'image/png'],
  anim: ['videos/dota_react/heroes/renders/', '.webm', 'video/webm'],
};
const inflight = new Map();
const failed = new Map();
async function ensureImage(kind, slug) {
  const [prefix, ext] = IMG_KINDS[kind];
  const file = path.join(IMG_DIR, kind, slug + ext);
  if (fs.existsSync(file)) return file;
  const key = kind + '/' + slug;
  if (failed.has(key) && Date.now() - failed.get(key) < 10 * 60 * 1000) throw new Error('recently failed');
  if (!inflight.has(key)) {
    inflight.set(key, (async () => {
      try {
        const r = await fetch(CDN + prefix + slug + ext, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const buf = Buffer.from(await r.arrayBuffer());
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file + '.tmp', buf);
        await fsp.rename(file + '.tmp', file);
        return file;
      } catch (e) {
        failed.set(key, Date.now());
        throw e;
      } finally {
        inflight.delete(key);
      }
    })());
  }
  return inflight.get(key);
}

async function startPrecache(anim) {
  precache = { running: false, done: 1, total: 1, failed: 0 };      // online: images come from Valve's CDN through Cloudflare's cache
  broadcast();
  if (true) return;
  if (precache.running) return;
  const kinds = anim ? ['icon', 'render', 'anim'] : ['icon', 'render'];
  const jobs = heroes.flatMap((h) => kinds.map((k) => [k, h.slug]));
  precache = { running: true, done: 0, total: jobs.length, failed: 0 };
  broadcast();
  let i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const [k, s] = jobs[i++];
      try { await ensureImage(k, s); } catch { precache.failed++; }
      precache.done++;
      if (precache.done % 10 === 0) broadcast();
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  precache.running = false;
  broadcast();
  console.log(`  Pre-cache finished: ${precache.done - precache.failed}/${precache.total} files`);
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.gif': 'image/gif', '.webm': 'video/webm', '.mp4': 'video/mp4', '.woff2': 'font/woff2',
};

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readRaw(req, limit) {
  const b = req.body || Buffer.alloc(0);
  if (b.length > limit) throw new UserError('File too large (max ' + Math.round(limit / 1048576) + ' MB)');
  return b;
}
async function readBody(req, limit = 2e6) {
  const b = req.body || Buffer.alloc(0);
  if (b.length > limit) throw new Error('Body too large');
  return b.toString('utf8');
}
function parseLooseJSON(text) {
  try { return JSON.parse(text); } catch {
    // Some Dota builds emit unquoted numeric keys under player/owner — quote them and retry.
    return JSON.parse(text.replace(/"(player|owner)":(\s*)(\d+)/g, '"$1": "$3"'));
  }
}

const handler = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'GET,POST' });
      return res.end();
    }

    if (p === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
      res.isAdmin = !!req.isAdmin;
      res.write('retry: 1000\n');
      res.write(`data: ${JSON.stringify(stateFor(res.isAdmin))}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      // end each stream after ~10 min (the page reconnects by itself): a long-lived stream would keep this
      // Durable Object on old code after a deploy
      const life = setTimeout(() => { clients.delete(res); try { res.end(); } catch {} }, 540000 + Math.floor(Math.random() * 120000));
      req.on('close', () => clearTimeout(life));
      return;
    }
    if (p === '/api/state') return send(res, 200, stateFor(!!req.isAdmin), 'application/json');
    if (p === '/api/heroes') return send(res, 200, heroes, 'application/json');

    // ---- team database ----
    if (p === '/api/teams' && req.method === 'GET') return send(res, 200, teamDb, 'application/json');
    if (p === '/api/teams' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        if (!String(body.name || '').trim()) throw new UserError('Team name is required');
        const id = body.id && teamDb.some((t) => t.id === body.id) ? body.id : 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const team = cleanTeam(body, id);
        const i = teamDb.findIndex((t) => t.id === id);
        if (i >= 0) teamDb[i] = team; else teamDb.push(team);
        teamDb.sort((a, b) => a.name.localeCompare(b.name));
        saveTeamDb();
        // keep the live overlay in sync if this team is on screen
        for (const side of SIDES) if (state.teams[side].dbId === id) loadTeamToSide(side, team, true);
        changed();
        return send(res, 200, { ok: true, team }, 'application/json');
      } catch (e) {
        return send(res, e instanceof UserError ? 400 : 500, { ok: false, error: e.message }, 'application/json');
      }
    }
    if (p === '/api/teams/import-roster' && req.method === 'POST') {
      try {
        const name = decodeURIComponent(String(req.headers['x-filename'] || 'roster.xlsx'));
        const parsed = parseRosterBook(readXlsx(await readRaw(req, 25 * 1024 * 1024)));
        const r = applyRoster(parsed, name);
        const done = readJSON(ROSTER_SYNC_FILE, {}); done.last = r;
        fs.writeFileSync(ROSTER_SYNC_FILE, JSON.stringify(done, null, 1));
        changed();
        return send(res, 200, { ok: true, report: r }, 'application/json');
      } catch (e) {
        return send(res, 400, { ok: false, error: e.message }, 'application/json');
      }
    }
    // ---- teams from a league ticket (OpenDota): list the teams, then import the chosen ones with their current players ----
    if (p === '/api/teams/league-list' && req.method === 'POST') {
      try {
        const b = JSON.parse((await readBody(req)) || '{}');
        const lid = String(b.leagueId || '').match(/\d{3,}/); if (!lid) throw new UserError('Isi ID tiket liga (angka), misalnya dari link Dotabuff/Stratz');
        const r = await fetch(`https://api.opendota.com/api/leagues/${lid[0]}/teams`, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw new UserError('OpenDota: HTTP ' + r.status);
        const list = (await r.json()) || [];
        const info = await fetch(`https://api.opendota.com/api/leagues/${lid[0]}`, { signal: AbortSignal.timeout(10000) }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
        const teams = list.filter((t) => t && t.team_id).map((t) => ({ teamId: t.team_id, name: t.name || t.tag || 'Team ' + t.team_id, tag: t.tag || '', logo: t.logo_url || '',
          last: t.last_match_time ? t.last_match_time * 1000 : 0, games: (t.wins || 0) + (t.losses || 0),
          inDb: !!teamDb.find((x) => ST.teamKeyMatch(x.name, t.name || t.tag || '')) }))
          .sort((a, c) => c.last - a.last);
        return send(res, 200, { ok: true, leagueId: lid[0], leagueName: (info && info.name) || '', teams }, 'application/json');
      } catch (e) { return send(res, e instanceof UserError ? 400 : 502, { ok: false, error: e instanceof UserError ? e.message : 'OpenDota tidak bisa dihubungi: ' + e.message }, 'application/json'); }
    }
    // find a league ticket by name (OpenDota explorer; falls back to the full league list)
    if (p === '/api/teams/league-search' && req.method === 'POST') {
      try {
        const b = JSON.parse((await readBody(req)) || '{}');
        const q = String(b.q || '').replace(/[^\p{L}\p{N} .:&+\-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (q.length < 2) throw new UserError('Ketik minimal 2 huruf');
        const words = q.split(' ').filter(Boolean).slice(0, 6);
        let rows = null;
        try {
          const where = words.map((w) => `name ILIKE '%${w.replace(/'/g, "''").replace(/[%_]/g, '')}%'`).join(' AND ');
          const sql = `SELECT leagueid, name, tier FROM leagues WHERE ${where} ORDER BY leagueid DESC LIMIT 25`;
          const r = await fetch('https://api.opendota.com/api/explorer?sql=' + encodeURIComponent(sql), { signal: AbortSignal.timeout(15000) });
          if (r.ok) { const j = await r.json(); if (Array.isArray(j.rows)) rows = j.rows; }
        } catch {}
        if (!rows) {
          const r = await fetch('https://api.opendota.com/api/leagues', { signal: AbortSignal.timeout(20000) });
          if (!r.ok) throw new UserError('OpenDota: HTTP ' + r.status);
          const lw = words.map((w) => w.toLowerCase());
          rows = ((await r.json()) || []).filter((l) => l && l.name && lw.every((w) => l.name.toLowerCase().includes(w))).sort((a, c) => c.leagueid - a.leagueid).slice(0, 25);
        }
        return send(res, 200, { ok: true, leagues: rows.map((l) => ({ leagueId: String(l.leagueid), name: l.name, tier: l.tier || '' })) }, 'application/json');
      } catch (e) { return send(res, e instanceof UserError ? 400 : 502, { ok: false, error: e instanceof UserError ? e.message : 'OpenDota tidak bisa dihubungi: ' + e.message }, 'application/json'); }
    }
    if (p === '/api/teams/league-import' && req.method === 'POST') {
      try {
        const b = JSON.parse((await readBody(req)) || '{}');
        const picks = (Array.isArray(b.teams) ? b.teams : []).slice(0, 40);
        if (!picks.length) throw new UserError('Pilih minimal satu tim');
        const out = { created: [], updated: [], failed: [] };
        for (const pk of picks) {
          try {
            // players come from the operator's browser (OpenDota rate-limits the shared server address); fetch here only as a fallback
            let all = Array.isArray(pk.players) ? pk.players : null;
            if (!all) { const r = await fetch(`https://api.opendota.com/api/teams/${Number(pk.teamId)}/players`, { signal: AbortSignal.timeout(15000) }); all = r.ok ? (await r.json()) || [] : []; }
            const cur = all.filter((x) => x.is_current_team_member).sort((x, y) => (y.games_played || 0) - (x.games_played || 0)).slice(0, MAX_PLAYERS);
            const name = String(pk.name || '').trim().slice(0, 60) || 'Team ' + pk.teamId;
            let t = teamDb.find((x) => ST.teamKeyMatch(x.name, name));
            if (!t) {
              t = cleanTeam({ name, tag: String(pk.tag || '').slice(0, 8) || name.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase(), logo: pk.logo || '',
                players: cur.map((x) => x.name || ''), accountIds: cur.map((x) => String(x.account_id || '')) }, 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
              teamDb.push(t); out.created.push(name);
            } else {
              if (!t.tag && pk.tag) t.tag = String(pk.tag).slice(0, 8);
              if (!t.logo && pk.logo) t.logo = String(pk.logo).slice(0, 300);
              for (const x of cur) {                         // add current players that are missing; never remove anyone
                const acc = String(x.account_id || '');
                if (t.accountIds.some((a) => ST.idsOf(a).includes(acc))) continue;
                let i = t.players.findIndex((n) => n && ST.normKey(n) === ST.normKey(x.name || ''));
                if (i < 0) i = t.players.findIndex((n) => !n);
                if (i < 0) continue;
                if (!t.players[i]) t.players[i] = String(x.name || '').slice(0, 40);
                t.accountIds[i] = [...new Set([...ST.idsOf(t.accountIds[i]), acc])].join(',');
              }
              out.updated.push(name);
            }
          } catch (e) { out.failed.push(String(pk.name || pk.teamId)); }
        }
        teamDb.sort((a, c) => a.name.localeCompare(c.name));
        saveTeamDb();
        // the tournament's stats follow the same ticket
        const lid = String(b.leagueId || '').match(/\d{3,}/);
        if (lid && !statsDb.leagueId) { statsDb.leagueId = lid[0]; if (b.leagueName) statsDb.leagueName = String(b.leagueName).slice(0, 80); saveStats(); }
        changed();
        return send(res, 200, { ok: true, ...out }, 'application/json');
      } catch (e) { return send(res, e instanceof UserError ? 400 : 500, { ok: false, error: e.message }, 'application/json'); }
    }
    if (p === '/api/roster-sync') return send(res, 200, lastRosterSync || {}, 'application/json');
    if (p === '/api/teams/delete' && req.method === 'POST') {
      const { id } = JSON.parse(await readBody(req));
      const t = teamDb.find((x) => x.id === id);
      teamDb = teamDb.filter((x) => x.id !== id);
      saveTeamDb();
      // remove the uploaded logo if nothing else uses it
      if (t && t.logo.startsWith('/logos/uploads/') && !teamDb.some((x) => x.logo === t.logo)) {
        fsp.unlink(path.join(PUBLIC_DIR, t.logo)).catch(() => {});
      }
      for (const side of SIDES) if (state.teams[side].dbId === id) delete state.teams[side].dbId;
      changed();
      return send(res, 200, { ok: true }, 'application/json');
    }
    if (p === '/api/upload-logo' && req.method === 'POST') {
      try {
        const name = decodeURIComponent(String(req.headers['x-filename'] || 'logo.png'));
        const ext = (path.extname(name).toLowerCase() || '.png');
        if (!['.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif'].includes(ext)) throw new UserError('Logo must be PNG, JPG, WEBP, SVG or GIF');
        const buf = await readRaw(req, 5 * 1024 * 1024);
        if (!buf.length) throw new UserError('Empty file');
        const base = path.basename(name, path.extname(name)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'logo';
        const file = `${base}-${Date.now().toString(36)}${ext}`;
        await fsp.mkdir(UPLOAD_DIR, { recursive: true });
        await fsp.writeFile(path.join(UPLOAD_DIR, file), buf);
        return send(res, 200, { ok: true, path: '/logos/uploads/' + file }, 'application/json');
      } catch (e) {
        return send(res, e instanceof UserError ? 400 : 500, { ok: false, error: e.message }, 'application/json');
      }
    }
    // ---- tournament statistics ----
    if (p === '/api/statcards') {
      const d = allStatCards();
      const raw = readJSON(STATCARDS_FILE, undefined);
      if (fs.existsSync(STATCARDS_FILE) && raw === undefined) d.error = 'data/statcards.json could not be read (check for a missing comma or quote). Showing the built-in cards.';
      return send(res, 200, d, 'application/json');
    }
    if (p === '/api/hero-stats') return send(res, 200, heroStats(), 'application/json');
    if (p === '/api/stats' && req.method === 'GET') {
      const list = Object.values(statsDb.matches).sort((a, b) => (b.endedTs || 0) - (a.endedTs || 0)).map((m) => ({
        matchId: m.matchId, endedTs: m.endedTs, duration: m.duration, radiant: m.radiant.name, dire: m.dire.name, winner: m.winner,
        sources: m.sources, hasDraft: !!(m.picksBans && m.picksBans.length), hasPlayers: !!(m.players && m.players.length),
      }));
      const hs = heroStats();
      const top = Object.entries(hs.heroes).map(([id, x]) => ({ heroId: Number(id), name: heroById.get(Number(id))?.name || '#' + id, slug: heroById.get(Number(id))?.slug || '', ...x, players: x.players.slice(0, 3) }))
        .sort((a, b) => b.picks - a.picks || b.bans - a.bans);
      return send(res, 200, { tournament: activeTournament().name, label: statsDb.label, leagueId: statsDb.leagueId || '', leagueName: statsDb.leagueName || '', matches: list, accounts: Object.keys(statsDb.accounts).length, imports: statsDb.imports, sync: statsSync, summary: { matches: hs.matches, detailed: hs.detailed, drafts: hs.drafts }, heroes: top }, 'application/json');
    }
    if (p === '/api/stats/import' && req.method === 'POST') {
      try {
        const name = decodeURIComponent(String(req.headers['x-filename'] || 'dashboard.xlsx'));
        const buf = await readRaw(req, 25 * 1024 * 1024);
        const { data, report } = ST.importDashboard(readXlsx(buf), heroes);
        ST.mergeImport(statsDb, data);
        statsDb.imports.push({ file: name, at: Date.now(), matches: report.matches, accounts: report.accounts });
        saveStats(); changed();
        return send(res, 200, { ok: true, report }, 'application/json');
      } catch (e) {
        return send(res, 400, { ok: false, error: e.message }, 'application/json');
      }
    }
    if (p === '/api/stats/sync' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}');
      if (statsSync.running) return send(res, 400, { ok: false, error: 'Already updating' }, 'application/json');
      syncOpenDota({ league: b.league !== false, force: !!b.force });
      return send(res, 200, { ok: true }, 'application/json');
    }
    if (p === '/api/nextmatch') return send(res, 200, resolveNextMatch(), 'application/json');
    // the /cam overlay reports how each cam is doing; the control panel reads it
    if (p === '/api/playercam/status' && req.method === 'POST' && url.searchParams.get('src') === 'team') {
      try { const b = JSON.parse((await readBody(req, 2e5)) || '{}'); noH264(b); teamCamStatus = { at: Date.now(), cams: Array.isArray(b.cams) ? b.cams.slice(0, 4) : [], error: String(b.error || '').slice(0, 300), showing: String(b.showing || '').slice(0, 40), up: Number(b.up) || 0 }; }
      catch { return send(res, 400, { ok: false }, 'application/json'); }
      return send(res, 200, { ok: true }, 'application/json');
    }
    if (p === '/api/playercam/status' && req.method === 'POST') {
      try { const b = JSON.parse((await readBody(req, 2e5)) || '{}'); noH264(b); camStatus = { at: Date.now(), cams: Array.isArray(b.cams) ? b.cams.slice(0, 20) : [], error: String(b.error || '').slice(0, 300), showing: String(b.showing || '').slice(0, 40), silhouette: String(b.silhouette || '').slice(0, 40), up: Number(b.up) || 0, sources: (camStatus.sources || 0) }; }
      catch { return send(res, 400, { ok: false }, 'application/json'); }
      return send(res, 200, { ok: true }, 'application/json');
    }
    if (p === '/api/playercam/status') return send(res, 200, { ...camStatus, age: camStatus.at ? Date.now() - camStatus.at : null, selection: camSelection(), team: { ...teamCamStatus, age: teamCamStatus.at ? Date.now() - teamCamStatus.at : null } }, 'application/json');
    if (p === '/api/bracket' && req.method === 'GET') {
      const t = activeTournament();
      return send(res, 200, { tournament: { id: t.id, name: t.name, isDefault: isDefaultT(t) }, tournaments: tournaments.list.map((x) => ({ id: x.id, name: x.name })),
        formats: Object.entries(BF.FORMATS).map(([id, f]) => ({ id, label: f.label })),
        bracket: rawBracket(t), live: liveBracketNow(), teams: teamDb.map((x) => x.name) }, 'application/json');
    }
    if (p === '/api/bracket' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req, 1e6)) || '{}');
        if (body.remove) { writeBracket(null); statsVersion++; changed(); return send(res, 200, { ok: true }, 'application/json'); }
        const b = body.bracket;
        if (!b || !Array.isArray(b.matches)) throw new UserError('No bracket sent');
        if (!b.matches.length) throw new UserError('Bracket needs at least one match');
        const str = (v, n) => String(v ?? '').trim().slice(0, n);
        const score = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.min(9, Math.round(Number(v)))));
        const ids = new Set();
        const clean = {
          ...(rawBracket() || {}),
          year: Number(b.year) || new Date().getFullYear(), timezone: str(b.timezone, 8) || 'WIB', format: BF.FORMATS[b.format] ? b.format : 'custom',
          autoAdvance: b.autoAdvance !== false, autoScores: b.autoScores === true,
          matches: b.matches.slice(0, 64).map((m, i) => {
            let id = Number(m.id) || i + 1; while (ids.has(id)) id++; ids.add(id);
            return { id, round: str(m.round, 40), date: str(m.date, 10), time: str(m.time, 8), bo: [1, 2, 3, 5, 7].includes(Number(m.bo)) ? Number(m.bo) : 3,
              a: { name: str(m.a?.name, 40) || 'TBD', score: score(m.a?.score) }, b: { name: str(m.b?.name, 40) || 'TBD', score: score(m.b?.score) },
              ...(m.live ? { live: true } : {}) };
          }),
        };
        delete clean.live;
        writeBracket(clean);
        statsVersion++; changed();                     // stat-card panels refresh their thumbnails
        return send(res, 200, { ok: true }, 'application/json');
      } catch (e) {
        return send(res, e instanceof UserError ? 400 : 500, { ok: false, error: e.message }, 'application/json');
      }
    }
    if (p === '/api/stats/export.xlsx') {
      const buf = statsWorkbook();
      const day = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
      const fname = `${activeTournament().name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'turnamen'}-stats-${day}.xlsx`;
      res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${fname}"`, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
      return res.end(buf);
    }
    if (p === '/api/stats/accounts') return send(res, 200, accountSuggestions(), 'application/json');
    if (p === '/api/stats/link' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req));
      let n = 0;
      for (const l of b.links || []) {
        const t = teamDb.find((x) => x.id === l.teamId);
        const acc = ST.toAccountId(l.accountId);
        if (!t || !acc || !Number.isInteger(l.index) || l.index < 0 || l.index >= MAX_PLAYERS || !t.players[l.index]) continue;
        linkAccount(acc, t, l.index);
        if (b.fillRoles && !t.roles[l.index]) t.roles[l.index] = seedRole(t.name, t.players[l.index]) || '';
        n++;
      }
      saveTeamDb();
      for (const side of SIDES) { const t = teamDb.find((x) => x.id === state.teams[side].dbId); if (t) loadTeamToSide(side, t, true); }
      changed();
      return send(res, 200, { ok: true, linked: n }, 'application/json');
    }
    if (p === '/api/stats/unlink' && req.method === 'POST') {
      const acc = ST.toAccountId(JSON.parse(await readBody(req)).accountId);
      for (const x of teamDb) x.accountIds = x.accountIds.map((v) => ST.idsOf(v).filter((a) => a !== acc).join(','));
      saveTeamDb(); changed();
      return send(res, 200, { ok: true }, 'application/json');
    }
    if (p === '/api/stats/create-teams' && req.method === 'POST') {
      const r = createSeedTeams(); changed();
      return send(res, 200, { ok: true, ...r }, 'application/json');
    }
    if (p === '/api/stats/delete-match' && req.method === 'POST') {
      const id = String(JSON.parse(await readBody(req)).matchId || '');
      if (statsDb.matches[id]) { delete statsDb.matches[id]; saveStats(); changed(); }
      return send(res, 200, { ok: true }, 'application/json');
    }
    if (p === '/api/tournaments') {
      return send(res, 200, { active: tournaments.active, list: tournaments.list.map((t) => ({ id: t.id, name: t.name, theme: t.theme || 'battlecup', isDefault: t.file === DEFAULT_STATS, matches: t.id === tournaments.active ? Object.keys(statsDb.matches).length : Object.keys((readJSON(path.join(ROOT, 'data', t.file), {}) || {}).matches || {}).length })) }, 'application/json');
    }
    if (p.startsWith('/api/tournaments/') && req.method === 'POST') {
      try {
        const b = JSON.parse((await readBody(req)) || '{}');
        const op = p.slice('/api/tournaments/'.length);
        let id = b.id;
        if (op === 'create') id = createTournament(b.name, b.theme);
        else if (op === 'switch') switchTournament(b.id);
        else if (op === 'delete') deleteTournament(b.id);
        else if (op === 'theme') {
          const t = tournaments.list.find((x) => x.id === b.id);
          if (!t) throw new UserError('Unknown tournament');
          if (!THEMES.includes(b.theme)) throw new UserError('Unknown design');
          t.theme = b.theme; saveTournaments();
        } else if (op === 'rename') {
          const t = tournaments.list.find((x) => x.id === b.id), name = String(b.name || '').trim().slice(0, 60);
          if (!t) throw new UserError('Unknown tournament'); if (!name) throw new UserError('Give the tournament a name');
          t.name = name; saveTournaments(); statsCache = null; statsVersion++;
        }
        else return send(res, 404, { ok: false, error: 'Unknown action' }, 'application/json');
        changed();
        return send(res, 200, { ok: true, id, active: tournaments.active }, 'application/json');
      } catch (e) {
        return send(res, e instanceof UserError ? 400 : 500, { ok: false, error: e.message }, 'application/json');
      }
    }
    if (p === '/api/stats/add-match' && req.method === 'POST') {
      try {
        const b = JSON.parse((await readBody(req)) || '{}');
        const r = await addMatchById(b.matchId, { createTeams: b.createTeams !== false, loadTeams: !!b.loadTeams });
        return send(res, 200, { ok: true, ...r }, 'application/json');
      } catch (e) {
        return send(res, e instanceof UserError ? 400 : 500, { ok: false, error: e.message }, 'application/json');
      }
    }
    if (p === '/api/stats/label' && req.method === 'POST') {
      const label = String(JSON.parse(await readBody(req)).label || '').trim().slice(0, 40);
      if (label) { statsDb.label = label; saveStats(); changed(); }
      return send(res, 200, { ok: true }, 'application/json');
    }

    if (p === '/api/sounds') {
      // public/sounds/heroes/<hero>.(mp3|ogg|wav|m4a) = name call per hero
      // public/sounds/pick.* and ban.* = generic stings (fallback)
      const out = { heroes: {}, pick: null, ban: null };
      const isAudio = (f) => /\.(mp3|ogg|wav|m4a|webm)$/i.test(f);
      try { for (const f of await fsp.readdir(path.join(PUBLIC_DIR, 'sounds', 'heroes'))) if (isAudio(f)) out.heroes[f.replace(/\.[^.]+$/, '').toLowerCase()] = 'heroes/' + f; } catch {}
      try { for (const f of await fsp.readdir(path.join(PUBLIC_DIR, 'sounds'))) { const b = f.replace(/\.[^.]+$/, '').toLowerCase(); if (isAudio(f) && (b === 'pick' || b === 'ban')) out[b] = f; } } catch {}
      // public/sounds/sfx/<name>.* = animation sound effects; your own mp3/ogg/m4a replaces the bundled .wav of the same name
      out.sfx = {};
      try {
        const files = (await fsp.readdir(path.join(PUBLIC_DIR, 'sounds', 'sfx'))).filter(isAudio).sort((x, y) => (/\.wav$/i.test(y) ? 1 : 0) - (/\.wav$/i.test(x) ? 1 : 0));
        for (const f of files) { const b = f.replace(/\.[^.]+$/, '').toLowerCase(); if (!out.sfx[b]) out.sfx[b] = 'sfx/' + f; }
      } catch {}
      return send(res, 200, out, 'application/json');
    }
    if (p === '/api/custom-media') {
      // public/heroes/<hero-slug>.(mp4|webm|png|jpg|webp) -> used full-frame instead of Valve art
      const out = {};
      try {
        for (const f of await fsp.readdir(path.join(PUBLIC_DIR, 'heroes'))) {
          const m = /^([a-z0-9_]+)\.(mp4|webm|png|jpe?g|webp)$/i.exec(f);
          if (!m) continue;
          const slug = m[1].toLowerCase();
          const isVideo = /mp4|webm/i.test(m[2]);
          if (!out[slug] || (isVideo && !out[slug].video)) out[slug] = { file: f, video: isVideo };
        }
      } catch {}
      return send(res, 200, out, 'application/json');
    }

    if (p === '/api/action' && req.method === 'POST') {
      try {
        act(JSON.parse(await readBody(req)));
        return send(res, 200, { ok: true }, 'application/json');
      } catch (e) {
        return send(res, e instanceof UserError ? 400 : 500, { ok: false, error: e.message }, 'application/json');
      }
    }

    if (p === '/api/gsi-last') {
      if (!fs.existsSync(GSI_LAST_FILE)) return send(res, 404, 'No GSI data received yet');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="gsi-last.json"' });
      return res.end(fs.readFileSync(GSI_LAST_FILE));
    }
    if (p === '/gsi' && req.method === 'POST') {
      const raw = await readBody(req, 8e6);
      const body = parseLooseJSON(raw);
      const token = config.gsi?.token;
      if (token && body?.auth?.token !== token) {
        gsiDiag.rejected++; gsiDiag.lastRejectAt = Date.now(); gsiDiag.lastRejectToken = String(body?.auth?.token ?? '(none)').slice(0, 40);
        if (gsiDiag.rejected === 1) console.log(`  GSI data rejected: the .cfg token is "${gsiDiag.lastRejectToken}", not the GSI_TOKEN secret`);
        throttledStatus();
        return send(res, 401, 'bad token');
      }
      const first = !gsiLastAt;
      gsiLastAt = Date.now();
      if (first) console.log('  Receiving Dota 2 GSI data');
      noteGsi(body, parseGsiPlayers(body));            // the GSI check always shows what arrives right now
      const delay = (Number(state.gsiDelay) || 0) * 1000;
      if (delay > 0) { queueGsi(raw); throttledStatus(); }
      else processGsi(body);
      return send(res, 200, 'ok');
    }

    const img = /^\/img\/(icon|render|anim)\/([a-z0-9_]+)$/.exec(p);
    if (img) {
      const [, kind, slug] = img;
      const [prefix, ext, type] = IMG_KINDS[kind];
      try {
        const r = await fetch(CDN + prefix + slug + ext, { cf: { cacheTtl: 604800, cacheEverything: true } });
        if (!r.ok) return send(res, 404, 'image unavailable');
        return res.respond(new Response(r.body, { status: 200, headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=604800', 'Access-Control-Allow-Origin': '*' } }));
      } catch {
        return send(res, 404, 'image unavailable');
      }
    }

    return send(res, 404, 'Not found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, 'Server error');
  }
};


// ---- apply one GSI message (now, or later when the anti-snipe delay is on) ----
const draftPickCount = (body) => {
  const d = body && body.draft; let n = 0;
  if (d) for (const t of [d.team2, d.team3]) for (const [k, v] of Object.entries(t || {})) if (/^pick\d+_id$/.test(k) && Number(v) > 0) n++;
  return n;
};
function processGsi(body) {
  const players = parseGsiPlayers(body);
  if (players) gsiPlayers = players;
  let dirty = !!players && autoTeamsFromGsi();             // sides first, so the draft below lands on the right team
  if (state.mode === 'gsi' && applyGsi(body)) dirty = true;
  snapshotDraft(body);
  if (players && state.mode === 'gsi' && !draftPickCount(body) && fillPicksFromHeroes(players)) { gsiDiag.heroFallback = true; dirty = true; }
  if (players) {
    gsiPlayers = players; gsiPlayersAt = Date.now();
    if (autoAssignFromGsi()) dirty = true;
    if (recordFinishedGame(body)) dirty = true;
    // push immediately when the observer switches hero; live stats at most every 1.5s
    const card = cardData();
    const cs = camSelection();
    const sig = (card ? card.key + '|' + card.heroId : '') + '|' + (cs ? cs.name : '');
    if (sig !== lastCardSig) { lastCardSig = sig; dirty = true; }
    else if (Date.now() - lastStatsPush > 1500) { lastStatsPush = Date.now(); broadcast(); }
  }
  if (dirty) changed();
  else throttledStatus();
}
// anti-snipe: hold every GSI message for state.gsiDelay seconds. Each message is the full game state,
// so messages less than 250 ms apart are merged (the later one wins) to keep memory low.
const gsiQueue = [];
function queueGsi(raw) {
  const now = Date.now(), last = gsiQueue[gsiQueue.length - 1];
  if (last && now - last.at < 250) last.raw = raw;
  else gsiQueue.push({ at: now, raw });
  if (gsiQueue.length > 4000) gsiQueue.splice(0, gsiQueue.length - 4000);
}
setInterval(() => {
  const delay = (Number(state.gsiDelay) || 0) * 1000, now = Date.now();
  let latest = null;
  while (gsiQueue.length && gsiQueue[0].at + delay <= now) latest = gsiQueue.shift();
  if (latest) { try { processGsi(parseLooseJSON(latest.raw)); } catch (e) { console.error('GSI', e.message); } }
}, 100);

let statusTimer = null;
let lastCardSig = '';
let camStatus = { at: 0, cams: [], error: '', showing: '' };
let teamCamStatus = { at: 0, cams: [], error: '', showing: '' };
let lastStatsPush = 0;
// an OBS cam source got H.264 frames but can't decode them: switch every sender back to VP8 (they reconnect within ~15 s)
function noH264(b) {
  const c = state.playerCam;
  if (b.h264 !== false || c.codec !== 'h264') return;
  c.codec = 'vp8'; c.codecNote = 'Otomatis pindah ke VP8: OBS ini tidak bisa decode H.264 (' + new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB).';
  changed();
}
function throttledStatus() {
  if (statusTimer) return;
  statusTimer = setTimeout(() => { statusTimer = null; broadcast(); }, 2000);
}

/* ---- YouTube live chat -> /chatwalk (named SSE event "chat", so state listeners never see it) ---- */
function ytVideoId(v) {
  const s = String(v ?? '').trim(), m = s.match(/(?:v=|youtu\.be\/|\/live\/|\/shorts\/)([\w-]{11})/) || s.match(/^([\w-]{11})$/);
  return m ? m[1] : '';
}
function chatPush(msgs) {
  const line = `event: chat\ndata: ${JSON.stringify(msgs)}\n\n`;
  for (const res of clients) res.write(line);
}
let chatRun = 0;
async function chatLoop() {
  const run = ++chatRun, c = state.chat, key = platform.env && platform.env.YT_API_KEY;
  const say = (t) => { if (c.status !== t) { c.status = t; changed(); } };
  if (!c.on) return;
  if (!key) return say('YT_API_KEY belum diisi di Cloudflare (Worker → Settings → Variables and Secrets)');
  const api = (q) => fetch(`https://www.googleapis.com/youtube/v3/${q}&key=${key}`, { signal: AbortSignal.timeout(10000) }).then((r) => r.json());
  let chatId = '', token = '', first = true, video = '';
  while (run === chatRun && c.on) {
    let wait = 12000;   // ~5 quota units per poll: 12 s keeps a 10k/day key good for ~6 h of stream
    try {
      if (video !== c.video) { video = c.video; chatId = ''; token = ''; first = true; }
      if (!chatId) {
        const r = await api(`videos?part=liveStreamingDetails&id=${video}`);
        chatId = (r.items && r.items[0] && r.items[0].liveStreamingDetails && r.items[0].liveStreamingDetails.activeLiveChatId) || '';
        if (!chatId) { say(r.error ? 'YouTube: ' + r.error.message : 'Video ini tidak sedang live (atau live chat mati). Coba lagi tiap menit…'); wait = 60000; }
      }
      if (chatId && run === chatRun) {
        const r = await api(`liveChat/messages?liveChatId=${chatId}&part=snippet,authorDetails&maxResults=200${token ? '&pageToken=' + token : ''}`);
        if (r.error) {
          const why = (r.error.errors && r.error.errors[0] && r.error.errors[0].reason) || '';
          if (why === 'liveChatEnded') { c.on = false; say('Live chat sudah selesai, berhenti.'); break; }
          say('YouTube: ' + r.error.message); chatId = ''; wait = 60000;
        } else {
          token = r.nextPageToken || token;
          wait = Math.max(wait, Number(r.pollingIntervalMillis) || 0);
          const msgs = (r.items || []).filter((m) => m.authorDetails && m.snippet && m.snippet.displayMessage).map((m) => ({
            id: m.authorDetails.channelId, name: String(m.authorDetails.displayName || '').slice(0, 30), text: String(m.snippet.displayMessage).slice(0, 120) }));
          if (msgs.length) chatPush(first ? msgs.slice(-5) : msgs);   // the first page is the backlog: only its last few
          first = false;
          say('Tersambung ke live chat ✓');
        }
      }
    } catch (e) { say('Gagal menghubungi YouTube: ' + e.message); wait = 30000; }
    await sleep(wait);
  }
}

function start() {
  recomputeStep();
  chatLoop();
  try { autoSyncOfficialRoster(); changed(); } catch (e) { console.log('  Roster sync failed: ' + e.message); }
  refreshHeroes();
}

return { handler, start, broadcast, stateFor, dropClients: () => { for (const r of clients) { try { r.end(); } catch {} } clients.clear(); }, saveNow: () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1)) };
};
