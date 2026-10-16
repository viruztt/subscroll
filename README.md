# Subscription Catalogue

A desktop app that shows which games are in Xbox Game Pass, PlayStation Plus and Nintendo Switch Online, by tier. You pick the plans you have, mark games as played or completed, and see what's leaving soon. Everything you set is saved locally (`%APPDATA%/subscription-catalogue/state.json` on Windows).

## Run it

- **Windows build:** every commit gets a portable build in `dist/`, named `SubscriptionCatalogue-<version>-<commit>.exe`; run the newest one, nothing to install. `dist/` isn't tracked by git. The exe isn't code-signed, so Windows SmartScreen warns the first time ("More info" → "Run anyway").
- **From source (any OS):** `npm install`, then `npm start`. `npm test` runs the tests. `npm run dist:win` / `dist:mac` / `dist:linux` builds a package.

## Where the game lists come from

| Service | Source | Leaving dates |
|---|---|---|
| Xbox Game Pass (Essential, Premium, Ultimate, PC) | Microsoft's catalogue service (`catalog.gamepass.com` + `displaycatalog.mp.microsoft.com`), the same lists xbox.com uses | Microsoft's "leaving soon" list flags games, but has no date |
| PlayStation Plus (Essential monthly games, Extra catalogue, Premium classics) | playstation.com's game lists (`/bin/imagic/gameslist`) | Not published in any feed |
| Nintendo Switch Online (+ Expansion Pack) | Bundled list in `scripts/nintendo-source.txt` (Nintendo has no feed) | Games almost never leave |

If the official source fails, the app falls back to community mirrors on GitHub ([catabox](https://github.com/nanhopper/catabox), [ps-plus-games-list](https://github.com/ppazour/ps-plus-games-list)), and if those fail too it keeps the last list it had. A snapshot ships with the app so it works offline from the first launch.

Catalogues refresh automatically once a day. Every refresh is compared with the previous one, so the "New & departed" page shows what was added and what left. For an exact leaving date (Xbox Wire and the PlayStation Blog announce them monthly), open the game and enter it; it then shows on the card and sorts the "Leaving soon" page.

Other services (Ubisoft+, EA Play, Apple Arcade…) can be added on the Subscriptions page, with their games entered by hand.

## Layout

- `src/main.js`: window, IPC, daily refresh. `src/catalog.js`: refresh, fallbacks, history, merging Xbox console/PC duplicates.
- `src/providers/`: one file per service.
- `renderer/`: the UI (plain HTML/CSS/JS).
- `data/`: bundled snapshot. `npm run snapshot` rebuilds it, including `data/nintendo.json` from `scripts/nintendo-source.txt`.
