# Subscroll

**Every game you already pay for, in one place.**

![Browsing the Switch Online library](docs/screenshots/browse.jpg)

| Your played and completed games | Roll a game when you can't decide |
|---|---|
| ![My games](docs/screenshots/my-games.png) | ![Roll a game](docs/screenshots/roll.png) |

![Statistics](docs/screenshots/stats.png)

A desktop app that shows which games are in Xbox Game Pass, PlayStation Plus, Nintendo Switch Online, EA Play, Ubisoft+, Netflix Games and Apple Arcade, by tier. You pick the plans you have, mark games as played or completed, and see what's leaving soon. Everything you set is saved on your PC, in `%APPDATA%\Subscription Catalogue` (the app's earlier name).

## Install

1. Download the latest `Subscroll-<version>.exe` from [Releases](https://github.com/viruztt/subscroll/releases).
2. Double-click it. There's no installer; the exe is the whole app, so keep it wherever you like.
3. The first time, Windows may say "Windows protected your PC", because the app isn't signed with a paid certificate. Click **More info**, then **Run anyway**.

Your plans and marks stay on your PC and carry over when you download a newer version. To move them to another PC, use **Save backup** on the Subscriptions page.

## Where the game lists come from

| Service | Source | Leaving dates |
|---|---|---|
| Xbox Game Pass (Essential, Premium, Ultimate, PC) | Microsoft's catalogue service (`catalog.gamepass.com` + `displaycatalog.mp.microsoft.com`), the same lists xbox.com uses | Microsoft's "leaving soon" list flags games, but has no date |
| PlayStation Plus (Essential monthly games, Extra catalogue, Premium classics) | playstation.com's game lists (`/bin/imagic/gameslist`) | Not published in any feed |
| Nintendo Switch Online (+ Expansion Pack) | Wikipedia's [Nintendo Classics](https://en.wikipedia.org/wiki/Nintendo_Classics) article, which lists every game per system with the date it was added (Nintendo has no feed). Box art comes from [libretro-thumbnails](https://github.com/libretro-thumbnails) via the GitHub API | Games almost never leave |
| EA Play, Ubisoft+ (Classics, Premium) | Microsoft's catalogue service, which lists both subscriptions' Xbox and Microsoft Store editions (`eaaccess`, `nakuconsole`/`nakupc`, `ubisoftplus`) | None |
| Netflix Games | Netflix's own developer account on the App Store (Apple's public lookup API). Games published under a partner's account and TV-only cloud games are missing | None |
| Apple Arcade | Wikipedia's [Apple Arcade](https://en.wikipedia.org/wiki/Apple_Arcade) article. Icons, descriptions and screenshots come from Apple's App Store search, a few games a minute in the background (Apple limits it), cached in `catalog/appstore/` | None |

If a live source fails, the app falls back to community mirrors on GitHub ([catabox](https://github.com/nanhopper/catabox), [ps-plus-games-list](https://github.com/ppazour/ps-plus-games-list)), and if those fail too it keeps the last list it had. A snapshot ships with the app so it works offline from the first launch.

Game Pass Ultimate includes EA Play and Ubisoft+ Classics, and PC Game Pass includes EA Play, so those games count as in your plans when you have Ultimate or PC Game Pass.

A game offered by several services gets one card with a tag for each (dimmed when it's not in your plans), so A Way Out shows once with Game Pass, EA Play and PS Plus. Titles are matched ignoring platform suffixes and edition names; Switch Online games are kept apart, since each is a specific old console version, except for regional versions of the same game ("Adventures of Lolo (NA)" and "(JP)"), which share one card marked NA + JP. Marking the game marks it everywhere.

The **Coming soon** page lists announced games with their date: Game Pass from Microsoft's per-plan join dates, Switch Online and Apple Arcade from dates in their Wikipedia lists. PS Plus, EA Play, Ubisoft+ and Netflix don't publish dates in a form the app can read.

Catalogues refresh automatically once a day. Every refresh is compared with the previous one, so the "New & departed" page shows what was added and what left.

Clicking a game shows a short description and a few screenshots. Game Pass gets both from Microsoft's catalogue; PS Plus reads the game's PlayStation Store page; Switch Online games get title screens and gameplay shots from libretro-thumbnails and the opening of the game's Wikipedia article. Looked-up details are cached for 30 days in `details.json`.

The toolbar filters by service, played status, platform, **genre** and **length** (under 5 or 10 hours, 10 to 20, 20 to 40, over 40, by How Long To Beat's main story). Each store names genres differently, so they're mapped onto one list (`renderer/genres.js`); Switch Online games count as Retro. The length filter only shows games that have a time.

Cards show the **Metacritic** score and the **How Long To Beat** main-story time, and the list can be sorted by score or from shortest to longest. Neither site has a public API, so the app uses the search endpoints their own pages call, looks every game up once in the background (games in your plans first, one game at a time per site with a pause in between) and caches each site's answer for a month in `ratings.json` (two weeks for games it couldn't find). Later launches only look up new games and ones whose answer has expired. If a site refuses or fails, the app backs off, stops asking that site after five failures in a row and tries again next launch; the other site carries on, and its answers are kept. If either site changes its search, the numbers stop updating until the app is fixed; everything else keeps working.

The country picker on the Subscriptions page sets the Xbox market and PlayStation store together. Switch Online only differs in Japan, which gets its Japan-only games (Wikipedia's "JP" column) instead of the western-only ones.

Games can be marked played, completed or ignored (⊘, for games you're not interested in). The toolbar can hide completed, ignored or departed games; ignored games stay on the My games page, and the status filter's "Ignored" option shows them too, so you can un-ignore them.

**Roll a game** picks a random game from the plans you have (from everything if none are set), leaving out games you've completed or ignored and following the service and platform filters.

Other services can be added on the Subscriptions page, with their games entered by hand.

The **Statistics** page shows how far through your plans you are: games completed and in progress, your finish rate, a pie of completed games by service (a game in several of your services counts for the first one on its card), your plans split by status, progress per service, the genres you finish most, and, where How Long To Beat has times, the hours of games you've finished. Completed games that have since left a service still count.

**Steam library** on the Subscriptions page reads the games you own on Steam (Steam's Web API, with your profile link or Steam ID and a free API key from [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey); your profile's Game details must be public). Games you own get an "On Steam" badge and can be filtered with the status filter's "On Steam" option, and games you've played there for 30 minutes or more are marked as played. Each game is marked once, so unmarking it sticks. The library is read again with the daily refresh. Switch Online games aren't matched, since they're old console versions.

**Backup** on the Subscriptions page saves your plans, marks, own services and games, and settings to one `.json` file; **Restore from backup** on another PC (or after a reinstall) loads it back, asking first since it replaces what's there. Catalogues and cached lookups aren't in the file; the app fetches them again.

## Building from source

`npm install`, then `npm start` runs the app (Windows, macOS or Linux). `npm test` runs the tests, and `npm run dist:win` / `dist:mac` / `dist:linux` builds a package into `dist/`, which git ignores. Development builds are named `Subscroll-<version>-<commit>.exe`.

## Layout

- `src/main.js`: window, IPC, daily refresh. `src/details.js`: descriptions and screenshots. `src/ratings.js`: Metacritic and How Long To Beat. `src/regions.js`: the country list. `src/backup.js`: backup files. `src/steam.js`: Steam library import. `src/catalog.js`: refresh, fallbacks, history, merging Xbox console/PC duplicates.
- `src/providers/`: one file per service.
- `renderer/`: the UI (plain HTML/CSS/JS). `renderer/unify.js` merges the same game across services; `renderer/stats.js` works out the Statistics page. The logo is `renderer/logo.svg`; `renderer/icon.png` (window) and `build/icon.png` (exe) are 256 and 512 px renders of it.
- `data/`: bundled snapshot used until the first refresh. `npm run snapshot` rebuilds it. `scripts/match-covers.js` rebuilds the offline Switch Online cover map; titles whose box art is named differently go in `data/nintendo-cover-aliases.json`.
