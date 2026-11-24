// node test/bracket16.test.cjs — the 16-team double elimination format and the Uprising bracket from the screenshots:
// byes give a winner, and every played slot holds exactly the team the format's routing sends there
const { liveBracket } = require('../lib/livecards.js');
const BF = require('../public/bracket-formats.js');
const data = require('../seed/uprising-1-bracket.json');
let fails = 0; const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };

const live = liveBracket({ bracket: data, db: { matches: {} }, teamDb: [] });
const byId = Object.fromEntries(live.matches.map((m) => [m.id, m]));
ok(BF.FORMATS['double-elimination-16'].matches.length === 30 && live.matches.length === 30, '30 matches in format and data');
ok(byId[1].winnerSide === 'a' && byId[5].winnerSide === 'a' && byId[7].winnerSide === 'a', 'upper round 1: the team beats the Bye');
ok(byId[9].winnerSide === 'b' && byId[11].winnerSide === 'b' && byId[12].winnerSide === 'b', 'lower round 1: the team beats the Bye');
ok([...Array(20)].every((_, i) => byId[i + 1].winnerSide), 'matches 1-20 (played on 20/11) all have a winner');
ok([21, 22, 23, 24].every((id) => !byId[id].winnerSide), 'matches 21-24 not played yet');

// routing: the teams typed into each slot are the ones the feeds produce from the earlier results
const feeds = BF.feeds('double-elimination-16'), wrong = [];
for (const [to, f] of Object.entries(feeds)) for (const side of ['a', 'b']) {
  const src = byId[f[side][1]], want = src && src.winnerSide ? src[f[side][0] === 'W' ? src.winnerSide : (src.winnerSide === 'a' ? 'b' : 'a')].name : 'TBD';
  if (byId[to][side].name !== want) wrong.push(`M${to}.${side}: ${byId[to][side].name} vs routed ${want}`);
}
ok(!wrong.length, 'every slot matches the format routing' + (wrong.length ? ': ' + wrong.join('; ') : ''));
process.exit(fails ? 1 : 0);
