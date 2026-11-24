'use strict';
/*
 * Reads an official roster sheet (columns TEAM | POSITION | ROLE | NAME | NICKNAME | STEAM ID,
 * like "Teams & Rosters" in "Direbattle CUP by Direborn Esports.xlsx").
 * TEAM is only filled on a team's first row; POSITION is Member / Captain / Standin / 1v1 mid.
 */
const { toAccountId } = require('./stats');

const ROLE_BY_NUMBER = { 1: 'carry', 2: 'mid', 3: 'offlane', 4: 'soft', 5: 'hard' };

function parseRosterBook(book) {
  for (const [sheetName, rows] of Object.entries(book)) {
    const hi = rows.findIndex((r) => r && r.some((c) => String(c ?? '').trim().toUpperCase() === 'NICKNAME') && r.some((c) => String(c ?? '').trim().toUpperCase() === 'STEAM ID'));
    if (hi < 0) continue;
    const col = {};
    rows[hi].forEach((c, i) => { const k = String(c ?? '').trim().toUpperCase(); if (k && !(k in col)) col[k] = i; });
    const get = (r, k) => (col[k] != null ? r[col[k]] : null);
    const teams = [];
    let cur = null;
    for (let i = hi + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const teamCell = String(get(r, 'TEAM') ?? '').trim();
      if (teamCell) { cur = { name: teamCell, players: [] }; teams.push(cur); }
      if (!cur) continue;
      const pos = String(get(r, 'POSITION') ?? '').trim().toLowerCase();
      const nick = String(get(r, 'NICKNAME') ?? '').trim();
      if (!nick || pos.startsWith('1v1')) continue;            // empty stand-in slot / 1v1 duplicate row
      const roleNo = Number(get(r, 'ROLE'));
      cur.players.push({
        nick,
        realName: String(get(r, 'NAME') ?? '').trim(),
        accountId: toAccountId(get(r, 'STEAM ID')),
        role: pos.startsWith('standin') || pos.startsWith('stand-in') ? 'standin' : ROLE_BY_NUMBER[roleNo] || '',
        captain: pos === 'captain',
        roleNo: Number.isFinite(roleNo) ? roleNo : null,
      });
    }
    if (teams.length) return { sheet: sheetName, teams };
  }
  throw new Error('No roster table found (needs columns TEAM, NICKNAME and STEAM ID)');
}

module.exports = { parseRosterBook };
