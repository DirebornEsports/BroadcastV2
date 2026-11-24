'use strict';
/*
 * Tournament statistics: import the Direbattle Cup dashboard (.xlsx), merge match details
 * from OpenDota and from games the overlay records itself, and compute per-hero stats.
 */

// ---------- name helpers ----------
const normKey = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const stripTagKey = (s) => normKey(String(s || '').replace(/^\s*[^.\s]{2,6}\.\s*/, ''));   // "ULAR.NotDrew" -> "notdrew"
function teamKeyMatch(a, b) {
  const x = normKey(a), y = normKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x));
}

// Accepts a Dota account ID or a Steam64 ID; returns the 32-bit Dota account ID as a string.
function toAccountId(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  if (!d) return '';
  try {
    const n = BigInt(d);
    if (n > 76561197960265728n) return String(n - 76561197960265728n);
    return String(n);
  } catch { return ''; }
}
const idsOf = (v) => String(v ?? '').split(/[\s,;/|]+/).map(toAccountId).filter(Boolean);

const HERO_ALIASES = { outworlddevourer: 'Outworld Destroyer', windrunner: 'Windranger', zeus: 'Zeus', lifestealer: 'Lifestealer', naturesprophet: "Nature's Prophet", treant: 'Treant Protector', centaur: 'Centaur Warrunner', clockwerk: 'Clockwerk', necrolyte: 'Necrophos', wraithking: 'Wraith King', io: 'Io', magnus: 'Magnus' };
function heroResolver(heroes) {
  const byKey = new Map(heroes.map((h) => [normKey(h.name), h]));
  return (name) => byKey.get(normKey(name)) || byKey.get(normKey(HERO_ALIASES[normKey(name)] || '')) || null;
}

// ---------- dashboard import ----------
const excelDate = (v) => (typeof v === 'number' ? Date.UTC(1899, 11, 30) + Math.round(v * 86400000) : null);
function headerTable(rows, firstHeader) {
  const hi = rows.findIndex((r) => r && String(r[0] ?? '').trim() === firstHeader);
  if (hi < 0) return null;
  const head = rows[hi].map((h) => String(h ?? '').trim());
  const out = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r[0] == null || String(r[0]).trim() === '') break;
    const o = {};
    head.forEach((h, j) => { if (h) o[h] = r[j]; });
    out.push(o);
  }
  return out;
}

function importDashboard(book, heroes) {
  const findHero = heroResolver(heroes);
  const report = { matches: 0, accounts: 0, teams: 0, unknownHeroes: [], warnings: [] };
  const sheet = (n) => book[Object.keys(book).find((k) => k.trim().toLowerCase() === n.toLowerCase())] || null;

  const out = { matches: {}, accounts: {}, teams: {}, leagueId: '', leagueName: '' };
  const games = sheet('Games') ? headerTable(sheet('Games'), 'Match ID') : null;
  if (!games) throw new Error('No "Games" sheet with a "Match ID" table found');
  for (const g of games) {
    const id = String(g['Match ID']).replace(/\D/g, '');
    if (!id) continue;
    const rad = String(g['Radiant team'] || '').trim(), dire = String(g['Dire team'] || '').trim();
    const sideOf = (name) => (!name ? null : name === rad ? 'radiant' : name === dire ? 'dire' : null);
    const naive = excelDate(g['Match ended (Asia/Jakarta)']);
    out.matches[id] = {
      matchId: id,
      endedTs: naive != null ? naive - 7 * 3600000 : null,
      duration: typeof g['Duration'] === 'number' ? Math.round(g['Duration'] * 86400) : null,
      radiant: { name: rad, teamId: String(g['Radiant team ID'] || '') },
      dire: { name: dire, teamId: String(g['Dire team ID'] || '') },
      winner: sideOf(String(g['Winner'] || '').trim()),
      firstPick: sideOf(String(g['First-pick team'] || '').trim()),
      kills: { radiant: Number(g['Radiant player kills']) || 0, dire: Number(g['Dire player kills']) || 0 },
      deaths: { radiant: Number(g['Radiant deaths']) || 0, dire: Number(g['Dire deaths']) || 0 },
      assists: { radiant: Number(g['Radiant assists']) || 0, dire: Number(g['Dire assists']) || 0 },
      gpm: { radiant: Number(g['Radiant team GPM']) || 0, dire: Number(g['Dire team GPM']) || 0 },
      xpm: { radiant: Number(g['Radiant team XPM']) || 0, dire: Number(g['Dire team XPM']) || 0 },
      picksBans: null, players: null, sources: ['xlsx'],
    };
    if (!out.leagueId && g['League ID']) { out.leagueId = String(g['League ID']); out.leagueName = String(g['League name in source'] || ''); }
  }
  report.matches = Object.keys(out.matches).length;

  const players = sheet('Player Summary') ? headerTable(sheet('Player Summary'), 'Player name') : null;
  if (players) for (const p of players) {
    const acc = toAccountId(p['Stable account ID']);
    if (!acc) continue;
    const heroIds = {};
    for (const part of String(p['Heroes played (game counts)'] || '').split(';')) {
      const m = /^\s*(.+?)\s*\((\d+)\)\s*$/.exec(part);
      if (!m) continue;
      const h = findHero(m[1]);
      if (!h) { if (!report.unknownHeroes.includes(m[1])) report.unknownHeroes.push(m[1]); continue; }
      heroIds[h.id] = (heroIds[h.id] || 0) + Number(m[2]);
    }
    out.accounts[acc] = {
      accountId: acc, name: String(p['Player name'] || ''), team: String(p['Team(s)'] || ''),
      games: Number(p['Games']) || 0, wins: Number(p['Wins']) || 0, heroIds,
      kills: Number(p['Total kills']) || 0, deaths: Number(p['Total deaths']) || 0, assists: Number(p['Total assists']) || 0,
      avgGpm: Number(p['Average GPM']) || 0, avgXpm: Number(p['Average XPM']) || 0,
      lastHits: Number(p['Total last hits']) || 0, denies: Number(p['Total denies']) || 0, healing: Number(p['Total hero healing']) || 0,
      obsWards: Number(p['Observer wards placed']) || 0, sentryWards: Number(p['Sentry wards placed']) || 0, goldEarned: Number(p['Total gold earned']) || 0,
    };
  }
  report.accounts = Object.keys(out.accounts).length;

  const teams = sheet('Team Summary') ? headerTable(sheet('Team Summary'), 'Team') : null;
  if (teams) for (const t of teams) {
    const name = String(t['Team'] || '').trim();
    if (!name) continue;
    out.teams[name] = { name, games: Number(t['Games']) || 0, wins: Number(t['Wins']) || 0, losses: Number(t['Losses']) || 0, avgKills: Number(t['Average kills']) || 0, avgGpm: Number(t['Average team GPM']) || 0 };
  }
  // team IDs from the games table
  for (const m of Object.values(out.matches)) for (const s of ['radiant', 'dire']) {
    const t = out.teams[m[s].name]; if (t && m[s].teamId) t.teamId = m[s].teamId;
  }
  report.teams = Object.keys(out.teams).length;
  if (!report.accounts) report.warnings.push('No "Player Summary" table found — hero pick counts need it.');
  return { data: out, report };
}

// merge an import into the database (by match ID / account ID; never deletes)
function mergeImport(db, data) {
  for (const [id, m] of Object.entries(data.matches)) {
    const cur = db.matches[id];
    if (!cur) { db.matches[id] = m; continue; }
    for (const k of ['endedTs', 'duration', 'winner', 'firstPick', 'kills', 'deaths', 'assists', 'gpm', 'xpm']) if (m[k] != null && cur[k] == null) cur[k] = m[k];
    for (const s of ['radiant', 'dire']) { if (m[s].name) cur[s].name = m[s].name; if (m[s].teamId) cur[s].teamId = m[s].teamId; }
    if (!cur.sources.includes('xlsx')) cur.sources.push('xlsx');
  }
  Object.assign(db.accounts, data.accounts);
  Object.assign(db.teams, data.teams);
  if (data.leagueId) { db.leagueId = data.leagueId; db.leagueName = data.leagueName; }
}

// ---------- OpenDota ----------
function fromOpenDota(j) {
  if (!j || !j.match_id) return null;
  const players = (j.players || []).map((p) => ({
    accountId: p.account_id != null ? String(p.account_id) : '',
    name: p.personaname || p.name || '',
    side: (p.isRadiant != null ? p.isRadiant : p.player_slot < 128) ? 'radiant' : 'dire',
    heroId: Number(p.hero_id) || null,
    kills: +p.kills || 0, deaths: +p.deaths || 0, assists: +p.assists || 0,
    gpm: +p.gold_per_min || 0, xpm: +p.xp_per_min || 0, lastHits: +p.last_hits || 0,
    heroDamage: +p.hero_damage || 0, netWorth: +p.net_worth || 0,
  }));
  const picksBans = Array.isArray(j.picks_bans) && j.picks_bans.length
    ? j.picks_bans.map((x) => ({ heroId: Number(x.hero_id), isPick: !!x.is_pick, side: x.team === 0 ? 'radiant' : 'dire', order: Number(x.order) || 0 }))
    : null;
  const firstPickEntry = picksBans ? [...picksBans].filter((x) => x.isPick).sort((a, b) => a.order - b.order)[0] : null;
  return {
    matchId: String(j.match_id),
    endedTs: j.start_time ? (j.start_time + (j.duration || 0)) * 1000 : null,
    duration: j.duration || null,
    radiant: { name: j.radiant_team?.name || j.radiant_name || '', teamId: j.radiant_team_id ? String(j.radiant_team_id) : '' },
    dire: { name: j.dire_team?.name || j.dire_name || '', teamId: j.dire_team_id ? String(j.dire_team_id) : '' },
    winner: j.radiant_win === true ? 'radiant' : j.radiant_win === false ? 'dire' : null,
    firstPick: firstPickEntry ? firstPickEntry.side : null,
    picksBans, players: players.length ? players : null,
  };
}
// fill a match with detail from OpenDota or the overlay without losing names the dashboard gave it
function mergeDetail(db, m, source) {
  const cur = db.matches[m.matchId];
  if (!cur) { db.matches[m.matchId] = { ...m, sources: [source] }; return; }
  for (const k of ['endedTs', 'duration', 'winner', 'firstPick']) if (cur[k] == null && m[k] != null) cur[k] = m[k];
  for (const s of ['radiant', 'dire']) {
    if (!cur[s].name && m[s].name) cur[s].name = m[s].name;
    if (!cur[s].teamId && m[s].teamId) cur[s].teamId = m[s].teamId;
  }
  if (m.picksBans) cur.picksBans = m.picksBans;
  if (m.players) cur.players = m.players;
  if (!cur.sources.includes(source)) cur.sources.push(source);
}

// ---------- hero stats ----------
function computeHeroStats(db, nameOf = (acc, fallback) => fallback) {
  const ms = Object.values(db.matches);
  const total = ms.length;
  const detailed = ms.filter((m) => m.players && m.players.length);
  const withDraft = ms.filter((m) => m.picksBans && m.picksBans.length);
  const xlsxIds = new Set(ms.filter((m) => m.sources.includes('xlsx')).map((m) => m.matchId));
  const xlsxDetailed = [...xlsxIds].every((id) => db.matches[id].players && db.matches[id].players.length);
  const useAggregate = xlsxIds.size > 0 && !xlsxDetailed && Object.keys(db.accounts || {}).length > 0;

  const H = {};
  const get = (id) => (H[id] ||= { picks: 0, bans: 0, wins: 0, winBase: 0, n: 0, k: 0, d: 0, a: 0, gpm: 0, xpm: 0, players: {} });
  const addPlayer = (s, acc, name, games) => {
    const key = acc || 'n:' + name;
    const label = nameOf(acc, name);
    (s.players[key] ||= { name: label, games: 0 }).games += games;
  };

  for (const m of detailed) {
    const countPick = !(useAggregate && xlsxIds.has(m.matchId));
    for (const p of m.players) {
      if (!p.heroId) continue;
      const s = get(p.heroId);
      if (countPick) { s.picks++; addPlayer(s, p.accountId, p.name, 1); }
      if (m.winner) { s.winBase++; if (p.side === m.winner) s.wins++; }
      s.n++; s.k += p.kills; s.d += p.deaths; s.a += p.assists; s.gpm += p.gpm; s.xpm += p.xpm;
    }
  }
  if (useAggregate) {
    for (const acc of Object.values(db.accounts)) for (const [hid, n] of Object.entries(acc.heroIds || {})) {
      const s = get(Number(hid)); s.picks += n; addPlayer(s, acc.accountId, acc.name, n);
    }
  }
  for (const m of withDraft) for (const x of m.picksBans) if (!x.isPick && x.heroId) get(x.heroId).bans++;

  const heroesOut = {};
  for (const [id, s] of Object.entries(H)) {
    heroesOut[id] = {
      picks: s.picks, pickBase: total,
      bans: s.bans, banBase: withDraft.length,
      contestBase: withDraft.length,
      wins: s.wins, winBase: s.winBase,
      avg: s.n ? { kills: s.k / s.n, deaths: s.d / s.n, assists: s.a / s.n, gpm: s.gpm / s.n, xpm: s.xpm / s.n, games: s.n } : null,
      players: Object.values(s.players).sort((a, b) => b.games - a.games),
    };
  }
  return { matches: total, detailed: detailed.length, drafts: withDraft.length, heroes: heroesOut };
}

module.exports = { normKey, stripTagKey, teamKeyMatch, toAccountId, idsOf, importDashboard, mergeImport, fromOpenDota, mergeDetail, computeHeroStats, heroResolver };
