// Pixel analysis: background/text color estimation, ink masks, erasing.
const Analyze = (() => {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function median(arr) {
    if (!arr.length) return 0;
    const s = Float32Array.from(arr).sort();
    return s[s.length >> 1];
  }

  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  }

  const toHex = ([r, g, b]) =>
    '#' + [r, g, b].map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');

  // Integer box helpers. Boxes are {x0, y0, x1, y1} with exclusive x1/y1.
  function intBox(b, W, H, grow = 0) {
    return {
      x0: clamp(Math.floor(b.x0) - grow, 0, W),
      y0: clamp(Math.floor(b.y0) - grow, 0, H),
      x1: clamp(Math.ceil(b.x1) + grow, 0, W),
      y1: clamp(Math.ceil(b.y1) + grow, 0, H),
    };
  }

  // Estimate background (from a ring around the box) and text color (from the
  // pixels inside the box that differ most from the background).
  function colors(box, img) {
    const { width: W, height: H, data } = img;
    const h = Math.max(1, box.y1 - box.y0);
    const pad = Math.max(2, Math.round(h * 0.25));
    const t = intBox(box, W, H, 0);
    const r = intBox(box, W, H, pad);

    const R = [], G = [], B = [];
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++) {
        if (x >= r.x0 + 2 && x < r.x1 - 2 && y >= r.y0 + 2 && y < r.y1 - 2) continue;
        const i = (y * W + x) * 4;
        R.push(data[i]); G.push(data[i + 1]); B.push(data[i + 2]);
      }
    }
    const bg = [median(R), median(G), median(B)];
    let close = 0;
    for (let k = 0; k < R.length; k++) {
      if (Math.hypot(R[k] - bg[0], G[k] - bg[1], B[k] - bg[2]) < 14) close++;
    }
    const uniform = R.length > 0 && close / R.length > 0.9;

    const n = (t.x1 - t.x0) * (t.y1 - t.y0);
    const d = new Float32Array(n);
    let k = 0;
    for (let y = t.y0; y < t.y1; y++) {
      for (let x = t.x0; x < t.x1; x++, k++) {
        const i = (y * W + x) * 4;
        d[k] = Math.hypot(data[i] - bg[0], data[i + 1] - bg[1], data[i + 2] - bg[2]);
      }
    }
    const dHi = percentile(Float32Array.from(d).sort(), 0.98);
    const tr = [], tg = [], tb = [];
    k = 0;
    for (let y = t.y0; y < t.y1; y++) {
      for (let x = t.x0; x < t.x1; x++, k++) {
        if (d[k] >= dHi * 0.85) {
          const i = (y * W + x) * 4;
          tr.push(data[i]); tg.push(data[i + 1]); tb.push(data[i + 2]);
        }
      }
    }
    let color = [median(tr), median(tg), median(tb)];
    if (dHi < 18) {
      // Barely any contrast: fall back to black/white against the background.
      const lum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
      color = lum > 128 ? [0, 0, 0] : [255, 255, 255];
    }
    return { bg, color, uniform, pad, contrast: Math.hypot(color[0] - bg[0], color[1] - bg[1], color[2] - bg[2]) };
  }

  // Full analysis of a text item: colors, anti-aliased coverage mask, ink box.
  function analyze(item, img) {
    const { width: W, height: H, data } = img;
    const c = colors(item, img);
    item.bg = c.bg;
    item.color = c.color;
    item.bgUniform = c.uniform;

    const e = intBox(item, W, H, Math.max(1, Math.round(c.pad / 2)));
    const [br, bgc, bb] = c.bg;
    const vr = c.color[0] - br, vg = c.color[1] - bgc, vb = c.color[2] - bb;
    const vv = Math.max(1, vr * vr + vg * vg + vb * vb);

    const ew = e.x1 - e.x0, eh = e.y1 - e.y0;
    const alpha = new Float32Array(ew * eh);
    let ix0 = Infinity, iy0 = Infinity, ix1 = -1, iy1 = -1;
    for (let y = 0; y < eh; y++) {
      for (let x = 0; x < ew; x++) {
        const i = ((y + e.y0) * W + (x + e.x0)) * 4;
        const a = clamp(((data[i] - br) * vr + (data[i + 1] - bgc) * vg + (data[i + 2] - bb) * vb) / vv, 0, 1);
        alpha[y * ew + x] = a;
        if (a > 0.45) {
          if (x < ix0) ix0 = x;
          if (x > ix1) ix1 = x;
          if (y < iy0) iy0 = y;
          if (y > iy1) iy1 = y;
        }
      }
    }
    if (ix1 < 0) { ix0 = 0; iy0 = 0; ix1 = ew - 1; iy1 = eh - 1; }

    item.ink = { x0: e.x0 + ix0, y0: e.y0 + iy0, x1: e.x0 + ix1 + 1, y1: e.y0 + iy1 + 1 };
    item.alpha = alpha;
    item.eraseBox = e;
    item.autoAlign = guessAlign(item, img);
    item.contrast = c.contrast;
    item.erase = null;
    return item;
  }

  // Text centered inside a shape (button, pill, badge) should stay centered when the
  // text changes length. Walk outward from the ink in all four directions along the
  // background color; if every walk ends on a continuous edge (not a neighboring glyph)
  // and the margins are symmetric, the text is centered in a box.
  function guessAlign(item, img) {
    if (!item.bgUniform) return 'left';
    const { width: W, height: H, data } = img;
    const ink = item.ink, h = ink.y1 - ink.y0, maxRun = Math.round(h * 6);
    const [br, bg, bb] = item.bg;
    const isBg = (x, y) => {
      const i = (y * W + x) * 4;
      return Math.abs(data[i] - br) + Math.abs(data[i + 1] - bg) + Math.abs(data[i + 2] - bb) < 30;
    };
    const walk = (x, y, sx, sy) => {
      let n = 0;
      while (n <= maxRun && x >= 0 && x < W && y >= 0 && y < H && isBg(x, y)) { x += sx; y += sy; n++; }
      return x < 0 || x >= W || y < 0 || y >= H || n > maxRun ? null : { n, x, y };
    };
    const cx = Math.round((ink.x0 + ink.x1) / 2), cy = Math.round((ink.y0 + ink.y1) / 2);
    const L = walk(ink.x0 - 2, cy, -1, 0), R = walk(ink.x1 + 1, cy, 1, 0);
    const U = walk(cx, ink.y0 - 2, 0, -1), D = walk(cx, ink.y1 + 1, 0, 1);
    if (!L || !R || !U || !D) return 'left';
    const solidColumn = x => {
      let c = 0;
      for (let y = ink.y0; y < ink.y1; y++) if (!isBg(x, y)) c++;
      return c >= 0.9 * h;
    };
    const solidRow = y => {
      let c = 0;
      for (let x = ink.x0; x < ink.x1; x++) if (!isBg(x, y)) c++;
      return c >= 0.9 * (ink.x1 - ink.x0);
    };
    if (!solidColumn(L.x) || !solidColumn(R.x) || !solidRow(U.y) || !solidRow(D.y)) return 'left';
    const sym = (a, b) => Math.abs(a - b) <= Math.max(3, 0.2 * (a + b));
    return sym(L.n, R.n) && sym(U.n, D.n) ? 'center' : 'left';
  }

  // Compute which pixels to erase and what to replace them with.
  function buildErase(item, img) {
    if (item.erase) return item.erase;
    const { width: W, height: H, data } = img;
    const h = item.y1 - item.y0;
    const dil = (h > 28 ? 2 : 1) + (item.bgUniform ? 0 : 1);
    const e = item.eraseBox;
    const r = { x0: Math.max(0, e.x0 - dil - 2), y0: Math.max(0, e.y0 - dil - 2), x1: Math.min(W, e.x1 + dil + 2), y1: Math.min(H, e.y1 + dil + 2) };
    const rw = r.x1 - r.x0, rh = r.y1 - r.y0;
    const [br, bg, bb] = item.bg;
    const thresh = Math.max(10, item.contrast * 0.12);

    // Flat background: anything that isn't the background color is text.
    // Varying background: use coverage toward the text color, which ignores the
    // background's own variation; dilate a bit more to catch soft edges.
    const raw = new Uint8Array(rw * rh);
    const ew = e.x1 - e.x0;
    for (let y = e.y0; y < e.y1; y++) {
      for (let x = e.x0; x < e.x1; x++) {
        const i = (y * W + x) * 4;
        const on = item.bgUniform
          ? Math.hypot(data[i] - br, data[i + 1] - bg, data[i + 2] - bb) > thresh
          : item.alpha[(y - e.y0) * ew + (x - e.x0)] > 0.25;
        if (on) raw[(y - r.y0) * rw + (x - r.x0)] = 1;
      }
    }
    // Dilate to catch faint anti-aliased edges.
    const mask = new Uint8Array(rw * rh);
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        if (!raw[y * rw + x]) continue;
        for (let dy = -dil; dy <= dil; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= rh) continue;
          for (let dx = -dil; dx <= dil; dx++) {
            const xx = x + dx;
            if (xx >= 0 && xx < rw) mask[yy * rw + xx] = 1;
          }
        }
      }
    }

    const count = mask.reduce((s, v) => s + v, 0);
    const idx = new Int32Array(count);
    const rgb = new Uint8ClampedArray(count * 3);

    if (item.bgUniform) {
      let k = 0;
      for (let p = 0; p < mask.length; p++) {
        if (!mask[p]) continue;
        idx[k] = (r.y0 + Math.floor(p / rw)) * W + r.x0 + (p % rw);
        rgb[k * 3] = br; rgb[k * 3 + 1] = bg; rgb[k * 3 + 2] = bb;
        k++;
      }
    } else {
      // Fill each masked pixel from the nearest clean pixel left, right, above and
      // below, weighted by inverse distance: smooth across gradients, no streaks.
      const buf = new Float32Array(rw * rh * 3);
      for (let y = 0; y < rh; y++) {
        for (let x = 0; x < rw; x++) {
          const p = y * rw + x;
          const i = ((y + r.y0) * W + x + r.x0) * 4;
          if (!mask[p]) {
            buf[p * 3] = data[i]; buf[p * 3 + 1] = data[i + 1]; buf[p * 3 + 2] = data[i + 2];
            continue;
          }
          let sr = 0, sg = 0, sb = 0, sw = 0;
          for (const [sx, sy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            let xx = x + sx, yy = y + sy, d = 1;
            while (xx >= 0 && xx < rw && yy >= 0 && yy < rh && mask[yy * rw + xx]) { xx += sx; yy += sy; d++; }
            if (xx < 0 || xx >= rw || yy < 0 || yy >= rh) continue;
            const j = ((yy + r.y0) * W + xx + r.x0) * 4, w = 1 / d;
            sr += data[j] * w; sg += data[j + 1] * w; sb += data[j + 2] * w; sw += w;
          }
          if (sw === 0) { sr = item.bg[0]; sg = item.bg[1]; sb = item.bg[2]; sw = 1; }
          buf[p * 3] = sr / sw; buf[p * 3 + 1] = sg / sw; buf[p * 3 + 2] = sb / sw;
        }
      }
      // Inpainting is smooth; re-add grain sampled from the surrounding background
      // (pixel minus its local mean) so noisy/photographic areas don't look smudged.
      const grain = [];
      for (let y = 2; y < rh - 2; y++) {
        for (let x = 2; x < rw - 2; x++) {
          let clean = true;
          for (let dy = -2; dy <= 2 && clean; dy++) for (let dx = -2; dx <= 2 && clean; dx++) clean = !mask[(y + dy) * rw + x + dx];
          if (!clean) continue;
          const i = ((y + r.y0) * W + x + r.x0) * 4;
          let mr = 0, mg = 0, mb = 0;
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const j = ((y + dy + r.y0) * W + x + dx + r.x0) * 4;
              mr += data[j]; mg += data[j + 1]; mb += data[j + 2];
            }
          }
          grain.push(data[i] - mr / 25, data[i + 1] - mg / 25, data[i + 2] - mb / 25);
        }
      }
      let seed = 12345;
      const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      const ng = grain.length / 3;
      let k = 0;
      for (let p = 0; p < mask.length; p++) {
        if (!mask[p]) continue;
        idx[k] = (r.y0 + Math.floor(p / rw)) * W + r.x0 + (p % rw);
        const g = ng ? Math.floor(rand() * ng) * 3 : -1;
        rgb[k * 3] = buf[p * 3] + (g >= 0 ? grain[g] : 0);
        rgb[k * 3 + 1] = buf[p * 3 + 1] + (g >= 0 ? grain[g + 1] : 0);
        rgb[k * 3 + 2] = buf[p * 3 + 2] + (g >= 0 ? grain[g + 2] : 0);
        k++;
      }
    }
    item.erase = { idx, rgb };
    return item.erase;
  }

  function applyErase(item, img, target) {
    const { idx, rgb } = buildErase(item, img);
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k] * 4;
      target[i] = rgb[k * 3]; target[i + 1] = rgb[k * 3 + 1]; target[i + 2] = rgb[k * 3 + 2]; target[i + 3] = 255;
    }
  }

  // --- Text measuring helpers (shared with font matching) ---------------------
  const hasLetterSpacing = 'letterSpacing' in document.createElement('canvas').getContext('2d');

  function measure(ctx, text) {
    const m = ctx.measureText(text);
    return { left: m.actualBoundingBoxLeft, right: m.actualBoundingBoxRight, asc: m.actualBoundingBoxAscent, desc: m.actualBoundingBoxDescent };
  }

  function setSpacing(ctx, px) {
    if (hasLetterSpacing) ctx.letterSpacing = `${px}px`;
  }

  return { colors, analyze, buildErase, applyErase, measure, setSpacing, toHex, hasLetterSpacing };
})();
