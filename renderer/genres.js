// Each store names genres its own way ("Role playing" on Xbox,
// "Role_playing_games" on PlayStation, "Role Playing" on the App Store).
// These map them onto one short list for the genre filter.
(function (root) {
  const GENRES = [
    ['Action & adventure', /action|adventure|arcade|beat 'em up|hack and slash|metroidvania|stealth|visual novel/i],
    ['RPG', /role.?playing|\brpg\b/i],
    ['Shooter', /shoot|run and gun/i],
    ['Platformer', /platform|metroidvania/i],
    ['Puzzle', /puzzle|trivia|word|brain/i],
    ['Strategy', /strategy|battle arena|moba|tactic|tower defen/i],
    ['Racing', /racing|driving|kart/i],
    ['Sports', /sport|golf|tennis|soccer|football|baseball|basketball|hockey|skateboard|snowboard|wrestling|boxing/i],
    ['Simulation', /simulat/i],
    ['Fighting', /fighting/i],
    ['Horror', /horror/i],
    ['Family & party', /family|kids|party|casual|educational/i],
    ['Card & board', /card|board|casino/i],
    ['Music', /music|rhythm/i],
    // Switch Online's games and Xbox's "Classics" are all old console games.
    ['Retro', /^classics$|^retro$/i],
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
    ['under5', 'Under 5 hours', (h) => h < 5],
    ['under10', 'Under 10 hours', (h) => h < 10],
    ['10to20', '10 to 20 hours', (h) => h >= 10 && h <= 20],
    ['20to40', '20 to 40 hours', (h) => h > 20 && h <= 40],
    ['over40', 'Over 40 hours', (h) => h > 40],
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
