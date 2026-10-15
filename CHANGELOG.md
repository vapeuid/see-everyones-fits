# Changelog

## 1.2.0

- The app opens in its own window (no browser tabs or address bar), and its console starts minimized in the taskbar;
  closing the app window quits.
- The Review tab shows live progress during a check, with mods appearing as they are looked at, and explains why it is
  empty (no check yet, ReSkate not found, or what went wrong).
- A banner says when ReSkate is not found and how to fix it, and when a newer version is out.
- Settings > Help > **Copy support info**: a short report without folder paths or names, for asking for help.

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
