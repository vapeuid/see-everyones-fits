# Changelog

## 1.1.0

- No PowerShell any more: the game's compressed files are now decoded in plain JavaScript (a port of the Kraken
  decoder from ooz, GPL-3.0). The old helper was the only thing two antivirus engines flagged in 1.0.0.
- Faster: checking 128 mods takes about 7 s instead of 47 s, and a 3D preview builds in under a second.
- No longer needs the game's own Oodle library to read mods.

## 1.0.0

First public release.

- Keeps the most-worn Thunderstore cosmetics and boards installed, within the space you choose.
- Type switches (decks, tops, shoes, ...), protected skin / face / body, clash check, never touches your own mods.
- Review tab with exact item lists and 3D / texture previews.
- Optional anonymous community list.
