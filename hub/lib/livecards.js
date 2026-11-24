'use strict';
/*
 * Live stat cards: built from the active tournament's statistics every time a card is requested,
 * in the same shape as the hand-written cards in data/statcards.json (templates fact / player / team).
 *
 *   buildLiveCards({ db, teamDb, heroName, heroStats, rosterByAccount, bracket, tournament })
 *     -> { groups: [...], cards: [...] }
 *
 * Numbers come from the dashboard import (player / team totals) plus every match with full detail
 * (OpenDota, or games the overlay recorded through GSI). Panel texts are written from rankings, so
 * each card leads with what that player or team does best.
 */
const ST = require('./stats');

// ---------- Indonesian number formatting ----------
function fmt(n, dec = 0) {
  if (!Number.isFinite(n)) return '–';
  const neg = n < 0; n = Math.abs(n);
  let [i, f] = n.toFixed(dec).split('.');
  i = i.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (neg ? '-' : '') + i + (f ? ',' + f : '');
}
const fmt1 = (n) => fmt(n, Math.abs(n - Math.round(n)) < 0.05 ? 0 : 1);
const pctTxt = (x) => fmt(Math.round(x * 100)) + '%';
function dur(sec) {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function durWords(sec) {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return [h ? `${h} jam` : '', m ? `${m} menit` : '', s ? `${s} detik` : ''].filter(Boolean).join(' ') || '0 detik';
}
const WORDS = ['nol', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan', 'sepuluh'];
const word = (n) => WORDS[n] || String(n);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const listId = (arr) => (arr.length <= 1 ? arr.join('') : arr.slice(0, -1).join(', ') + ' dan ' + arr[arr.length - 1]);
const kFmt = (n) => (n >= 1000 ? fmt(Math.round(n / 1000)) + 'K' : fmt(n));
const slug = (s) => ST.normKey(s).slice(0, 40) || 'x';

// rank: 1 = best; ties share a rank (1, 1, 3)
function ranker(items, val, desc = true) {
  const v = items.map((x) => ({ x, v: val(x) })).filter((o) => Number.isFinite(o.v));
  v.sort((a, b) => (desc ? b.v - a.v : a.v - b.v));
  const r = new Map();
  v.forEach((o, i) => { r.set(o.x, i > 0 && o.v === v[i - 1].v ? r.get(v[i - 1].x) : i + 1); });
  return { rank: (x) => r.get(x) || null, size: v.length, sorted: v.map((o) => o.x) };
}

function buildLiveCards(ctx) {
  const { db, teamDb = [], heroName = (id) => '#' + id, heroStats, rosterByAccount, bracket, tournament = 'Turnamen' } = ctx;
  const matches = Object.values(db.matches || {}).filter((m) => m && m.radiant && m.dire);
  const useAgg = (db.imports || []).length > 0;          // a dashboard import holds the player totals

  // ---------- teams: one canonical name per team (dashboard / OpenDota spellings differ) ----------
  const canonCache = new Map();
  function canon(name) {
    name = String(name || '').trim();
    if (!name) return null;
    if (canonCache.has(name)) return canonCache.get(name);
    const dbt = teamDb.find((t) => ST.normKey(t.name) === ST.normKey(name)) || teamDb.find((t) => ST.teamKeyMatch(t.name, name));
    const c = { key: slug(dbt ? dbt.name : name), name: dbt ? dbt.name : name, db: dbt || null };
    canonCache.set(name, c);
    return c;
  }

  // ---------- team table from the matches ----------
  const T = new Map();
  const team = (c) => T.get(c.key) || T.set(c.key, { ...c, games: 0, wins: 0, losses: 0, kills: 0, deaths: 0, assists: 0, assistsN: 0, durSum: 0, durN: 0, winDur: [], lossDur: [],
    fpG: 0, fpW: 0, spG: 0, spW: 0, radG: 0, radW: 0, direG: 0, direW: 0, h2h: new Map(), wins_: [], games_: [] }).get(c.key);
  const sideKills = (m, side) => (m.kills && m.kills[side] != null ? m.kills[side] : m.players ? m.players.filter((p) => p.side === side).reduce((a, p) => a + p.kills, 0) : null);
  for (const m of matches) {
    if (!m.winner) continue;
    for (const side of ['radiant', 'dire']) {
      const other = side === 'radiant' ? 'dire' : 'radiant';
      const c = canon(m[side].name), o = canon(m[other].name);
      if (!c || !o) continue;
      const t = team(c), won = m.winner === side;
      t.games++; won ? t.wins++ : t.losses++;
      const kf = sideKills(m, side), ka = sideKills(m, other);
      if (kf != null) t.kills += kf;
      t.deaths += m.deaths && m.deaths[side] != null ? m.deaths[side] : ka || 0;
      if (m.assists && m.assists[side] != null) { t.assists += m.assists[side]; t.assistsN++; }
      if (m.duration) { t.durSum += m.duration; t.durN++; (won ? t.winDur : t.lossDur).push(m.duration); }
      if (m.firstPick) { if (m.firstPick === side) { t.fpG++; if (won) t.fpW++; } else { t.spG++; if (won) t.spW++; } }
      if (side === 'radiant') { t.radG++; if (won) t.radW++; } else { t.direG++; if (won) t.direW++; }
      const h = t.h2h.get(o.key) || t.h2h.set(o.key, { name: o.name, w: 0, l: 0 }).get(o.key);
      won ? h.w++ : h.l++;
      const g = { m, won, opp: o.name, kf, ka, duration: m.duration };
      t.games_.push(g); if (won) t.wins_.push(g);
    }
  }
  const teams = [...T.values()].filter((t) => t.games);
  for (const t of teams) {
    t.kpg = t.kills / t.games; t.dpg = t.deaths / t.games; t.apg = t.assistsN ? t.assists / t.assistsN : null;
    t.avgDur = t.durN ? t.durSum / t.durN : null; t.wr = t.wins / t.games;
  }

  // ---------- players: dashboard totals + matches with full detail, merged per roster player ----------
  const P = new Map();
  function playerOf(acc, name, teamName) {
    let r = acc ? rosterByAccount(acc) : null;
    if (!r) {                                   // not linked by Steam ID: same name on the same team counts as the same player
      const c0 = canon(teamName);
      const i = c0 && c0.db ? c0.db.players.findIndex((n) => n && (ST.normKey(n) === ST.normKey(name) || ST.stripTagKey(n) === ST.stripTagKey(name))) : -1;
      if (i >= 0) r = { team: c0.db, index: i };
    }
    const key = r ? `r-${r.team.id}-${r.index}` : 'a-' + (acc || slug(name));
    if (P.has(key)) { if (acc) P.get(key).accounts.add(acc); return P.get(key); }
    const c = canon(r ? r.team.name : teamName);
    const p = { key, name: r ? r.team.players[r.index] || name : name, teamKey: c ? c.key : '', team: c ? c.name : String(teamName || ''),
      photo: r ? (r.team.photos || [])[r.index] || '' : '', captain: !!(r && r.team.captain === r.index),
      games: 0, wins: 0, kills: 0, deaths: 0, assists: 0, gpmSum: 0, xpmSum: 0, heroes: {}, lastHits: 0, denies: 0, healing: 0, wards: 0,
      dmg: 0, dmgGames: 0, accounts: new Set(acc ? [acc] : []) };
    P.set(key, p);
    return p;
  }
  const fromAgg = new Set();
  if (useAgg) for (const a of Object.values(db.accounts || {})) {
    if (!a.games) continue;
    const p = playerOf(a.accountId, a.name, String(a.team || '').split(/[,;/]/)[0]);
    p.games += a.games; p.wins += a.wins || 0; p.kills += a.kills || 0; p.deaths += a.deaths || 0; p.assists += a.assists || 0;
    p.gpmSum += (a.avgGpm || 0) * a.games; p.xpmSum += (a.avgXpm || 0) * a.games;
    p.lastHits += a.lastHits || 0; p.denies += a.denies || 0; p.healing += a.healing || 0; p.wards += (a.obsWards || 0) + (a.sentryWards || 0);
    for (const [hid, n] of Object.entries(a.heroIds || {})) p.heroes[hid] = (p.heroes[hid] || 0) + n;
    fromAgg.add(a.accountId);
  }
  for (const m of matches) {
    if (!m.players || !m.players.length) continue;
    const dashGame = useAgg && (m.sources || []).includes('xlsx');
    for (const x of m.players) {
      const p = playerOf(x.accountId, x.name || 'Player', m[x.side] && m[x.side].name);
      if (x.heroDamage) { p.dmg += x.heroDamage; p.dmgGames++; }
      if (dashGame && fromAgg.has(x.accountId)) continue;             // already in the dashboard totals
      p.games++; if (m.winner === x.side) p.wins++;
      p.kills += x.kills || 0; p.deaths += x.deaths || 0; p.assists += x.assists || 0;
      p.gpmSum += x.gpm || 0; p.xpmSum += x.xpm || 0; p.lastHits += x.lastHits || 0;
      if (x.heroId) p.heroes[x.heroId] = (p.heroes[x.heroId] || 0) + 1;
    }
  }
  const players = [...P.values()].filter((p) => p.games > 0);
  for (const p of players) {
    p.kda = (p.kills + p.assists) / Math.max(1, p.deaths);
    p.gpm = p.gpmSum / p.games; p.xpm = p.xpmSum / p.games;
    p.kpg = p.kills / p.games; p.dpg = p.deaths / p.games; p.apg = p.assists / p.games;
    const t = T.get(p.teamKey);
    p.share = t && t.kpg ? Math.min(1, p.kills / (t.kpg * p.games)) : null;
    p.hasDmg = p.dmgGames > 0 && p.dmgGames >= p.games;
    p.heroList = Object.entries(p.heroes).sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ name: heroName(Number(id)), n }));
  }
  // per-game rankings only among players with enough games
  const minG = players.filter((p) => p.games >= 2).length >= 10 ? 2 : 1;
  const pool = players.filter((p) => p.games >= minG);
  const R = {
    kda: ranker(pool, (p) => p.kda), kills: ranker(players, (p) => p.kills), gpm: ranker(pool, (p) => p.gpm), dpg: ranker(pool, (p) => p.dpg, false),
    assists: ranker(players, (p) => p.assists), share: ranker(pool, (p) => p.share), kpg: ranker(pool, (p) => p.kpg),
    healing: ranker(players.filter((p) => p.healing > 0), (p) => p.healing), wards: ranker(players.filter((p) => p.wards > 0), (p) => p.wards),
    lastHits: ranker(players.filter((p) => p.lastHits > 0), (p) => p.lastHits), dmg: ranker(players.filter((p) => p.hasDmg), (p) => p.dmg),
  };
  const RT = {
    wr: ranker(teams, (t) => t.wr), kpg: ranker(teams, (t) => t.kpg), dpg: ranker(teams, (t) => t.dpg, false),
    fast: ranker(teams.filter((t) => t.avgDur), (t) => t.avgDur, false), long: ranker(teams.filter((t) => t.avgDur), (t) => t.avgDur), apg: ranker(teams.filter((t) => t.apg != null), (t) => t.apg),
  };

  // ---------- bracket: where each team stands, and its next match ----------
  const B = bracket && Array.isArray(bracket.matches) ? bracket : null;
  const bms = B ? B.matches.map((m) => {
    const need = Math.ceil((Number(m.bo) || 3) / 2);
    const winner = Number(m.a?.score) >= need ? 'a' : Number(m.b?.score) >= need ? 'b' : null;
    const [dd, mm] = String(m.date || '').split('/').map(Number), [hh, mi] = String(m.time || '').split(/[.:]/).map(Number);
    const ts = dd && mm ? new Date(Number(B.year) || 2026, mm - 1, dd, hh || 0, mi || 0).getTime() : Infinity;
    return { ...m, winner, ts, ak: canon(m.a?.name)?.key, bk: canon(m.b?.name)?.key };
  }).sort((x, y) => x.ts - y.ts) : [];
  function standing(key) {
    const mine = bms.filter((m) => m.ak === key || m.bk === key);
    const next = mine.find((m) => !m.winner);
    const zone = (r) => (/grand/i.test(r) ? 'Grand Final' : /lower/i.test(r) ? 'Lower Bracket' : /upper/i.test(r) ? 'Upper Bracket' : '');
    if (next) {
      const opp = next.ak === key ? next.b?.name : next.a?.name;
      const when = next.date ? `${next.date}${next.time ? ' · ' + next.time + ' ' + (B.timezone || 'WIB') : ''}` : 'jadwal menyusul';
      return { zone: zone(next.round), next: `${next.round} · ${when} · vs ${!opp || /^tbd$/i.test(opp) ? 'TBD' : opp}` };
    }
    const last = mine.filter((m) => m.winner).pop();
    if (last) {
      const won = (last.winner === 'a') === (last.ak === key);
      if (/grand/i.test(last.round) || /^\s*final\s*$/i.test(last.round)) return { zone: won ? 'Juara' : 'Runner-up' };
      const hasLower = bms.some((m) => /lower/i.test(m.round || ''));
      if (!won && (/lower/i.test(last.round) || !hasLower)) return { zone: 'Tersingkir' };
      return { zone: zone(last.round) };
    }
    return { zone: '' };
  }

  const event = tournament;
  const cards = [];
  const groups = [{ id: 'live-fakta', label: 'Fakta turnamen · live' }, { id: 'live-tim', label: 'Tim · live' }];
  const N = players.length;

  // ================= tournament facts =================
  const done = matches.filter((m) => m.winner);
  if (done.length) {
    const durs = done.filter((m) => m.duration);
    const totalKills = done.reduce((a, m) => a + (sideKills(m, 'radiant') || 0) + (sideKills(m, 'dire') || 0), 0);
    const avgDur = durs.length ? durs.reduce((a, m) => a + m.duration, 0) / durs.length : null;
    const longest = durs.slice().sort((a, b) => b.duration - a.duration)[0], shortest = durs.slice().sort((a, b) => a.duration - b.duration)[0];
    const vs = (m) => `${canon(m.radiant.name)?.name} melawan ${canon(m.dire.name)?.name}`;
    const kpgT = totalKills / done.length;
    cards.push({ id: 'live-angka-utama', group: 'live-fakta', button: 'Angka utama', template: 'fact', live: true, event, title: 'Angka Utama',
      tiles: [
        { value: fmt(done.length), label: 'Game dimainkan' }, { value: fmt(teams.length), label: 'Tim' }, { value: fmt(N), label: 'Pemain' },
        { value: fmt(totalKills), label: 'Total kill pemain' }, { value: avgDur ? dur(avgDur) : '–', label: 'Rata-rata durasi' },
        { value: longest ? dur(longest.duration) : '–', label: 'Game terpanjang' }, { value: shortest ? dur(shortest.duration) : '–', label: 'Game terpendek' },
        { value: fmt(kpgT, 1), label: 'Rata-rata kill / game' }],
      note: `Sejauh ini sudah ${fmt(done.length)} game dimainkan oleh ${teams.length} tim dan ${N} pemain, dengan total ${fmt(totalKills)} kill pemain, rata-rata ${fmt(kpgT, 1)} kill per game.` +
        (avgDur ? ` Rata-rata durasi game ${durWords(avgDur)}; game terpanjang ${durWords(longest.duration)} dan game terpendek ${durWords(shortest.duration)}.` : '') });

    const topK = R.kills.sorted.slice(0, 5);
    if (topK.length) {
      const [a, b, c] = topK;
      cards.push({ id: 'live-top-fragger', group: 'live-fakta', button: 'Top fragger', template: 'fact', live: true, event, title: 'Top Fragger Turnamen', barSize: 'lg',
        bars: topK.map((p, i) => ({ label: p.name, sub: `${p.team} · ${p.games} game`, value: p.kills, color: i < 3 ? 'gold' : 'green' })),
        note: `Top fragger turnamen adalah ${a.name} dari ${a.team} dengan ${a.kills} kill` + (b ? `, disusul ${b.name} dari ${b.team} dengan ${b.kills}` : '') + (c ? `, dan ${c.name} dari ${c.team} dengan ${c.kills}` : '') + '.' +
          (b ? ` Selisih dua teratas ${a.kills - b.kills === 0 ? 'nol, alias sama kuat' : a.kills - b.kills === 1 ? 'cuma satu kill' : (a.kills - b.kills) + ' kill'}.` : '') +
          ` ${a.name} rata-rata ${fmt(a.kpg, 1)} kill per game.` });
    }
    const topKda = R.kda.sorted.slice(0, 5);
    if (topKda.length >= 3) cards.push({ id: 'live-top-kda', group: 'live-fakta', button: 'KDA tertinggi', template: 'fact', live: true, event, title: 'KDA Tertinggi', barSize: 'lg',
      bars: topKda.map((p, i) => ({ label: p.name, sub: `${p.team} · ${p.games} game`, value: p.kda, display: fmt(p.kda, 2), color: i < 3 ? 'gold' : 'green' })),
      note: `KDA dihitung dari (kill + assist) ÷ death${minG > 1 ? `, untuk pemain dengan minimal ${minG} game` : ''}. ${topKda[0].name} memimpin dengan KDA ${fmt(topKda[0].kda, 2)}: ${topKda[0].kills} kill, ${topKda[0].assists} assist dan cuma ${topKda[0].deaths} death.` });
    const topGpm = R.gpm.sorted.slice(0, 5);
    if (topGpm.length >= 3) cards.push({ id: 'live-top-gpm', group: 'live-fakta', button: 'GPM tertinggi', template: 'fact', live: true, event, title: 'GPM Tertinggi', barSize: 'lg',
      bars: topGpm.map((p, i) => ({ label: p.name, sub: `${p.team} · ${p.heroList.slice(0, 2).map((h) => h.name).join(', ')}`, value: p.gpm, display: fmt(p.gpm), color: i < 3 ? 'gold' : 'green' })),
      note: `${topGpm[0].name} dari ${topGpm[0].team} punya farm paling deras di turnamen dengan GPM rata-rata ${fmt(topGpm[0].gpm)}, disusul ${topGpm[1].name} (${fmt(topGpm[1].gpm)}) dan ${topGpm[2].name} (${fmt(topGpm[2].gpm)}).` });

    const hs = heroStats && heroStats.heroes ? Object.entries(heroStats.heroes).filter(([, x]) => x.picks > 0).sort((a, b) => b[1].picks - a[1].picks) : [];
    if (hs.length) {
      const top = hs.slice(0, 9), totalPicks = hs.reduce((a, [, x]) => a + x.picks, 0), max = top[0][1].picks;
      const leaders = top.filter(([, x]) => x.picks === max).map(([id]) => heroName(Number(id)));
      const second = top.filter(([, x]) => x.picks < max);
      const n2 = second.length ? second[0][1].picks : 0;
      const tier2 = second.filter(([, x]) => x.picks === n2).map(([id]) => heroName(Number(id)));
      cards.push({ id: 'live-hero-pick', group: 'live-fakta', button: 'Hero paling dipick', template: 'fact', live: true, event, title: 'Hero Paling Sering Dipick', barSize: 'sm',
        bars: top.map(([id, x], i) => ({ label: heroName(Number(id)), value: x.picks, color: x.picks === max || i < 4 ? 'gold' : 'green' })),
        note: `Dari ${fmt(totalPicks)} pick pemain, muncul ${hs.length} hero berbeda. ${listId(leaders)} paling sering dipick, ${max} kali.` + (tier2.length ? ` ${listId(tier2)} menyusul dengan ${n2} pick.` : '') });
    }
    const radW = done.filter((m) => m.winner === 'radiant').length, direW = done.length - radW;
    cards.push({ id: 'live-radiant-dire', group: 'live-fakta', button: 'Radiant vs Dire', template: 'fact', live: true, event, title: 'Keunggulan Sisi: Radiant vs Dire', barSize: 'xl',
      bars: [{ label: 'Radiant', sub: `menang ${radW} dari ${done.length}`, value: radW / done.length * 100, display: fmt(radW / done.length * 100, 1) + '%', color: 'green' },
             { label: 'Dire', sub: `menang ${direW} dari ${done.length}`, value: direW / done.length * 100, display: fmt(direW / done.length * 100, 1) + '%', color: 'red' }],
      note: `Radiant menang ${radW} dari ${done.length} game, atau ${fmt(radW / done.length * 100, 1)} persen, sementara Dire menang ${direW} game, ${fmt(direW / done.length * 100, 1)} persen. ` +
        (Math.abs(radW - direW) <= 1 ? 'Sejauh ini kedua sisi hampir seimbang.' : `Sejauh ini sisi ${radW > direW ? 'Radiant' : 'Dire'} punya keunggulan yang cukup jelas.`) });
    const fp = done.filter((m) => m.firstPick);
    if (fp.length) {
      const fpW = fp.filter((m) => m.firstPick === m.winner).length, spW = fp.length - fpW;
      cards.push({ id: 'live-first-second', group: 'live-fakta', button: 'First vs second pick', template: 'fact', live: true, event, title: 'First Pick vs Second Pick', barSize: 'xl',
        bars: [{ label: 'First Pick', sub: `menang ${fpW} dari ${fp.length}`, value: fpW / fp.length * 100, display: fmt(fpW / fp.length * 100, 1) + '%', color: fpW >= spW ? 'gold' : 'green' },
               { label: 'Second Pick', sub: `menang ${spW} dari ${fp.length}`, value: spW / fp.length * 100, display: fmt(spW / fp.length * 100, 1) + '%', color: spW > fpW ? 'gold' : 'green' }],
        note: `Tim yang mendapat first pick menang ${fpW} dari ${fp.length} game, atau ${fmt(fpW / fp.length * 100, 1)} persen. Tim second pick menang ${spW} dari ${fp.length}, atau ${fmt(spW / fp.length * 100, 1)} persen. ` +
          (fpW === spW ? 'Sejauh ini urutan pick belum menentukan.' : `Sejauh ini ${spW > fpW ? 'memilih belakangan' : 'memilih duluan'} terbukti lebih menguntungkan.`) });
    }
    if (durs.length) {
      const b1 = durs.filter((m) => m.duration < 1800).length, b2 = durs.filter((m) => m.duration >= 1800 && m.duration <= 2700).length, b3 = durs.length - b1 - b2;
      const mx = Math.max(b1, b2, b3);
      cards.push({ id: 'live-durasi', group: 'live-fakta', button: 'Durasi game', template: 'fact', live: true, event, title: 'Durasi Game', barSize: 'md',
        bars: [['< 30 menit', b1], ['30–45 menit', b2], ['> 45 menit', b3]].map(([l, v]) => ({ label: l, value: v, display: `${v} game`, color: v === mx ? 'gold' : 'green' })),
        note: `Rata-rata satu game berlangsung ${durWords(avgDur)}. Ada ${b1} game di bawah 30 menit, ${b2} game di rentang 30 sampai 45 menit, dan ${b3} game lebih dari 45 menit. ` +
          `Game terpendek cuma ${durWords(shortest.duration)}, ${vs(shortest)}. Game terpanjang ${durWords(longest.duration)}, ${vs(longest)}.` });
    }
  }

  // ================= teams =================
  const bestOf = (arr) => arr.filter(Boolean).sort((a, b) => a.score - b.score);
  for (const t of teams.slice().sort((a, b) => b.wr - a.wr || b.wins - a.wins || a.name.localeCompare(b.name))) {
    const st = standing(t.key);
    const facts = [];
    const unbeaten = teams.filter((x) => x.losses === 0 && x.wins > 0);
    if (t.losses === 0 && t.wins > 0) facts.push({ score: 0.5, title: 'Tak terkalahkan', short: unbeaten.length === 1 ? 'Satu-satunya tim yang belum pernah kalah' : 'Belum pernah kalah',
      text: `${unbeaten.length === 1 ? 'Satu-satunya tim yang' : 'Tim yang'} **belum pernah kalah**: menang ${t.wins} dari ${t.games} game.` +
        (t.fpG && t.spG ? ` Menang ${t.fpW} dari ${t.fpG} saat first pick dan ${t.spW} dari ${t.spG} saat second pick.` : '') });
    else { const r = RT.wr.rank(t); facts.push({ score: t.wins === 0 ? 40 : r + 2, title: t.wins === 0 ? 'Masih mencari kemenangan' : 'Rekor sejauh ini',
      short: `${t.wins} menang dari ${t.games} game`, text: `Menang **${t.wins} dari ${t.games}** game (${pctTxt(t.wr)})${t.wins ? `, peringkat #${r} dari ${teams.length} tim` : ''}.` }); }
    { const r = RT.kpg.rank(t); facts.push({ score: r, title: r === 1 ? 'Tim paling agresif' : 'Haus kill', short: r === 1 ? `Rata-rata ${fmt1(t.kpg)} kill per game, tertinggi` : `${fmt1(t.kpg)} kill per game`,
      text: `Rata-rata **${fmt1(t.kpg)} kill per game**, ${r === 1 ? 'tertinggi dari semua tim' : `peringkat #${r} dari ${teams.length} tim`}. Total **${fmt(t.kills)} kill** sejauh ini.` }); }
    { const r = RT.dpg.rank(t); facts.push({ score: r + 0.3, title: 'Paling jarang mati', short: `Cuma ${fmt1(t.dpg)} death per game`,
      text: `Rata-rata cuma **${fmt1(t.dpg)} death per game**, ${r === 1 ? 'terendah dari semua tim' : `#${r} paling sedikit dari ${teams.length} tim`}, sementara kill-nya rata-rata ${fmt1(t.kpg)}.` }); }
    if (t.avgDur) {
      const rf = RT.fast.rank(t), rl = RT.long.rank(t);
      if (rf <= rl) facts.push({ score: rf + 0.6, title: rf === 1 ? 'Tim paling cepat' : 'Main cepat', short: `Rata-rata game ${dur(t.avgDur)}${rf === 1 ? ', tercepat di turnamen' : ''}`,
        text: `Rata-rata game cuma **${durWords(t.avgDur)}**, ${rf === 1 ? 'tercepat di turnamen' : `#${rf} tercepat dari ${teams.length} tim`}.` + (t.winDur.length ? ` Rata-rata saat menang **${durWords(t.winDur.reduce((a, b) => a + b, 0) / t.winDur.length)}**.` : '') });
      else facts.push({ score: rl + 0.6, title: rl === 1 ? 'Raja maraton' : 'Tahan lama', short: `Rata-rata game ${dur(t.avgDur)}${rl === 1 ? ', terpanjang di turnamen' : ''}`,
        text: `Rata-rata durasi game **${durWords(t.avgDur)}**, ${rl === 1 ? 'terpanjang dari semua tim' : `#${rl} terpanjang dari ${teams.length} tim`}.` + (t.lossDur.length && t.winDur.length ? ` Saat menang rata-rata ${dur(t.winDur.reduce((a, b) => a + b, 0) / t.winDur.length)}, saat kalah ${dur(t.lossDur.reduce((a, b) => a + b, 0) / t.lossDur.length)}.` : '') });
    }
    if (t.apg != null) { const r = RT.apg.rank(t); if (r <= 2) facts.push({ score: r + 0.8, title: 'Teamwork tertinggi', short: `${fmt1(t.apg)} assist per game`,
      text: `Rata-rata **${fmt1(t.apg)} assist per game**, ${r === 1 ? 'tertinggi dari semua tim' : `#${r} dari ${teams.length} tim`}.` }); }
    const fw = t.wins_.filter((g) => g.duration).sort((a, b) => a.duration - b.duration)[0];
    if (fw) {
      const shortestAll = matches.filter((m) => m.duration && m.winner).sort((a, b) => a.duration - b.duration)[0];
      const isRecord = shortestAll && shortestAll === fw.m;
      facts.push({ score: isRecord ? 1.2 : 9, title: isRecord ? 'Game tercepat turnamen' : 'Kemenangan tercepat', short: `Menang dalam ${durWords(fw.duration)}`,
        text: `Kemenangan atas ${fw.opp} cuma **${durWords(fw.duration)}**` + (fw.kf != null && fw.ka != null ? `, dengan skor kill **${fw.kf} lawan ${fw.ka}**.` : '.') });
    }
    const mates = players.filter((p) => p.teamKey === t.key);
    const star = mates.filter((p) => p.share != null).sort((a, b) => b.share - a.share)[0];
    if (star) facts.push({ score: R.share.rank(star) ? R.share.rank(star) + 1.5 : 12, title: 'Kunci tim', short: `${star.name} memegang ${pctTxt(star.share)} kill tim`,
      text: `**${star.name}** memegang **${Math.round(star.share * 100)} persen** kill ${t.name}, dengan ${star.kills} kill dalam ${star.games} game.` });
    const chosen = bestOf(facts).slice(0, 3);
    const h2h = [...t.h2h.values()].sort((a, b) => (b.w + b.l) - (a.w + a.l)).slice(0, 2);
    const panels = [chosen[0], h2h.length ? { title: 'Head-to-head', tiles: h2h.map((h) => ({ value: `${h.w}–${h.l}`, label: 'vs ' + h.name })) } : null, chosen[1], chosen[2]].filter(Boolean)
      .map((f) => (f.tiles ? f : { title: f.title, text: f.text }));
    const groupsL = [{ title: 'Rata-rata per game', bars: [{ label: 'Kill', value: t.kpg, display: fmt1(t.kpg), color: 'gold' }, { label: 'Death', value: t.dpg, display: fmt1(t.dpg), color: 'red' }] }];
    if (t.fpG || t.spG) groupsL.push({ title: 'Menang per urutan pick', bars: [
      { label: 'First pick', value: t.fpW, max: Math.max(1, t.fpG), display: `${t.fpW} dari ${t.fpG}`, color: 'gold' },
      { label: 'Second pick', value: t.spW, max: Math.max(1, t.spG), display: `${t.spW} dari ${t.spG}`, color: 'gold' }] });
    else if (t.avgDur) groupsL.push({ title: 'Rata-rata durasi game', bars: [{ label: t.name, value: t.avgDur, display: dur(t.avgDur), color: 'gold' }] });
    cards.push({ id: 'live-team-' + t.key, group: 'live-tim', button: t.name, template: 'team', live: true, event,
      name: t.name, pill: `${t.wins} Menang · ${t.losses} Kalah`, bracket: st.zone, record: `${t.wins}–${t.losses}`, groups: groupsL, panels,
      keyLabel: st.next ? 'Berikutnya' : 'Kalimat kunci', key: st.next || (chosen[0] ? chosen[0].short + '.' : '') });
  }

  // ================= players (grouped by team) =================
  const teamOrder = teams.slice().sort((a, b) => b.wr - a.wr || a.name.localeCompare(b.name)).map((t) => t.key);
  const pGroups = new Map();
  for (const p of players.slice().sort((a, b) => (teamOrder.indexOf(a.teamKey) + 1 || 99) - (teamOrder.indexOf(b.teamKey) + 1 || 99) || b.kills - a.kills)) {
    const gid = 'live-p-' + (p.teamKey || 'lain');
    if (!pGroups.has(gid)) { pGroups.set(gid, true); groups.push({ id: gid, label: 'Pemain · ' + (p.team || 'Lainnya') + ' · live' }); }
    const facts = [];
    const add = (rk, f) => { if (rk) facts.push({ ...f, score: rk + (f.bias || 0) }); };
    const nPool = R.kda.size;
    let r = R.kda.rank(p);
    add(r, { metric: 'kda', title: r === 1 ? 'KDA nomor satu' : `KDA #${r} turnamen`, short: r === 1 ? `KDA terbaik dari ${nPool} pemain` : `KDA #${r} dari ${nPool} pemain`,
      text: `KDA **${fmt(p.kda, 2)}**, ${r === 1 ? 'tertinggi' : `peringkat **#${r}**`} dari **${nPool} pemain**, dari ${p.kills} kill dan ${p.assists} assist.` });
    r = R.kills.rank(p);
    add(r, { metric: 'kills', title: r === 1 ? 'Top fragger turnamen' : r <= 3 ? 'Mesin kill' : 'Pencetak kill', short: r === 1 ? `${p.kills} kill, terbanyak di turnamen` : `${p.kills} kill, #${r} di turnamen`,
      text: `**${p.kills} kill**, ${r === 1 ? 'terbanyak dari semua pemain' : `terbanyak #${r} di turnamen`}, rata-rata **${fmt(p.kpg, 1)} kill per game**.` });
    r = R.gpm.rank(p);
    add(r, { metric: 'gpm', bias: 0.2, title: r === 1 ? 'GPM tertinggi turnamen' : 'Farm deras', short: r === 1 ? 'GPM tertinggi di seluruh turnamen' : `GPM ${fmt(p.gpm)}, #${r} di turnamen`,
      text: `GPM rata-rata **${fmt(p.gpm)}**, ${r === 1 ? 'tertinggi dari seluruh pemain di turnamen ini' : `peringkat **#${r}** dari ${R.gpm.size} pemain`}.` });
    r = R.dpg.rank(p);
    add(r, { metric: 'dpg', bias: 0.4, title: r === 1 ? 'Paling jarang mati' : 'Hampir tak tersentuh', short: `Cuma mati ${fmt(p.dpg, 1)} kali per game`,
      text: `Cuma mati **${p.deaths} kali dalam ${p.games} game**, rata-rata ${fmt(p.dpg, 1)} per game${r <= 3 ? ', termasuk yang paling jarang mati di turnamen' : ''}.` });
    r = R.assists.rank(p);
    add(r, { metric: 'assists', bias: 0.5, title: r === 1 ? 'Raja assist' : 'Selalu ada di teamfight', short: r === 1 ? `${p.assists} assist, terbanyak di turnamen` : `${p.assists} assist, #${r} di turnamen`,
      text: `**${p.assists} assist**, ${r === 1 ? 'terbanyak dari semua pemain' : `terbanyak #${r} di turnamen`}, rata-rata ${fmt(p.apg, 1)} per game.` });
    if (p.share != null) { r = R.share.rank(p);
      add(r, { metric: 'share', bias: 0.3, title: r === 1 ? 'Porsi kill tertinggi' : 'Tulang punggung kill', short: `Memegang ${pctTxt(p.share)} kill tim`,
        text: `Memegang **${Math.round(p.share * 100)} persen** kill ${p.team}${r === 1 ? ', tertinggi dari semua pemain' : ''}.` }); }
    if (p.healing > 0) { r = R.healing.rank(p); if (r <= 3) add(r, { bias: 0.7, title: 'Penyelamat tim', short: `${fmt(p.healing)} healing, ${r === 1 ? 'terbanyak' : '#' + r} di turnamen`, text: `**${fmt(p.healing)} healing** ke rekan setim, ${r === 1 ? 'terbanyak di turnamen' : `#${r} di turnamen`}.` }); }
    if (p.wards > 0) { r = R.wards.rank(p); if (r <= 3) add(r, { bias: 0.7, title: 'Penjaga vision', short: `${p.wards} ward, ${r === 1 ? 'terbanyak' : '#' + r} di turnamen`, text: `**${p.wards} ward** dipasang, ${r === 1 ? 'terbanyak di turnamen' : `#${r} di turnamen`}.` }); }
    if (p.lastHits > 0) { r = R.lastHits.rank(p); if (r <= 3) add(r, { bias: 0.8, title: 'Farm monster', short: `${fmt(p.lastHits)} last hit, ${r === 1 ? 'terbanyak' : '#' + r} di turnamen`, text: `**${fmt(p.lastHits)} last hit**, ${r === 1 ? 'terbanyak di turnamen' : `#${r} di turnamen`}, rata-rata ${fmt(p.lastHits / p.games)} per game.` }); }
    if (p.hasDmg) { r = R.dmg.rank(p); add(r, { bias: 0.1, title: r === 1 ? 'Raja damage' : 'Hero damage besar', short: `Hero damage ${kFmt(p.dmg)}, ${r === 1 ? 'tertinggi' : '#' + r} di turnamen`, text: `Hero damage sekitar **${kFmt(p.dmg).replace('K', ' ribu')}**, ${r === 1 ? 'tertinggi di turnamen' : `#${r} di turnamen`}.` }); }
    const mates0 = players.filter((x) => x.teamKey && x.teamKey === p.teamKey);
    if (mates0.length >= 3) for (const [m, label, unit, val, fmtv] of [['kills', 'kill', 'kill', (x) => x.kills, fmt], ['assists', 'assist', 'assist', (x) => x.assists, fmt],
      ['gpm', 'GPM', '', (x) => x.gpm, (v) => fmt(v)], ['kda', 'KDA', '', (x) => x.kda, (v) => fmt(v, 2)]]) {
      const tr = ranker(mates0.filter((x) => x.games >= Math.min(minG, p.games)), val).rank(p);
      const gr = R[m].rank(p);
      if (tr === 1 && (!gr || gr > 3)) facts.push({ score: 5 + ['kills', 'assists', 'gpm', 'kda'].indexOf(m) * 0.5, metric: m,
        title: `${label === 'kill' ? 'Pencetak kill' : label === 'assist' ? 'Raja assist' : label === 'GPM' ? 'Farm terbaik' : 'KDA terbaik'} ${p.team}`,
        short: `${unit ? fmtv(val(p)) + ' ' + unit : label + ' ' + fmtv(val(p))}, tertinggi di ${p.team}`,
        text: `${unit ? `**${fmtv(val(p))} ${unit}**` : `${label} **${fmtv(val(p))}**`}, tertinggi di antara pemain ${p.team}${gr ? ` dan #${gr} di turnamen` : ''}.` });
    }
    if (p.wins === p.games && p.games >= 2) facts.push({ score: 1.5, title: 'Belum pernah kalah', short: `Menang ${p.wins} dari ${p.games} game`, text: `Menang **${p.wins} dari ${p.games}** game yang dimainkan.` });
    const uniq = p.heroList.length;
    facts.push({ score: 30, title: `${cap(word(p.games))} game, ${word(uniq)} hero`, short: `${uniq} hero dalam ${p.games} game`,
      text: uniq === 1 ? `Setia dengan **${p.heroList[0].name}** di semua ${p.games} game.` : `${listId(p.heroList.map((h) => (h.n > 1 ? `${h.name} (${h.n}×)` : h.name)))}.` });
    const seen = new Set();
    const chosen = bestOf(facts).filter((f) => { const k = f.metric || f.title; if (seen.has(k)) return false; seen.add(k); return true; });
    const text3 = chosen.slice(0, 3);
    // chart: the player's best stat against teammates
    const lead = chosen.find((f) => ['kda', 'kills', 'gpm', 'assists', 'share'].includes(f.metric));
    const metric = lead ? lead.metric : 'kills';
    const M = { kda: ['KDA', (x) => x.kda, (v) => fmt(v, 2)], kills: ['Kill', (x) => x.kills, (v) => fmt(v)], gpm: ['GPM', (x) => x.gpm, (v) => fmt(v)],
      assists: ['Assist', (x) => x.assists, (v) => fmt(v)], share: ['Porsi kill', (x) => x.share || 0, (v) => Math.round(v * 100) + '%'] }[metric];
    const mates = players.filter((x) => x.teamKey === p.teamKey && x.teamKey).sort((a, b) => M[1](b) - M[1](a)).slice(0, 4);
    if (!mates.includes(p)) mates.splice(3, 1, p);
    const chart = { title: `${M[0]} ${p.team || 'tim'}`, bars: mates.map((x) => ({ label: x.name, value: M[1](x), display: M[2](M[1](x)), color: x === p ? 'gold' : 'green' })) };
    const stats = [
      { value: fmt(p.games), label: 'Game' }, { value: fmt(p.kills), label: 'Kill', hl: R.kills.rank(p) <= 3 },
      { value: fmt(p.deaths), label: 'Death', hl: R.dpg.rank(p) <= 3 }, { value: fmt(p.assists), label: 'Assist', hl: R.assists.rank(p) <= 3 },
      { value: fmt(p.kda, 2), label: 'KDA', hl: R.kda.rank(p) <= 3 }, { value: fmt(p.gpm), label: 'Avg GPM', hl: R.gpm.rank(p) <= 3 },
      p.hasDmg ? { value: fmt(p.dmg), label: 'Hero damage', hl: R.dmg.rank(p) <= 3 } : (() => {
        // the support / core stat this player ranks best in
        const opts = [['lastHits', 'Last hit', p.lastHits], ['healing', 'Healing', p.healing], ['wards', 'Ward dipasang', p.wards]]
          .filter(([, , v]) => v > 0).map(([k, l, v]) => ({ k, l, v, r: R[k].rank(p) / Math.max(1, R[k].size) }));
        const best = opts.sort((x, y) => x.r - y.r)[0];
        return best ? { value: fmt(best.v), label: best.l, hl: R[best.k].rank(p) <= 3 } : { value: Math.round(p.wins / p.games * 100) + '%', label: 'Win rate' };
      })(),
      p.share != null ? { value: Math.round(p.share * 100) + '%', label: 'Porsi kill tim', hl: R.share.rank(p) <= 3 } : { value: Math.round(p.wins / p.games * 100) + '%', label: 'Win rate' },
    ];
    const st = standing(p.teamKey);
    let pid = 'live-player-' + slug(p.name) + '-' + slug(p.team || 'x'); while (cards.some((c) => c.id === pid)) pid += '-2';
    cards.push({ id: pid, group: gid, button: p.name, template: 'player', live: true, event, photo: p.photo,
      name: p.name, team: (p.team || '').toUpperCase(), bracket: st.zone, stats,
      heroes: p.heroList.slice(0, 6).map((h) => (h.n > 1 ? `${h.name} ×${h.n}` : h.name)),
      panels: [text3[0], text3[1], text3[2], chart].filter(Boolean).map((f) => (f.bars ? f : { title: f.title, text: f.text })),
      keyLabel: 'Kalimat kunci', key: text3.slice(0, 2).map((f) => cap(f.short)).join('. ') + '.' });
  }
  return { groups, cards, tables: { players, teams, R, minG } };
}

// ================= live bracket =================
// who goes where (W = winner of match n, L = loser of match n), per bracket format
const BF = require('../public/bracket-formats');
const isTbd = (n) => !n || /^tbd$/i.test(String(n).trim());
const isBye = (n) => /^bye$/i.test(String(n || "").trim());
/**
 * Fill the bracket from the games in the statistics: each series score is counted from the games the two
 * teams played (in date order, so a rematch later in the bracket gets the later games), winners and losers
 * move on to their next match, and the series being played right now is marked live.
 * Scores and names typed by hand are kept where the statistics have nothing yet.
 */
function liveBracket({ bracket, db, teamDb = [], liveTeams = null }) {
  if (!bracket || !Array.isArray(bracket.matches)) return bracket;
  const canonKey = (name) => {
    if (isTbd(name)) return null;
    const t = teamDb.find((x) => ST.normKey(x.name) === ST.normKey(name)) || teamDb.find((x) => ST.teamKeyMatch(x.name, name));
    return ST.normKey(t ? t.name : name);
  };
  const year = Number(bracket.year) || new Date().getFullYear();
  const tsOf = (m) => {
    const [dd, mm] = String(m.date || '').split('/').map(Number), [hh, mi] = String(m.time || '').split(/[.:]/).map(Number);
    return dd && mm ? Date.UTC(year, mm - 1, dd, (hh || 0) - 7, mi || 0) : null;     // bracket times are WIB (UTC+7)
  };
  // games per pair of teams, oldest first
  const pairGames = new Map();
  for (const g of Object.values(db.matches || {}).filter((x) => x.winner).sort((x, y) => (x.endedTs || 0) - (y.endedTs || 0))) {
    const ka = canonKey(g.radiant?.name), kb = canonKey(g.dire?.name);
    if (!ka || !kb) continue;
    const pk = [ka, kb].sort().join('|');
    (pairGames.get(pk) || pairGames.set(pk, []).get(pk)).push({ g, winKey: g.winner === 'radiant' ? ka : kb });
  }
  const used = new Set();
  const useStats = bracket.autoScores === true;              // fill empty scores from the statistics (off unless turned on)
  const feeds = bracket.autoAdvance === false ? {} : BF.feeds(bracket.format || 'double-elimination-8');
  const out = [];
  const byId = new Map();
  for (const m0 of [...bracket.matches].sort((x, y) => x.id - y.id)) {
    const m = { ...m0, a: { ...(m0.a || {}) }, b: { ...(m0.b || {}) } };
    const need = Math.ceil((Number(m.bo) || 3) / 2);
    for (const side of ['a', 'b']) {                       // fill TBD from the match that feeds this slot
      const f = feeds[m.id] && feeds[m.id][side];
      const src = f && byId.get(f[1]);
      if (src && src.winnerSide && isTbd(m[side].name)) {
        const ws = src.winnerSide, ls = ws === 'a' ? 'b' : 'a';
        m[side].name = src[f[0] === 'W' ? ws : ls].name; m[side].auto = true;
      }
    }
    const ka = canonKey(m.a.name), kb = canonKey(m.b.name);
    const typed = m0.a?.score != null || m0.b?.score != null;   // a score typed in the editor always wins
    if (ka && kb && useStats && !typed) {
      const list = pairGames.get([ka, kb].sort().join('|')) || [];
      const start = tsOf(m);
      let wa = 0, wb = 0, n = 0;
      for (const x of list) {
        if (used.has(x.g.matchId)) continue;
        if (start && x.g.endedTs && x.g.endedTs < start - 6 * 3600000) continue;     // a game from before this series
        if (wa >= need || wb >= need) break;
        used.add(x.g.matchId); n++;
        if (x.winKey === ka) wa++; else wb++;
      }
      if (n) { m.a.score = wa; m.b.score = wb; m.fromStats = n; }
    }
    m.winnerSide = Number(m.a.score) >= need ? 'a' : Number(m.b.score) >= need ? 'b' : null;
    // a bye: the real team goes through without a game (and the "Bye" drops to the lower bracket, which it then loses too)
    if (!m.winnerSide && isBye(m.b.name) && !isTbd(m.a.name) && !isBye(m.a.name)) m.winnerSide = 'a';
    else if (!m.winnerSide && isBye(m.a.name) && !isTbd(m.b.name) && !isBye(m.b.name)) m.winnerSide = 'b';
    if (!m.winnerSide && ka && kb && liveTeams) {
      const lk = liveTeams.map(canonKey);
      if (lk.includes(ka) && lk.includes(kb)) m.live = true;
    }
    byId.set(m.id, m);
    out.push(m);
  }
  return { ...bracket, matches: out, live: true };
}

module.exports = { buildLiveCards, liveBracket };
