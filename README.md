# Subscroll

**Every game you already pay for, in one place.**

![Browsing the Switch Online library](docs/screenshots/browse.jpg)

| Your played and completed games | Roll a game when you can't decide |
|---|---|
| ![My games](docs/screenshots/my-games.png) | ![Roll a game](docs/screenshots/roll.png) |

| Welcome setup | Statistics |
|---|---|
| ![Welcome setup](docs/screenshots/welcome.png) | ![Statistics](docs/screenshots/stats.png) |

![Games like the ones you beat, on the For you page](docs/screenshots/because.png)

A desktop app that shows which games are in Xbox Game Pass, PlayStation Plus, Nintendo Switch Online, EA Play, Ubisoft+, Netflix Games, Apple Arcade, Crunchyroll Game Vault, Humble Choice, Google Play Pass and Amazon Luna, by tier. You pick the plans you have, mark games as played or completed, and see what's leaving soon. Runs on Windows and Linux. Everything you set is saved on your computer, in `%APPDATA%\Subscription Catalogue` on Windows or `~/.config/Subscription Catalogue` on Linux (the app's earlier name).

## Install

### Windows

1. Download the latest `Subscroll-<version>.exe` from [Releases](https://github.com/viruztt/subscroll/releases).
2. Double-click it. There's no installer; the exe is the whole app, so keep it wherever you like.
3. The first time, Windows may say "Windows protected your PC", because the app isn't signed with a paid certificate. Click **More info**, then **Run anyway**.

### Linux

1. Download the latest `Subscroll-<version>.AppImage` from [Releases](https://github.com/viruztt/subscroll/releases).
2. Make it executable: right-click it, **Properties**, tick **Allow executing file as program** (or run `chmod +x Subscroll-*.AppImage`).
3. Double-click it, or run `./Subscroll-<version>.AppImage`. There's nothing to install. If it doesn't open, your system may need FUSE 2 (on Ubuntu 22.04 and later: `sudo apt install libfuse2t64`, or `libfuse2` on older releases).

The tray icon needs a desktop with a system tray. GNOME needs the "AppIndicator and KStatusNotifierItem Support" extension, which Ubuntu includes. The Play buttons open Steam games with your installed Steam (native or Flatpak). The Xbox app button only appears on Windows.

Your plans and marks stay on your computer and carry over when you download a newer version. To move them to another PC, use **Export profile** in Settings.

### Updating

Subscroll checks GitHub for a new version twice a day. When one is out, a box in the sidebar says so, with a **Download** button for your system's file and a link to what's new (you also get one notification per version). It never downloads or installs anything itself: download the new file and use it in place of the old one. Your plans, marks and settings carry over. You can turn the check off, or check straight away, under **Updates** in Settings.

## Where the game lists come from

| Service | Source | Leaving dates |
|---|---|---|
| Xbox Game Pass (Essential, Premium, Ultimate, PC) | Microsoft's catalogue service (`catalog.gamepass.com` + `displaycatalog.mp.microsoft.com`), the same lists xbox.com uses | Microsoft's "leaving soon" list flags games, but has no date |
| PlayStation Plus (Essential monthly games, Extra catalogue, Premium classics) | playstation.com's game lists (`/bin/imagic/gameslist`) | Not published in any feed |
| Nintendo Switch Online (+ Expansion Pack) | Wikipedia's [Nintendo Classics](https://en.wikipedia.org/wiki/Nintendo_Classics) article, which lists every game per system with the date it was added (Nintendo has no feed). Box art comes from [libretro-thumbnails](https://github.com/libretro-thumbnails) via the GitHub API | Games almost never leave |
| EA Play, Ubisoft+ (Classics, Premium) | Microsoft's catalogue service, which lists both subscriptions' Xbox and Microsoft Store editions (`eaaccess`, `nakuconsole`/`nakupc`, `ubisoftplus`) | None |
| Netflix Games | Netflix's own developer account on the App Store (Apple's public lookup API). Games published under a partner's account and TV-only cloud games are missing | None |
| Apple Arcade | Wikipedia's [Apple Arcade](https://en.wikipedia.org/wiki/Apple_Arcade) article. Icons, descriptions and screenshots come from Apple's App Store search, a few games a minute in the background (Apple limits it), cached in `catalog/appstore/`. A game whose title differs on the App Store is matched by its developer; one no longer on the App Store has left the service, and gets its Steam cover, or failing that the one from its Wikipedia article | None |
| Crunchyroll Game Vault | Crunchyroll's own developer account on the App Store, like Netflix (Mega Fan and Ultimate Fan memberships) | None |
| Humble Choice | This month's games from the JSON on Humble's page for the month (the membership page says which month is current); they change on the first Tuesday of each month. If Humble changes the page, the app saves it as `catalog/humble-page.html` so the reader can be fixed | None |

| Google Play Pass | Google doesn't publish its list. The community project [playpassBrowser](https://github.com/inkvolcano/playpassBrowser) checks every game's Play Store page for the Play Pass badge each month, per country; the app reads its data and keeps the games offered in your country. Descriptions and screenshots come from the same project | None |
| Amazon Luna (Standard with Prime, Premium) | Amazon doesn't publish its list. [GameScriptions](https://gamescriptions.com/subscription/service/luna_standard) keeps a page per Luna tier with the dates games were added, leave and arrive; the app reads those pages. If they change, it saves them as `catalog/luna-*-page.html` so the reader can be fixed | Yes, from GameScriptions |

Other services can be added under **Add another service** in Settings, with their games added by hand.

If a live source fails, the app falls back to community mirrors on GitHub ([catabox](https://github.com/nanhopper/catabox), [ps-plus-games-list](https://github.com/ppazour/ps-plus-games-list)), and if those fail too it keeps the last list it had. A snapshot ships with the app so it works offline from the first launch.

Game Pass Ultimate includes EA Play and Ubisoft+ Classics, and PC Game Pass includes EA Play, so those games count as in your plans when you have Ultimate or PC Game Pass.

A game offered by several services gets one card with a tag for each (dimmed when it's not in your plans), so A Way Out shows once with Game Pass, EA Play and PS Plus. Titles are matched ignoring platform suffixes and edition names; Switch Online games are kept apart, since each is a specific old console version, except for regional versions of the same game ("Adventures of Lolo (NA)" and "(JP)"), which share one card marked NA + JP. Marking the game marks it everywhere.

The **Coming soon** page lists announced games with their date: Game Pass from Microsoft's per-plan join dates, Switch Online and Apple Arcade from dates in their Wikipedia lists, Amazon Luna from GameScriptions. PS Plus, EA Play, Ubisoft+ and Netflix don't publish dates in a form the app can read.

Catalogues refresh automatically once a day, including while the window is closed: Subscroll stays in the system tray (right-click the icon to refresh, turn options on or off, or quit) and can start when you log in (with Windows, or through your desktop's autostart on Linux), minimised to the tray. After each refresh it sends a notification when games join a service in your plans or games in your plans start leaving, leaving out games you've completed or ignored; clicking it opens the right page. These are under **Background** in Settings. Every refresh is compared with the previous one, so the "New & departed" page shows what was added in the last 30 days and what left (Wikipedia's Apple Arcade list keeps every game there has ever been, so an Arcade game that neither your country's nor the US App Store has any more counts as having left). Game Pass games show when they joined, from Microsoft's own dates.

The **Calendar** shows a month at a time: games arriving (announced dates), games that joined, games that left, and free games (giveaways, PS Plus monthly games and Free Play Days weekends) starting or on their last day, each in its own colour (click a colour in the key to hide that kind). It follows the same filters as the other pages, so with "Only my subscriptions" on it's your plans' month. Click a game to open it, or a day to list everything on it below the calendar. Xbox flags games as leaving soon without a date, so those aren't on it; a note links to Leaving soon instead.

![The Calendar page](docs/screenshots/calendar.png)

Clicking a game shows a short description and a few screenshots. Game Pass gets both from Microsoft's catalogue; PS Plus reads the game's PlayStation Store page; Switch Online games get title screens and gameplay shots from libretro-thumbnails and the opening of the game's Wikipedia article. Looked-up details are cached for 30 days in `details.json`.

The toolbar filters by service, played status, platform, **genre** and **length** (under 5 or 10 hours, 10 to 20, 20 to 40, over 40, by How Long To Beat's main story). Each store names genres differently, so they're mapped onto one list (`renderer/genres.js`); Switch Online games count as Retro. The length filter only shows games that have a time.

Cards show the **Metacritic** score and the **How Long To Beat** main-story time, and the list can be sorted by score or from shortest to longest. Neither site has a public API, so the app uses the search endpoints their own pages call, looks every game up once in the background (games in your plans first, one game at a time per site with a pause in between) and caches each site's answer for a month in `ratings.json` (two weeks for games it couldn't find). Later launches only look up new games and ones whose answer has expired. If a site refuses or fails, the app backs off, stops asking that site after five failures in a row and tries again next launch; the other site carries on, and its answers are kept. If either site changes its search, the numbers stop updating until the app is fixed; everything else keeps working.

The country picker in Settings sets the Xbox market and PlayStation store together. Switch Online only differs in Japan, which gets its Japan-only games (Wikipedia's "JP" column) instead of the western-only ones.

The first time it opens, a short **welcome setup** asks for your country (guessed from your system language), the plans you have and what you like to play (genres, short or long games), then shows a first set of picks. The **For you** page keeps those recommendations: games from your plans in the genres you like, boosted by good Metacritic scores, leaving soon, just added, recently released and, if you picked a length, How Long To Beat times, with no more than a few from one service. Each card says why it was picked. The setup can be run again from Settings.

Below those picks, **Because you beat…** rows take the games you've marked as completed and find games in your plans like them: by the same developer, from a smaller publisher you've played (big ones like Nintendo or Xbox Game Studios publish too much to mean anything), or sharing the less common genres. Developers and genres come from each service's list where it has them (Xbox, EA Play, Ubisoft+, Apple Arcade, Switch Online publishers); for Switch Online, PS Plus and Netflix games, and for the games you've completed, they're read from the game's Wikipedia article in the background, a game every second or so, cached a month in `wikipedia.json`. The game panel shows the developer and publisher too.

Your **star ratings** steer both. A game you rated 4 or 5 stars gets its own **Because you loved…** row even if you haven't finished it, and rows for your favourites come first. Genres you rate highly rise in the picks (the card says "You rate Puzzle highly"), and genres you rate low sink. A game that's more like one you rated 1 or 2 stars than like anything you enjoyed is left out of the rows. Games you've rated aren't suggested again.

The **To play** list is your wishlist: click ＋ on a game's cover (or **To play** in its details) for anything you want to get to, whether it's out now or still coming. The page groups them into ready to play in your plans, coming soon (with dates), in services you don't have, and ones that have left every service; the sidebar counts the ones you can start now. When a game on the list arrives in your plans (its date comes, or it joins a service you have), you get a "Ready to play" alert. Marking it played or completed takes it off the list, and so does Steam once you've played it there.

At the top of the To play page, **Which plan to get** helps if you rotate subscriptions instead of keeping them all. For the games on your list that your plans don't cover, it ranks the plans you could pick up (or upgrade to) by how many of them each one covers, putting games that are leaving soon first, and names a smaller tier when that covers most of them. It also suggests a month-by-month order (one plan a month, including games announced for the next few months), and points out plans you have that nothing on your list needs, or where a lower tier would cover the same games.

Each game on the list that you can't play yet says the **cheapest way** to play it, and its details list the three cheapest: a month (or the shortest payment) of the cheapest plan that has it, buying it at today's store price (sale prices included), or waiting until it joins a plan you already have when it's announced. Plan prices are the list prices on the Value page, so they're only as current as those; a store price shows once the app has looked the game up, which it does for To play games twice a day.

**Free to keep** lists games you can claim for free and keep for good: Epic's weekly free games (from Epic's own store list, with exact end dates and next week's games), plus Steam, GOG and Prime Gaming giveaways (Prime Gaming is now claimed through Amazon Luna) from [GamerPower](https://www.gamerpower.com/)'s public giveaway list. Each one shows when the offer ends and links straight to the claim page; mark it **Claimed** or **Not interested** to tidy it away. The list is checked every few hours, and with alerts on you get a notification when new ones appear and on the last day of any you haven't claimed (turn that off under Settings → Background).

It also lists your plans' own monthly freebies. **Humble Choice** games are listed with the date you need to claim them by. **PS Plus monthly games** are added to your library while you have PS Plus, from the first Tuesday of the month until the first Tuesday of the next: this month's come from PlayStation's own list, and next month's appear under "Coming next" once the PlayStation Blog announces them. **Xbox Free Play Days** (from Xbox Wire's weekly post) let you play a few full games free from Thursday to Sunday; most need any Game Pass plan except PC Game Pass, and some, including timed trials, are open to everyone. Ones that need a plan you don't have are hidden, with a link to show them, and only ones you can play send alerts.

Games can be marked played, completed or ignored (⊘, for games you're not interested in). The toolbar can hide completed, ignored or departed games; ignored games stay on the My games page, and the status filter's "Ignored" option shows them too, so you can un-ignore them.

**Roll a game** picks a random game from the plans you have (from everything if none are set), leaving out games you've completed or ignored and following the service and platform filters.

Other services can be added in Settings, with their games entered by hand.

The **Value** page compares what the games you beat would cost to buy outright with what you've paid for the subscriptions. For each plan, pick what you pay from a list of today's prices for your country (monthly, 3-month or yearly; checked October 2026, and you can enter your own amount instead) and the month you started. If you stopped and came back, add another period with its own start, end and price, so a gap isn't counted; prices are looked up for the games you've completed (the service's own store first: Microsoft Store for Game Pass, EA Play and Ubisoft+, PlayStation Store for PS Plus; then Steam), at today's full price, and cached for a month in `prices.json`. Untick games you bought or played some other way (games you own on Steam or that aren't in your plans start unticked), type a price where none was found (Switch Online classics aren't sold anywhere), and optionally count games you played but didn't finish.

It also works out **cost per hour** from How Long To Beat main story times: what an hour of play cost you through subscriptions (overall and per plan), what it would have cost buying the games, and each game's price over its hours. Games without a time count at the average of the ones with one.

The **Statistics** page shows how far through your plans you are: games completed and in progress, your finish rate, a pie of completed games by service (a game in several of your services counts for the first one on its card), your plans split by status, progress per service, the genres you finish most, and, where How Long To Beat has times, the hours of games you've finished. Completed games that have since left a service still count.

At the top, **Goals** let you set targets like "beat 2 games a month" or "beat 10 hours of games a week" (hours from How Long To Beat). Each goal shows how far you are this week, month or year, how many periods in a row you've made it, your best streak, and the last twelve periods at a glance. Games count in the period you marked them completed; ones imported as completed from Xbox or PlayStation are dated by when you last played them. Games you'd completed before goals existed have no date: open one and set **Finished** to count it.

**Steam library** in Settings reads the games you own on Steam (Steam's Web API, with your profile link or Steam ID and a free API key from [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey); your profile's Game details must be public). Games you own get an "On Steam" badge and can be filtered with the status filter's "On Steam" option, and games you've played there for 30 minutes or more are marked as played. Each game is marked once, so unmarking it sticks. The library is read again with the daily refresh. Switch Online games aren't matched, since they're old console versions.

**Xbox achievements** and **PlayStation trophies** in Settings work the same way: games you've earned an achievement or trophy in are marked as played, and games at 100% (or with the platinum trophy) as completed, once each, so a mark you change sticks. A game's details show how far you got. Xbox needs a free API key from [OpenXBL](https://xbl.io) (sign in with your Xbox account and create a key on your profile), a free service that reads achievements from Xbox Live. PlayStation needs your NPSSO code: sign in at playstation.com, open [ca.account.sony.com/api/v1/ssocookie](https://ca.account.sony.com/api/v1/ssocookie) and copy the `npsso` value. Treat that code like a password, since it signs in to your PlayStation account; Sony makes it run out after about two months. Both are read again with the daily refresh.

**Sale alerts**: To play games that aren't in any of your plans (in other services, or gone from every service) are checked twice a day on the Microsoft Store, PlayStation Store or Steam. When one goes on sale it gets a "% off" badge with the sale price, and you get a notification (once per sale price; a deeper cut is news again). Turn the alerts off under Settings → Background.

**Your rating and notes**: a game's details have five stars to rate it and a box for your own notes (where you got to, what to try, who recommended it). Rated or noted games get a ★ badge, **Your rating** in the sort menu puts your favourites first, and search finds words in your notes too. Ratings steer the For you page, and ratings and notes are in the profile export.

**Play buttons**: a game's details have buttons to start it. If you own it on Steam (see Steam library above), **▶ Play on Steam** launches it, or **Install with Steam** installs it when Steam says it isn't installed. Games in a PC Game Pass, EA Play or Ubisoft+ list open in the **Xbox app**, and PS Plus games open on the **PlayStation Store**.

**Cloud play**: games you can stream get a ☁ Cloud badge, highlighted when one of your plans lets you stream it, and "Cloud streaming" in the platform filter lists just those. Xbox Cloud Gaming comes from [Gameglass](https://github.com/jackheuberger/gameglass), which reads Microsoft's cloud catalogue every few hours and works out which Game Pass tiers can stream each game (US catalogue; read once a day). PlayStation's own lists say which games PS Plus Premium can stream. A game's details say which plans can stream it.

**Export & import profile** in Settings saves everything Subscroll keeps about you to one `.json` file: plans, marks and your To play list, your own services and games, settings, Value page costs, your Steam link, free games you claimed or skipped, and when games joined or left each list. Ticking "Include looked-up data" also saves the Metacritic scores, play times, prices, descriptions and covers it has looked up, so another PC doesn't have to look them all up again. **Import profile** on another PC (or after a reinstall) asks first, then replaces your plans, marks and settings and adds the history and looked-up data to what that PC already has. The file includes your Steam, OpenXBL and PlayStation keys if you added them, so keep it private. Backups saved by older versions still import. Catalogues themselves aren't in the file; the app fetches them again.

## Credits

Subscroll reads its data from these services and projects. Thanks to everyone who runs them.

**Official sources**
- Microsoft: the Game Pass catalogue (`catalog.gamepass.com`), Microsoft Store product data (`displaycatalog.mp.microsoft.com`) and [Xbox Wire](https://news.xbox.com/) for Free Play Days.
- Sony: [playstation.com](https://www.playstation.com/)'s PS Plus game lists, PlayStation Store pages and prices, the [PlayStation Blog](https://blog.playstation.com/), and the PlayStation trophy service (with your own sign-in).
- Apple: the [App Store](https://www.apple.com/app-store/) lookup and search API, for Netflix Games, Apple Arcade and Crunchyroll Game Vault.
- Valve: the [Steam Web API](https://steamcommunity.com/dev) and Steam store search, for your library, covers and prices.
- [Epic Games Store](https://store.epicgames.com/)'s free games list.
- [Humble Bundle](https://www.humblebundle.com/membership)'s Humble Choice pages.
- [Google Play](https://play.google.com/store/pass/getstarted) store links and images.
- [GitHub](https://github.com/): the releases API, to tell you when a new version of Subscroll is out.

**Community projects and sites**
- [Wikipedia](https://en.wikipedia.org/): the Nintendo Classics and Apple Arcade game lists, game descriptions, developers, genres and covers (text under [CC BY-SA](https://creativecommons.org/licenses/by-sa/4.0/)).
- [libretro-thumbnails](https://github.com/libretro-thumbnails): Switch Online box art, title screens and screenshots.
- [playpassBrowser](https://github.com/inkvolcano/playpassBrowser) by inkvolcano: the Google Play Pass list.
- [GameScriptions](https://gamescriptions.com/): the Amazon Luna lists and dates.
- [Gameglass](https://github.com/jackheuberger/gameglass) by Jack Heuberger: which Xbox games stream with Cloud Gaming.
- [catabox](https://github.com/nanhopper/catabox) by nanhopper: the Game Pass mirror used when Microsoft's service fails.
- [ps-plus-games-list](https://github.com/ppazour/ps-plus-games-list) by ppazour: the PS Plus mirror used when playstation.com fails.
- [GamerPower](https://www.gamerpower.com/): Steam, GOG and Prime Gaming giveaways.
- [OpenXBL](https://xbl.io/): Xbox achievements (with your own API key).
- [Metacritic](https://www.metacritic.com/) and [How Long To Beat](https://howlongtobeat.com/): scores and play times.

Subscroll isn't affiliated with or endorsed by any of them. Game names, artwork and trademarks belong to their owners.

## License

The code is under the [MIT License](LICENSE), copyright (c) 2026 Šarūnas Rimša.

The data the app reads belongs to its sources (see Credits) and keeps their terms. The same goes for the offline snapshots bundled in `data/snapshot/`:
- `nso.json` is built from Wikipedia's Nintendo Classics article ([CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)).
- `gamepass.json` and `psplus.json` are copies of Microsoft's and Sony's catalogue lists.

Game names, artwork and trademarks belong to their owners.

## Building from source

`npm install`, then `npm start` runs the app (Windows, macOS or Linux). `npm test` runs the tests, and `npm run dist:win` / `dist:mac` / `dist:linux` builds a package into `dist/`, which git ignores. Development builds are named `Subscroll-<version>-<commit>.exe`. The Linux AppImage builds on Linux (`npm run dist:linux`). `src/linux.js` holds the Linux versions of start at login and the Steam install check.

## Layout

- `src/main.js`: window, IPC, daily refresh. `src/details.js`: descriptions and screenshots. `src/ratings.js`: Metacritic and How Long To Beat. `src/regions.js`: the country list. `src/backup.js`: profile export and import. `src/providers/playpass.js` and `src/providers/luna.js`: Google Play Pass (playpassBrowser) and Amazon Luna (GameScriptions). `src/steam.js`: Steam library import. `src/achievements.js`: Xbox achievements (OpenXBL) and PlayStation trophies. `src/alerts.js`: what the tray notifications say. `src/prices.js`, `renderer/value.js` and `renderer/planprices.js`: the Value page (game prices, paid periods, plan list prices) and sale prices. `src/sales.js`: sale alerts. `src/updates.js`: the new version check. `renderer/recommend.js`: For you picks and "Because you beat". `renderer/advisor.js`: Which plan to get. `renderer/cheapest.js`: the cheapest way to play a game. `src/freegames.js`: Free to keep (Epic store feed and GamerPower). `src/monthly.js`: PS Plus monthly games (playstation.com list, PlayStation Blog) and Xbox Free Play Days (Xbox Wire). `renderer/calendar.js`: the Calendar page. `renderer/goals.js`: goals and streaks. `renderer/play.js`: the Play buttons (Steam, Xbox app, PlayStation Store links). `src/cloud.js`: which Xbox games stream (Gameglass). `src/wiki.js`: developers, genres and covers from Wikipedia infoboxes. `src/catalog.js`: refresh, fallbacks, history, merging Xbox console/PC duplicates.
- `src/providers/`: one file per service.
- `renderer/`: the UI (plain HTML/CSS/JS). `renderer/unify.js` merges the same game across services; `renderer/stats.js` works out the Statistics page. The logo is `renderer/logo.svg`; `renderer/icon.png` (window) and `build/icon.png` (exe) are 256 and 512 px renders of it.
- `data/`: bundled snapshot used until the first refresh. `npm run snapshot` rebuilds it. `scripts/match-covers.js` rebuilds the offline Switch Online cover map; titles whose box art is named differently go in `data/nintendo-cover-aliases.json`.
