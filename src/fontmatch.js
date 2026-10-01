// Font matching: find the font, weight, size, letter spacing and sub-pixel position
// whose rendering best reproduces the original pixels of a text item.
//
// Candidates are drawn the same way the original was (detected text color on the
// detected background), so anti-aliasing and the "light text looks bolder" effect are
// reproduced too.
//   Stage 1: every font/weight, size fitted to the measured word widths (and, as a
//            second hypothesis, to the height with letter spacing filling the width),
//            scored on blurred masks so small offsets don't dominate. Keep the best few.
//   Stage 2: refine size and sub-pixel offset for those, scored on exact pixels.
const FontMatch = (() => {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const mc = document.createElement('canvas');
  const mctx = mc.getContext('2d', { willReadFrequently: true });
  const { measure, setSpacing, hasLetterSpacing } = Analyze;
  const MAX_WIDTH = 220;
  const SHORTLIST = 4;

  // 3x3 [1 2 1] blur: makes comparisons tolerant of sub-pixel misalignment.
  function blur(src, w, h) {
    const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        tmp[p] = (src[x > 0 ? p - 1 : p] + 2 * src[p] + src[x < w - 1 ? p + 1 : p]) / 4;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        out[p] = (tmp[y > 0 ? p - w : p] + 2 * tmp[p] + tmp[y < h - 1 ? p + w : p]) / 4;
      }
    }
    return out;
  }

  function softIoU(a, b) {
    let inter = 0, union = 0;
    for (let p = 0; p < a.length; p++) {
      inter += Math.min(a[p], b[p]);
      union += Math.max(a[p], b[p]);
    }
    return union > 0 ? inter / union : 0;
  }

  // Sub-pixel ink extent of each OCR word (image coordinates). The partial coverage of
  // an edge column tells how far into that pixel the glyph edge lies.
  function wordSpans(item) {
    const e = item.eraseBox, ew = e.x1 - e.x0, A = item.alpha, ink = item.ink;
    const colMax = x => {
      let m = 0;
      for (let y = ink.y0 - e.y0; y < ink.y1 - e.y0; y++) m = Math.max(m, A[y * ew + x]);
      return m;
    };
    const words = item.words && item.words.length ? item.words : [{ text: item.text, x0: ink.x0, x1: ink.x1 }];
    return words.map(wd => {
      const a = clamp(Math.floor(wd.x0) - e.x0 - 1, 0, ew - 1), b = clamp(Math.ceil(wd.x1) - e.x0 + 1, 1, ew);
      let lo = -1, hi = -1;
      for (let x = a; x < b; x++) if (colMax(x) > 0.15) { if (lo < 0) lo = x; hi = x; }
      if (lo < 0) return { text: wd.text.trim(), x0: e.x0 + a, x1: e.x0 + b };
      return { text: wd.text.trim(), x0: e.x0 + lo + 1 - colMax(lo), x1: e.x0 + hi + colMax(hi) };
    }).filter(sp => sp.text);
  }

  function rowExtent(item, xa, xb) {
    const e = item.eraseBox, ew = e.x1 - e.x0, eh = e.y1 - e.y0, A = item.alpha, ink = item.ink;
    const rowMax = y => {
      let m = 0;
      for (let x = xa - e.x0; x < xb - e.x0; x++) m = Math.max(m, A[y * ew + x]);
      return m;
    };
    let lo = -1, hi = -1;
    for (let y = 0; y < eh; y++) if (rowMax(y) > 0.15) { if (lo < 0) lo = y; hi = y; }
    if (lo < 0) return { y0: ink.y0, y1: ink.y1 };
    return { y0: e.y0 + lo + 1 - rowMax(lo), y1: e.y0 + hi + rowMax(hi) };
  }

  function match(item, candidates) {
    const text = item.text.trim();
    const ink = item.ink;
    const inkH0 = ink.y1 - ink.y0;
    const fallbackFamily = (candidates.find(f => f.family === 'Arial') || candidates[0] || { family: 'Arial' }).family;
    const fallback = () => ({
      family: fallbackFamily, weight: 400, italic: false, size: Math.max(6, inkH0 / 0.72),
      letterSpacing: 0, iou: 0, originX: ink.x0, baseline: ink.y1,
    });
    if (!text || ink.x1 - ink.x0 < 2 || inkH0 < 2) return fallback();

    // Long lines: the first ~220px of words identify the font just as well, much faster.
    const allSpans = wordSpans(item);
    if (!allSpans.length) return fallback();
    const spans = allSpans.filter((sp, k) => k === 0 || sp.x1 - allSpans[0].x0 <= MAX_WIDTH);

    // Comparison region: ink box plus a 2px margin, so overshoot is penalized too.
    const e = item.eraseBox, ew = e.x1 - e.x0;
    const R = {
      x0: Math.max(e.x0, ink.x0 - 2), y0: Math.max(e.y0, ink.y0 - 2),
      x1: Math.min(e.x1, ink.x1 + 2, Math.ceil(spans[spans.length - 1].x1) + 2), y1: Math.min(e.y1, ink.y1 + 2),
    };
    const rw = R.x1 - R.x0, rh = R.y1 - R.y0;
    const T = new Float32Array(rw * rh);
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) T[y * rw + x] = item.alpha[(y + R.y0 - e.y0) * ew + (x + R.x0 - e.x0)];
    }
    const Tb = blur(T, rw, rh);

    const rows = rowExtent(item, Math.max(ink.x0, R.x0), Math.min(ink.x1, R.x1));
    const targetH = rows.y1 - rows.y0, centerY = (rows.y0 + rows.y1) / 2;
    const targetW = spans.reduce((t, sp) => t + (sp.x1 - sp.x0), 0);
    const gaps = spans.reduce((t, sp) => t + [...sp.text].length - 1, 0);

    mc.width = rw; mc.height = rh;
    const [br, bg, bb] = item.bg;
    const vr = item.color[0] - br, vg = item.color[1] - bg, vb = item.color[2] - bb;
    const vv = Math.max(1, vr * vr + vg * vg + vb * vb);
    const bgCss = `rgb(${br},${bg},${bb})`, fgCss = `rgb(${item.color.join(',')})`;

    // measureText is slow on every new font size, so words are measured once at 100px
    // per font and scaled; letter spacing widens a word by ls per inner character gap.
    const base = new Map();
    const metrics = (family, weight, size, ls) => {
      const key = `${weight} ${family}`;
      if (!base.has(key)) {
        mctx.setTransform(1, 0, 0, 1, 0, 0);
        mctx.font = Fonts.fontStr(family, weight, 100, false);
        setSpacing(mctx, 0);
        base.set(key, spans.map(sp => measure(mctx, sp.text)));
      }
      const k = size / 100;
      const ms = base.get(key).map((m, i) => ({
        left: m.left * k,
        right: m.right * k + ls * ([...spans[i].text].length - 1),
        asc: m.asc * k,
        desc: m.desc * k,
      }));
      return {
        ms,
        asc: Math.max(...ms.map(m => m.asc)),
        desc: Math.max(...ms.map(m => m.desc)),
        w: ms.reduce((t, m) => t + m.left + m.right, 0),
      };
    };

    const hypothesis = (family, weight, size, ls) => {
      if (!(size > 1)) return null;
      const met = metrics(family, weight, size, ls);
      if (met.asc + met.desc <= 0) return null;
      return { family, weight, size, ls, met };
    };

    // Draw each word centered on its measured position; returns coverage over R.
    const render = (h, dx, dy) => {
      const { ms, asc, desc } = h.met;
      mctx.setTransform(1, 0, 0, 1, 0, 0);
      mctx.font = Fonts.fontStr(h.family, h.weight, h.size, false);
      setSpacing(mctx, h.ls);
      mctx.fillStyle = bgCss;
      mctx.fillRect(0, 0, rw, rh);
      mctx.fillStyle = fgCss;
      const baseline = centerY - (desc - asc) / 2 + dy;
      const xs = spans.map((sp, k) => (sp.x0 + sp.x1) / 2 - (ms[k].right - ms[k].left) / 2 + dx);
      spans.forEach((sp, k) => mctx.fillText(sp.text, xs[k] - R.x0, baseline - R.y0));
      const px = mctx.getImageData(0, 0, rw, rh).data;
      const B = new Float32Array(rw * rh);
      for (let p = 0; p < B.length; p++) {
        const i = p * 4;
        B[p] = clamp(((px[i] - br) * vr + (px[i + 1] - bg) * vg + (px[i + 2] - bb) * vb) / vv, 0, 1);
      }
      return { B, originX: xs[0], baseline };
    };

    // Stage 1
    const coarse = [];
    for (const f of candidates) {
      for (const weight of f.weights) {
        const m100 = metrics(f.family, weight, 100, 0);
        if (m100.w <= 0 || m100.asc + m100.desc <= 0) continue;
        const sizeW = (100 * targetW) / m100.w;
        const sizeH = (100 * targetH) / (m100.asc + m100.desc);
        const lsH = hasLetterSpacing && gaps > 0
          ? clamp((targetW - (m100.w * sizeH) / 100) / gaps, -0.1 * sizeH, 0.4 * sizeH) : 0;
        for (const h of [hypothesis(f.family, weight, sizeW, 0), hypothesis(f.family, weight, sizeH, lsH)]) {
          if (!h) continue;
          const predH = h.met.asc + h.met.desc;
          const hPen = Math.max(0, Math.abs(predH - targetH) - 1) / targetH;
          h.score = 1 - softIoU(Tb, blur(render(h, 0, 0).B, rw, rh)) + hPen + 0.6 * Math.abs(h.ls) / h.size;
          coarse.push(h);
        }
      }
    }
    if (!coarse.length) return fallback();
    coarse.sort((a, b) => a.score - b.score);
    const shortlist = [];
    for (const h of coarse) {
      if (shortlist.length >= SHORTLIST) break;
      if (!shortlist.some(s => s.family === h.family && s.weight === h.weight && (s.ls === 0) === (h.ls === 0))) shortlist.push(h);
    }

    // Stage 2
    let best = null;
    const consider = (h, dx, dy) => {
      const r = render(h, dx, dy);
      const iou = softIoU(T, r.B);
      const score = 1 - iou + 0.6 * Math.abs(h.ls) / h.size;
      if (!best || score < best.score) best = { ...h, iou, score, originX: r.originX, baseline: r.baseline };
      return score;
    };
    for (const h0 of shortlist) {
      const s0 = h0.size;
      const sizes = new Set([s0, s0 * 0.98, s0 * 1.02, Math.round(s0), Math.round(s0 * 2) / 2]);
      for (const size of sizes) {
        let ls = 0;
        if (h0.ls !== 0) {
          const m = metrics(h0.family, h0.weight, size, 0);
          ls = clamp((targetW - m.w) / Math.max(1, gaps), -0.1 * size, 0.4 * size);
        }
        const h = hypothesis(h0.family, h0.weight, size, ls);
        if (!h) continue;
        let bx = 0, by = 0, bs = Infinity;
        for (const dx of [-0.5, 0, 0.5]) {
          for (const dy of [-0.5, 0, 0.5]) {
            const sc = consider(h, dx, dy);
            if (sc < bs) { bs = sc; bx = dx; by = dy; }
          }
        }
        for (const dx of [-0.25, 0, 0.25]) {
          for (const dy of [-0.25, 0, 0.25]) if (dx || dy) consider(h, bx + dx, by + dy);
        }
      }
    }
    setSpacing(mctx, 0);
    mctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!best) return fallback();
    return {
      family: best.family, weight: best.weight, italic: false, size: best.size, letterSpacing: best.ls,
      iou: best.iou, originX: best.originX, baseline: best.baseline,
    };
  }

  return { match };
})();
