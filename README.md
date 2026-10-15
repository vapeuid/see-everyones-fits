# See Everyone's Fits

In ReSkate you only see someone's modded fit if you have that exact mod installed. Everyone else's drip shows up as
stock gear for you. **See Everyone's Fits** fixes that: it keeps the most-worn cosmetic and board mods on Thunderstore
installed for you, so the fits around you actually show.

## How much you'll see

Estimated from Thunderstore download counts:

| Space you give it | Mods | Modded fits you'll see |
|---|---|---|
| 1 GB | ~24 | ~20% |
| 2 GB (default) | ~55 | ~a third |
| 4 GB | ~125 | ~half |
| 8 GB | ~290 | ~two thirds |

Stock items always show. Downloads are a stand-in for what people actually wear, so take these as a rough guide. With
the community list on, mods are also ranked by what other See Everyone's Fits users really wear, and that gets better
the more people use it.

## Features

- **You pick the space:** anything from 500 MB to 20 GB, with a live estimate of how much you'll see.
- **You pick the types:** decks, tops, bottoms, shoes, hats, glasses and the rest, each on or off.
- **Your look stays yours:** skin, face and body are never changed unless you switch them on.
- **No clashes:** skips mods that replace the same game files as ones you already have.
- **Hands off your mods:** never touches anything you installed yourself.
- **Review before you sync:** every mod with its picture, the exact items it adds or replaces, and a 3D preview of
  each item. Pin the ones you want, skip the ones you don't.
- **Stays current:** updates synced mods and removes ones that fall out of the top list.
- Skips NSFW-flagged packs (unless you switch them on), plus deprecated and oversized ones.

## Install

The ReSkate launcher's built-in Thunderstore browser only installs mods with game files, so it will refuse this one.
Install it like this instead:

1. On the Thunderstore page, press **Manual Download**.
2. Either drop the zip into the ReSkate launcher's Mods tab (install from file), or extract it into a new folder inside
   your ReSkate `Mods` folder.
3. Open that folder and double-click **`See Everyones Fits.bat`**. The app opens in your browser and runs only on your PC.
4. Close the ReSkate launcher and the game, press **Sync now**, then start ReSkate. New fits load at launch.

Everything it needs is included; you do not have to install anything else. Windows only.

## Privacy

- Everything runs on your PC (`127.0.0.1`). Settings and cache live in `%LOCALAPPDATA%\SeeEveryonesFits`.
- Community list (on by default, one switch to turn off): shares only the Thunderstore names of your switched-on
  cosmetic mods, under a random id, through a public ntfy.sh channel. Nothing else leaves your PC.
- Downloads come only from Thunderstore.

## Disk use

ReSkate keeps its own merged copy of your mods, so actual disk use can be up to about double the space you set.
3D previews are cached separately (up to 400 MB, oldest removed first).

## How it works

- `app.js` runs a small local web server and opens the app in your browser.
- `lib/core.js` ranks Thunderstore packages, downloads and unpacks them safely, checks clashes and your type settings,
  and writes ReSkate's `Mods\mods.json` (with a backup) only while the launcher and the game are closed.
- `lib/format/` reads the game's and the mods' data files to list exactly which items a mod adds or replaces and to
  build previews. It only reads the game and Mods folders. Compressed data is decoded with the game's own Oodle
  library, loaded from your game folder.

## Licence

Source: https://github.com/vapeuid/see-everyones-fits

GPL-3.0 (see `LICENSE`). The bundled `node/node.exe` is Node.js under its own licence (`node/LICENSE`).
Not affiliated with ReSkate, Thunderstore or EA. Provided as is; no support is promised.
