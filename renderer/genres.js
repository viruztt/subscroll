// Each store names genres its own way ("Role playing" on Xbox,
// "Role_playing_games" on PlayStation, "Role Playing" on the App Store).
// These map them onto one short list for the genre filter.
(function (root) {
  const I18n = root.I18n || (typeof require === 'function' ? require('./i18n') : null);
  const { tk } = I18n;
  const GENRES = [
    [tk('Action & adventure'), /action|adventure|arcade|beat 'em up|hack and slash|metroidvania|stealth|visual novel/i],
    [tk('RPG'), /role.?playing|\brpg\b/i],
    [tk('Shooter'), /shoot|run and gun/i],
    [tk('Platformer'), /platform|metroidvania/i],
    [tk('Puzzle'), /puzzle|trivia|word|brain/i],
    [tk('Strategy'), /strategy|battle arena|moba|tactic|tower defen/i],
    [tk('Racing'), /racing|driving|kart/i],
    [tk('Sports'), /sport|golf|tennis|soccer|football|baseball|basketball|hockey|skateboard|snowboard|wrestling|boxing/i],
    [tk('Simulation'), /simulat/i],
    [tk('Fighting'), /fighting/i],
    [tk('Horror'), /horror/i],
    [tk('Family & party'), /family|kids|party|casual|educational/i],
    [tk('Card & board'), /card|board|casino/i],
    [tk('Music'), /music|rhythm/i],
    // Switch Online's games and Xbox's "Classics" are all old console games.
    [tk('Retro'), /^classics$|^retro$/i],
  ];
  const NAMES = GENRES.map(([name]) => name);

  function genresOf(game) {
    const raw = (game.offers || [game]).flatMap((o) => [...(o.genres || []), ...(o.service === 'nso' ? ['Retro'] : [])]);
    const out = new Set();
    for (const r of raw) {
      for (const [name, re] of GENRES) if (re.test(String(r).replace(/_/g, ' '))) out.add(name);
    }
    return NAMES.filter((n) => out.has(n));
  }

  // Length filter choices, by How Long To Beat's main-story hours.
  const LENGTHS = [
    ['under5', tk('Under 5 hours'), (h) => h < 5],
    ['under10', tk('Under 10 hours'), (h) => h < 10],
    ['10to20', tk('10 to 20 hours'), (h) => h >= 10 && h <= 20],
    ['20to40', tk('20 to 40 hours'), (h) => h > 20 && h <= 40],
    ['over40', tk('Over 40 hours'), (h) => h > 40],
  ];

  function fitsLength(hours, choice) {
    if (!choice || choice === 'all') return true;
    const option = LENGTHS.find(([id]) => id === choice);
    return hours != null && !!option && option[2](hours);
  }

  const api = { GENRES: NAMES, genresOf, LENGTHS: LENGTHS.map(([id, label]) => ({ id, label })), fitsLength };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Genres = api;
})(this);
