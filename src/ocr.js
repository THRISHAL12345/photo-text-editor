// OCR via Tesseract.js, plus word filtering, de-duplication and line grouping.
const OCR = (() => {
  let workerPromise = null;
  let queue = Promise.resolve();
  let progressCb = null;

  function getWorker() {
    if (!workerPromise) {
      workerPromise = Tesseract.createWorker('eng', 1, {
        logger: m => {
          if (m.status === 'recognizing text' && progressCb) progressCb(m.progress);
        },
      });
    }
    return workerPromise;
  }

  // Tesseract workers process one job at a time; serialize our calls.
  function serial(fn) {
    const p = queue.then(fn);
    queue = p.catch(() => {});
    return p;
  }

  // Build the OCR input: upscaled (OCR is far more accurate on larger glyphs) grayscale.
  // 'normal' is plain grayscale; 'region' redraws text as dark ink on white relative to
  // its own local background, so text on buttons, dark bars and gradients reads like print.
  function prepare(src, rect, scale, mode) {
    const base = document.createElement('canvas');
    base.width = rect.w; base.height = rect.h;
    const bctx = base.getContext('2d', { willReadFrequently: true });
    bctx.drawImage(src, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    const im = bctx.getImageData(0, 0, rect.w, rect.h);
    const gray = mode === 'region' ? regionInk(im.data, rect.w, rect.h) : null;
    const d = im.data;
    for (let p = 0, i = 0; i < d.length; p++, i += 4) {
      const g = gray ? gray[p] : 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      d[i] = d[i + 1] = d[i + 2] = g;
      d[i + 3] = 255;
    }
    bctx.putImageData(im, 0, 0);

    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(rect.w * scale));
    c.height = Math.max(1, Math.round(rect.h * scale));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(base, 0, 0, c.width, c.height);
    return c;
  }

  // Separable box blur of RGBA data (alpha ignored).
  function boxBlur(src, w, h, r) {
    const tmp = new Float32Array(w * h * 4), out = new Float32Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = Math.max(0, x - r), b = Math.min(w - 1, x + r);
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let k = a; k <= b; k++) sum += src[(y * w + k) * 4 + c];
          tmp[(y * w + x) * 4 + c] = sum / (b - a + 1);
        }
      }
    }
    for (let y = 0; y < h; y++) {
      const a = Math.max(0, y - r), b = Math.min(h - 1, y + r);
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let k = a; k <= b; k++) sum += tmp[(k * w + x) * 4 + c];
          out[(y * w + x) * 4 + c] = sum / (b - a + 1);
        }
      }
    }
    return out;
  }

  // Large flat areas (page, bars, buttons, gradients, noisy photos once denoised) are
  // background. Every other pixel takes the color of its nearest background pixel;
  // ink = distance from that color.
  function regionInk(orig, w, h) {
    const n = w * h;
    const d = boxBlur(orig, w, h, 2);
    const diff = (p, q) => {
      const i = p * 4, j = q * 4;
      return Math.abs(d[i] - d[j]) + Math.abs(d[i + 1] - d[j + 1]) + Math.abs(d[i + 2] - d[j + 2]);
    };
    const T = 12;
    const flat = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if ((x > 0 && diff(p, p - 1) >= T) || (x < w - 1 && diff(p, p + 1) >= T) ||
            (y > 0 && diff(p, p - w) >= T) || (y < h - 1 && diff(p, p + w) >= T)) continue;
        flat[p] = 1;
      }
    }
    // Union-find over connected flat pixels.
    const parent = new Int32Array(n).map((_, i) => i);
    const find = p => { while (parent[p] !== p) { parent[p] = parent[parent[p]]; p = parent[p]; } return p; };
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (!flat[p]) continue;
        if (x < w - 1 && flat[p + 1] && diff(p, p + 1) < T) union(p, p + 1);
        if (y < h - 1 && flat[p + w] && diff(p, p + w) < T) union(p, p + w);
      }
    }
    const area = new Int32Array(n), bx0 = new Int32Array(n).fill(w), bx1 = new Int32Array(n).fill(-1);
    const by0 = new Int32Array(n).fill(h), by1 = new Int32Array(n).fill(-1);
    for (let p = 0; p < n; p++) {
      if (!flat[p]) continue;
      const r = find(p), x = p % w, y = (p / w) | 0;
      area[r]++;
      if (x < bx0[r]) bx0[r] = x; if (x > bx1[r]) bx1[r] = x;
      if (y < by0[r]) by0[r] = y; if (y > by1[r]) by1[r] = y;
    }
    // Multi-source BFS from background pixels carries their color outward.
    const src = new Int32Array(n).fill(-1);
    const queue = new Int32Array(n);
    let head = 0, tail = 0;
    for (let p = 0; p < n; p++) {
      if (!flat[p]) continue;
      const r = find(p);
      if (area[r] >= 1200 && bx1[r] - bx0[r] >= 16 && by1[r] - by0[r] >= 12) { src[p] = p; queue[tail++] = p; }
    }
    const out = new Float32Array(n);
    if (!tail) {
      for (let p = 0; p < n; p++) out[p] = 0.299 * orig[p * 4] + 0.587 * orig[p * 4 + 1] + 0.114 * orig[p * 4 + 2];
      return out;
    }
    while (head < tail) {
      const p = queue[head++], x = p % w;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w];
      for (const q of nb) {
        if (q < 0 || q >= n || src[q] !== -1) continue;
        src[q] = src[p];
        queue[tail++] = q;
      }
    }
    for (let p = 0; p < n; p++) {
      const i = p * 4, j = src[p] * 4;
      const ink = Math.hypot(orig[i] - d[j], orig[i + 1] - d[j + 1], orig[i + 2] - d[j + 2]);
      out[p] = 255 - Math.min(255, ink * 1.5);
    }
    return out;
  }

  function collectWords(data) {
    const out = [];
    const push = w => out.push({ text: w.text, conf: w.confidence, ...w.bbox });
    if (data.blocks && data.blocks.length) {
      for (const b of data.blocks)
        for (const p of b.paragraphs || [])
          for (const l of p.lines || [])
            for (const w of l.words || []) push(w);
    } else if (data.words) {
      data.words.forEach(push);
    }
    return out;
  }

  async function recognize(canvas, psm, onProgress, extra = {}) {
    return serial(async () => {
      const worker = await getWorker();
      progressCb = onProgress;
      await worker.setParameters({ tessedit_pageseg_mode: String(psm), preserve_interword_spaces: '1', thresholding_method: '0', ...extra });
      const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true });
      progressCb = null;
      return collectWords(data);
    });
  }

  function chooseScale(rect, regionMode) {
    if (regionMode) return Math.min(4, Math.max(1, 64 / Math.max(8, rect.h)));
    const px = rect.w * rect.h;
    if (px <= 2.5e6) return 2;
    if (px <= 5e6) return 1.5;
    return 1;
  }

  const hasAlnum = s => /[\p{L}\p{N}]/u.test(s);

  function overlapRatio(a, b) {
    const iw = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    const ih = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    if (iw <= 0 || ih <= 0) return 0;
    const areaA = (a.x1 - a.x0) * (a.y1 - a.y0), areaB = (b.x1 - b.x0) * (b.y1 - b.y0);
    return (iw * ih) / Math.min(areaA, areaB);
  }

  // Keep confident words; when two passes found the same word, keep the better one.
  function mergeWords(words) {
    const good = words.filter(w => {
      const t = (w.text || '').trim();
      if (!t || w.conf < 40) return false;
      if (!hasAlnum(t) && w.conf < 85) return false;
      const h = w.y1 - w.y0, wd = w.x1 - w.x0;
      return h >= 4 && wd >= 2;
    });
    good.sort((a, b) => b.conf - a.conf);
    const kept = [];
    for (const w of good) {
      if (!kept.some(k => overlapRatio(k, w) > 0.4)) kept.push(w);
    }
    return kept;
  }

  // Run OCR over a rect of the source canvas. Returns words in source coordinates.
  async function detect(src, rect, { psm = 11, passes = ['normal', 'region'], regionMode = false, params = {}, onProgress } = {}) {
    const scale = chooseScale(rect, regionMode);
    const all = [];
    for (let i = 0; i < passes.length; i++) {
      const c = prepare(src, rect, scale, passes[i]);
      const words = await recognize(c, psm, p => onProgress && onProgress((i + p) / passes.length), params);
      for (const w of words) {
        all.push({
          text: w.text.trim(),
          conf: w.conf,
          x0: rect.x + w.x0 / scale,
          y0: rect.y + w.y0 / scale,
          x1: rect.x + w.x1 / scale,
          y1: rect.y + w.y1 / scale,
        });
      }
    }
    return mergeWords(all);
  }

  // Group words into editable lines: same row, small horizontal gap, similar color.
  function groupLines(words) {
    const sorted = [...words].sort((a, b) => a.x0 - b.x0);
    const lines = [];
    for (const w of sorted) {
      const wh = w.y1 - w.y0;
      let best = null, bestGap = Infinity;
      for (const L of lines) {
        const lh = L.y1 - L.y0;
        const ov = Math.min(w.y1, L.y1) - Math.max(w.y0, L.y0);
        if (ov < 0.5 * Math.min(wh, lh)) continue;
        if (wh > 2.2 * L.refH || L.refH > 2.2 * wh) continue;
        const gap = w.x0 - L.lastX1;
        const charW = ((w.x1 - w.x0) / Math.max(1, w.text.length) + L.charW) / 2;
        if (gap < -0.25 * L.refH || gap > Math.max(0.65 * L.refH, 1.4 * charW)) continue;
        if (w.color && L.color) {
          const cd = Math.hypot(w.color[0] - L.color[0], w.color[1] - L.color[1], w.color[2] - L.color[2]);
          if (cd > 70) continue;
        }
        if (gap < bestGap) { best = L; bestGap = gap; }
      }
      if (best) {
        best.words.push(w);
        best.x0 = Math.min(best.x0, w.x0); best.y0 = Math.min(best.y0, w.y0);
        best.x1 = Math.max(best.x1, w.x1); best.y1 = Math.max(best.y1, w.y1);
        best.lastX1 = w.x1;
        best.refH = Math.max(best.refH, wh);
        best.charW = (best.x1 - best.x0) / Math.max(1, best.words.reduce((t, x) => t + x.text.length + 1, -1));
      } else {
        lines.push({ words: [w], x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1, lastX1: w.x1, refH: wh, color: w.color, charW: (w.x1 - w.x0) / Math.max(1, w.text.length) });
      }
    }
    return lines
      .map(L => ({
        x0: L.x0, y0: L.y0, x1: L.x1, y1: L.y1,
        text: L.words.map(w => w.text).join(' '),
        conf: L.words.reduce((s, w) => s + w.conf, 0) / L.words.length,
        words: L.words.map(w => ({ text: w.text, x0: w.x0, x1: w.x1 })),
      }))
      .filter(L => L.conf >= 55 || (L.text.length >= 4 && L.conf >= 45))
      .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  }

  return { detect, groupLines, overlapRatio, warmUp: getWorker };
})();
