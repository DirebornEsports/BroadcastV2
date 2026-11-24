SOUND EFFECTS (animation feedback)
==================================
sounds/sfx/ holds one short sound per animation. They play on every OBS source:
  pick, ban            hero picked / banned (draft bar)
  player, photo        player name and photo land on a pick card
  score                series score goes up
  turn                 the next pick/ban slot lights up
  popup, popup-out     hero stats popup slides in / out
  card-in, bars, card-out   full-screen stat cards (in, bars growing, out)
  ingame               in-game player card swaps (observer cycles heroes)
  overlay-in, overlay-out   draft bar shown / hidden
To replace one, put your own file with the same name in sounds/sfx/
(e.g. sounds/sfx/pick.mp3). It's used instead of the .wav within 30 seconds.
On/off, volume and a test button per sound: control panel -> Sound effects.

HERO NAME CALLS
===============
Put one audio file per hero in  sounds/heroes/  named with the hero code
(same names as public/heroes/HERO-FILENAMES.txt), e.g.

  sounds/heroes/pudge.mp3
  sounds/heroes/antimage.mp3
  sounds/heroes/nevermore.mp3      (Shadow Fiend)

It plays the moment that hero is picked. Formats: mp3, ogg, wav, m4a.

Optional stings in this folder (they replace the pick / ban sound effect):
  sounds/pick.mp3   played on every pick
  sounds/ban.mp3    played on every ban

New files are picked up within 30 seconds, no restart needed.
Volume and on/off: config.json -> display.soundVolume / display.sounds

OBS: in the Browser source properties tick "Control audio via OBS",
then the overlay shows up in the Audio Mixer and goes out on stream.
Do this on ALL Browser sources: /overlay, /statcards and /ingame.
