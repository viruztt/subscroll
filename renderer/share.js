// Share a list: your To play list, what you're playing, or the games you
// completed or played, as a picture of their covers or as text, to post or send.
//
//   text(items, { heading, footer, markdown, where, stars })
//   layout(count, { width })
//   draw(canvas, { heading, sub, footer, items, images, colors, where, stars })
//
// items: [{ title, where: 'Game Pass, PS Plus', stars: 0-5, color, whole }]
// images: one loaded <img> (or null) per item, in the same order.
(function (root) {
  // A picture holds at most this many covers; the text has every game.
  const MAX_IMAGE = 48;
  const WIDTH = 1200;
  const MARGIN = 48;
  const GAP = 16;
  const HEAD = 132;
  const FOOT = 64;
  const CAPTION = 62;

  const starText = (n) => (n > 0 ? '★'.repeat(n) : '');

  function text(items, { heading = '', footer = '', markdown = false, where = true, stars = true } = {}) {
    const lines = [];
    if (heading) lines.push(markdown ? `## ${heading}` : heading, '');
    for (const g of items) {
      const title = markdown ? `**${g.title.replace(/([*_`[\]])/g, '\\$1')}**` : g.title;
      const extra = [where && g.where ? `(${g.where})` : '', stars ? starText(g.stars) : ''].filter(Boolean).join(' ');
      lines.push(`${markdown ? '-' : '•'} ${title}${extra ? ` ${extra}` : ''}`);
    }
    if (footer) lines.push('', markdown ? `*${footer}*` : footer);
    return lines.join('\n');
  }

  // Columns and sizes for `count` covers: fewer games get bigger covers.
  function layout(count, { width = WIDTH } = {}) {
    const shown = Math.min(count, MAX_IMAGE);
    const cols = shown <= 4 ? Math.max(shown, 1) : shown <= 10 ? 5 : 6;
    const tile = Math.floor((width - 2 * MARGIN - (cols - 1) * GAP) / cols);
    const cover = Math.round(tile * 4 / 3);
    const rows = Math.ceil(shown / cols);
    const more = count - shown;
    const height = HEAD + rows * (cover + CAPTION) + Math.max(0, rows - 1) * GAP + (more > 0 ? 40 : 0) + FOOT;
    return { width, cols, rows, tile, cover, shown, more, height: Math.max(height, HEAD + FOOT + 120) };
  }

  // Text cut to fit `max` pixels, at most `lines` lines.
  function wrap(ctx, str, max, lines) {
    const words = String(str).split(/\s+/);
    const out = [];
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (ctx.measureText(next).width <= max || !line) line = next;
      else {
        out.push(line);
        line = w;
      }
    }
    if (line) out.push(line);
    if (out.length > lines) {
      out.length = lines;
      let last = out[lines - 1];
      while (last.length > 1 && ctx.measureText(`${last}…`).width > max) last = last.slice(0, -1);
      out[lines - 1] = `${last}…`;
    }
    // A single word wider than the tile.
    return out.map((l) => {
      let s = l;
      while (s.length > 1 && ctx.measureText(s).width > max) s = s.slice(0, -2) + '…';
      return s;
    });
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function draw(canvas, { heading, sub, footer, more, items, images = [], colors, where = true, stars = true, font = 'system-ui, "Segoe UI", sans-serif' }) {
    const L = layout(items.length);
    const scale = 2;
    canvas.width = L.width * scale;
    canvas.height = L.height * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, L.width, L.height);
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = colors.text;
    ctx.font = `700 34px ${font}`;
    ctx.fillText(wrap(ctx, heading, L.width - 2 * MARGIN, 1)[0] || '', MARGIN, 72);
    ctx.fillStyle = colors.muted;
    ctx.font = `400 18px ${font}`;
    ctx.fillText(sub || '', MARGIN, 104);
    items.slice(0, L.shown).forEach((g, i) => {
      const x = MARGIN + (i % L.cols) * (L.tile + GAP);
      const y = HEAD + Math.floor(i / L.cols) * (L.cover + CAPTION + GAP);
      ctx.save();
      roundRect(ctx, x, y, L.tile, L.cover, 10);
      ctx.clip();
      ctx.fillStyle = colors.panel;
      ctx.fillRect(x, y, L.tile, L.cover);
      const img = images[i];
      if (img && img.naturalWidth) {
        const r = img.naturalWidth / img.naturalHeight;
        const box = L.tile / L.cover;
        // Box art in every shape shows whole; posters fill the tile.
        const fill = g.whole ? r < box : r > box;
        const w = fill ? L.cover * r : L.tile;
        const h = fill ? L.cover : L.tile / r;
        ctx.drawImage(img, x + (L.tile - w) / 2, y + (L.cover - h) / 2, w, h);
      } else {
        ctx.fillStyle = g.color || colors.panel;
        ctx.globalAlpha = 0.55;
        ctx.fillRect(x, y, L.tile, L.cover);
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#fff';
        ctx.font = `700 ${Math.round(L.tile / 9)}px ${font}`;
        wrap(ctx, g.title, L.tile - 24, 4).forEach((line, j) => ctx.fillText(line, x + 12, y + 32 + j * Math.round(L.tile / 7.5)));
      }
      ctx.restore();
      ctx.fillStyle = colors.text;
      ctx.font = `600 15px ${font}`;
      const titleLines = wrap(ctx, g.title, L.tile, 2);
      titleLines.forEach((line, j) => ctx.fillText(line, x, y + L.cover + 20 + j * 18));
      const extra = [where ? g.where : '', stars ? starText(g.stars) : ''].filter(Boolean).join('  ');
      if (extra) {
        ctx.fillStyle = colors.muted;
        ctx.font = `400 13px ${font}`;
        ctx.fillText(wrap(ctx, extra, L.tile, 1)[0], x, y + L.cover + 20 + titleLines.length * 18 + 2);
      }
    });
    ctx.fillStyle = colors.muted;
    ctx.font = `400 16px ${font}`;
    if (L.more > 0 && more) ctx.fillText(more, MARGIN, L.height - FOOT - 12);
    ctx.fillStyle = colors.accent;
    ctx.fillText(footer || '', MARGIN, L.height - 26);
    return L;
  }

  const api = { text, layout, draw, MAX_IMAGE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Share = api;
})(this);
