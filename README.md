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

The app is only available here on GitHub (it is not on Thunderstore). It downloads the cosmetic mods themselves from
Thunderstore, where ReSkate mods are hosted, so you never have to.

1. Download **`See_Everyones_Fits-<version>.zip`** from the
   [latest release](https://github.com/vapeuid/see-everyones-fits/releases/latest) (under *Assets*).
2. Install the zip one of two ways:
   - Drag the zip into the ReSkate launcher's **Mods** tab, or
   - Extract it into a new folder inside your ReSkate `Mods` folder (e.g. `Mods\See_Everyones_Fits`).
3. Open that folder and double-click **`See Everyones Fits.bat`**.
   The app opens in your browser. Keep the black window open while you use it; close it to quit.

Nothing else to install. Windows only. Windows may warn about an app from the internet the first time; choose
*More info → Run anyway* (the full source is in this repo).

## How to use

### First sync
1. Close the ReSkate launcher and the game.
2. In the app, press **Check for changes**. It looks at the top mods and shows what it would install. Nothing changes yet.
3. Open **Review** to see every mod with its picture and the items it adds or replaces. Press **See it in 3D** to preview an item.
   - **Pin** a mod to always keep it. **Skip** a mod to never install it. Press **Save choices**.
4. Go back to **Home** and press **Sync now**.
5. Start ReSkate. The new fits load at launch.

### Settings
- **Storage limit:** how much space the app may use (500 MB to 20 GB). The estimate under the slider shows how many of
  other players' modded fits you'll see.
- **What gets added:** switch types on or off: decks, tops, bottoms, shoes, hats, glasses and more. Skin, face and body
  start off, so your own look never changes unless you allow it.
- **NSFW:** off by default.
- **Community list:** on by default. Ranks mods by what other users actually wear (see Privacy).

### Keeping it up to date
Run **Sync now** every so often, with the launcher and game closed. It updates synced mods, adds new popular ones and
removes ones that dropped out. `Sync now.bat` does the same without opening the app.

### Good to know
- It never touches mods you installed yourself.
- To undo everything, press **Remove all synced** on Home. Your own mods stay.
- Delete `%LOCALAPPDATA%\SeeEveryonesFits` to reset the app.
- If a preview doesn't show, the mod still works in game; some formats aren't supported by the preview yet.

## Privacy

- Everything runs on your PC (`127.0.0.1`). Settings and cache live in `%LOCALAPPDATA%\SeeEveryonesFits`.
- Community list (on by default, one switch to turn off): shares only the Thunderstore names of your switched-on
  cosmetic mods, under a random id, through a public ntfy.sh channel. Nothing else leaves your PC.
- The cosmetic mods are downloaded only from Thunderstore, where ReSkate mods are hosted.

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
