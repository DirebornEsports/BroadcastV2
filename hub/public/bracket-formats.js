// Bracket formats, shared by the server (live bracket), the bracket editor and the bracket stat card.
// feeds: who goes into each slot — ['W', n] = winner of match n, ['L', n] = loser of match n.
(function (root) {
  const F = (id, round, a, b) => ({ id, round, a, b });
  const FORMATS = {
    // 16 slots (Byes allowed), numbered like the Direbattle Uprising bracket: upper round 1 = 1-8, lower round 1 = 9-12 ...
    'double-elimination-16': { label: 'Double elimination · 16 tim', teams: 16, matches: [
      F(1, 'Upper Round 1'), F(2, 'Upper Round 1'), F(3, 'Upper Round 1'), F(4, 'Upper Round 1'),
      F(5, 'Upper Round 1'), F(6, 'Upper Round 1'), F(7, 'Upper Round 1'), F(8, 'Upper Round 1'),
      F(9, 'Lower Round 1', ['L', 1], ['L', 2]), F(10, 'Lower Round 1', ['L', 3], ['L', 4]),
      F(11, 'Lower Round 1', ['L', 5], ['L', 6]), F(12, 'Lower Round 1', ['L', 7], ['L', 8]),
      F(13, 'Upper Quarterfinal', ['W', 1], ['W', 2]), F(14, 'Upper Quarterfinal', ['W', 3], ['W', 4]),
      F(15, 'Upper Quarterfinal', ['W', 5], ['W', 6]), F(16, 'Upper Quarterfinal', ['W', 7], ['W', 8]),
      F(17, 'Lower Round 2', ['L', 13], ['W', 9]), F(18, 'Lower Round 2', ['L', 14], ['W', 10]),
      F(19, 'Lower Round 2', ['L', 15], ['W', 11]), F(20, 'Lower Round 2', ['L', 16], ['W', 12]),
      F(21, 'Upper Semifinal', ['W', 13], ['W', 14]), F(22, 'Upper Semifinal', ['W', 15], ['W', 16]),
      F(23, 'Lower Round 3', ['W', 17], ['W', 18]), F(24, 'Lower Round 3', ['W', 19], ['W', 20]),
      F(25, 'Upper Final', ['W', 21], ['W', 22]),
      F(26, 'Lower Quarterfinal', ['L', 22], ['W', 23]), F(27, 'Lower Quarterfinal', ['L', 21], ['W', 24]),
      F(28, 'Lower Semifinal', ['W', 26], ['W', 27]), F(29, 'Lower Final', ['L', 25], ['W', 28]),
      F(30, 'Grand Final', ['W', 25], ['W', 29]) ] },
    'double-elimination-8': { label: 'Double elimination · 8 tim', teams: 8, matches: [
      F(1, 'Upper Quarterfinal'), F(2, 'Upper Quarterfinal'), F(3, 'Upper Quarterfinal'), F(4, 'Upper Quarterfinal'),
      F(5, 'Lower Round 1', ['L', 1], ['L', 2]), F(6, 'Lower Round 1', ['L', 3], ['L', 4]),
      F(7, 'Upper Semifinal', ['W', 1], ['W', 2]), F(8, 'Upper Semifinal', ['W', 3], ['W', 4]),
      F(9, 'Lower Quarterfinal', ['L', 8], ['W', 5]), F(10, 'Lower Quarterfinal', ['L', 7], ['W', 6]),
      F(11, 'Upper Final', ['W', 7], ['W', 8]), F(12, 'Lower Semifinal', ['W', 9], ['W', 10]),
      F(13, 'Lower Final', ['L', 11], ['W', 12]), F(14, 'Grand Final', ['W', 11], ['W', 13]) ] },
    'double-elimination-4': { label: 'Double elimination · 4 tim', teams: 4, matches: [
      F(1, 'Upper Semifinal'), F(2, 'Upper Semifinal'),
      F(3, 'Upper Final', ['W', 1], ['W', 2]), F(4, 'Lower Round 1', ['L', 1], ['L', 2]),
      F(5, 'Lower Final', ['L', 3], ['W', 4]), F(6, 'Grand Final', ['W', 3], ['W', 5]) ] },
    'single-elimination-8': { label: 'Single elimination · 8 tim', teams: 8, matches: [
      F(1, 'Quarterfinal'), F(2, 'Quarterfinal'), F(3, 'Quarterfinal'), F(4, 'Quarterfinal'),
      F(5, 'Semifinal', ['W', 1], ['W', 2]), F(6, 'Semifinal', ['W', 3], ['W', 4]), F(7, 'Final', ['W', 5], ['W', 6]) ] },
    'single-elimination-4': { label: 'Single elimination · 4 tim', teams: 4, matches: [
      F(1, 'Semifinal'), F(2, 'Semifinal'), F(3, 'Final', ['W', 1], ['W', 2]) ] },
    'single-match': { label: '1 match (2 tim / showmatch)', teams: 2, matches: [F(1, 'Final')] },
    'custom': { label: 'Bebas (daftar match sendiri)', teams: 0, matches: [F(1, 'Round 1')] },
  };
  // { matchId: { a: ['W', n], b: [...] } } for one format
  function feeds(format) {
    const f = FORMATS[format];
    const out = {};
    if (f) for (const m of f.matches) if (m.a || m.b) out[m.id] = { a: m.a || null, b: m.b || null };
    return out;
  }
  // an empty bracket of this format (all TBD)
  function make(format, opts = {}) {
    const f = FORMATS[format] || FORMATS.custom;
    return {
      year: opts.year || new Date().getFullYear(), timezone: opts.timezone || 'WIB', format: FORMATS[format] ? format : 'custom',
      autoAdvance: true, autoScores: false,
      matches: f.matches.map((m) => ({ id: m.id, round: m.round, date: '', time: '', bo: /grand final/i.test(m.round) ? 5 : 3, a: { name: 'TBD', score: null }, b: { name: 'TBD', score: null } })),
    };
  }
  const api = { FORMATS, feeds, make };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BracketFormats = api;
})(this);
