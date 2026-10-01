// UI: loading images, detection flow, selection/editing, compositing, export.
(() => {
  const $ = id => document.getElementById(id);
  const els = {
    fileInput: $('fileInput'), modeSelect: $('modeSelect'), addRegionBtn: $('addRegionBtn'),
    showBoxes: $('showBoxes'), compareBtn: $('compareBtn'), zoomIn: $('zoomIn'), zoomOut: $('zoomOut'),
    zoomFit: $('zoomFit'), resetAllBtn: $('resetAllBtn'), downloadBtn: $('downloadBtn'),
    stageWrap: $('stageWrap'), dropzone: $('dropzone'), stage: $('stage'), view: $('view'),
    overlay: $('overlay'), dragRect: $('dragRect'), status: $('status'), progress: $('progress'),
    progressBar: $('progressBar'), editor: $('editor'), origText: $('origText'), origConf: $('origConf'),
    textInput: $('textInput'), fontSelect: $('fontSelect'), matchInfo: $('matchInfo'),
    weightSelect: $('weightSelect'), sizeInput: $('sizeInput'), spacingInput: $('spacingInput'),
    colorInput: $('colorInput'), alignSeg: $('alignSeg'), dxInput: $('dxInput'), dyInput: $('dyInput'),
    italicInput: $('italicInput'), rematchBtn: $('rematchBtn'), eraseBtn: $('eraseBtn'), resetBtn: $('resetBtn'),
    filterInput: $('filterInput'), itemList: $('itemList'),
  };
  const vctx = els.view.getContext('2d');

  const state = {
    name: 'image', W: 0, H: 0, src: null, orig: null,
    erased: null, erasedKey: null,
    items: [], nextId: 1, selected: null,
    zoom: 1, adding: false, busy: false, renderQueued: false,
  };

  // ---------- helpers ----------
  const setStatus = msg => { els.status.textContent = msg; };
  const setProgress = p => {
    els.progress.hidden = p == null;
    if (p != null) els.progressBar.style.width = `${Math.round(p * 100)}%`;
  };
  const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

  function candidates() {
    return Fonts.available.length ? Fonts.available : Fonts.all;
  }

  function populateFonts() {
    const fams = candidates().map(f => f.family);
    const cur = els.fontSelect.value;
    els.fontSelect.innerHTML = '';
    for (const f of fams) {
      const o = document.createElement('option');
      o.value = o.textContent = f;
      els.fontSelect.appendChild(o);
    }
    if (cur) els.fontSelect.value = cur;
  }
  populateFonts();
  Fonts.ready().then(() => {
    populateFonts();
    // Matches made before web fonts finished loading may be wrong; redo them.
    for (const it of state.items) if (!it.edited) { it.match = null; it.style = null; }
    if (state.selected) fillEditor(state.selected);
  });

  // ---------- loading ----------
  async function loadFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    if (state.busy) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    try { await img.decode(); } catch { setStatus('Could not read that image.'); return; }
    state.name = (file.name || 'screenshot').replace(/\.[^.]+$/, '') || 'screenshot';
    setup(img);
    URL.revokeObjectURL(url);
  }

  function setup(img) {
    const W = img.naturalWidth, H = img.naturalHeight;
    state.W = W; state.H = H;
    const src = document.createElement('canvas');
    src.width = W; src.height = H;
    const sctx = src.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(img, 0, 0);
    state.src = src;
    state.orig = sctx.getImageData(0, 0, W, H);
    state.erased = null; state.erasedKey = null;
    state.items = []; state.selected = null;

    els.view.width = W; els.view.height = H;
    vctx.putImageData(state.orig, 0, 0);
    els.dropzone.hidden = true;
    els.stage.hidden = false;
    for (const b of [els.addRegionBtn, els.compareBtn, els.resetAllBtn, els.downloadBtn]) b.disabled = false;
    els.editor.hidden = true;
    fitZoom();
    renderOverlay(); renderList();
    detectAll();
  }

  // ---------- detection ----------
  function makeItem(line) {
    const it = {
      id: state.nextId++,
      x0: line.x0, y0: line.y0, x1: line.x1, y1: line.y1,
      text: line.text, conf: line.conf, newText: line.text, words: line.words || [],
      edited: false, match: null, style: null,
    };
    Analyze.analyze(it, state.orig);
    return it;
  }

  async function runOCR(rect, opts) {
    const words = await OCR.detect(state.src, rect, opts);
    for (const w of words) w.color = Analyze.colors(w, state.orig).color;
    return OCR.groupLines(words);
  }

  async function detectAll() {
    state.busy = true;
    els.addRegionBtn.disabled = true;
    setStatus('Loading OCR engine…');
    setProgress(0);
    try {
      await OCR.warmUp();
      setStatus('Detecting text…');
      const psm = els.modeSelect.value === 'auto' ? 3 : 11;
      const lines = await runOCR({ x: 0, y: 0, w: state.W, h: state.H }, { psm, onProgress: setProgress });
      state.items = lines.map(makeItem);
      renderOverlay(); renderList();
      setStatus(state.items.length
        ? `Found ${state.items.length} text line${state.items.length > 1 ? 's' : ''}. Click one to edit it. Use "+ Region" for anything that was missed.`
        : 'No text detected. Use "+ Region" to drag a box around the text.');
      backgroundMatch();
    } catch (err) {
      console.error(err);
      setStatus(`Detection failed: ${err.message || err}. Check your internet connection (the OCR engine loads from a CDN).`);
    } finally {
      setProgress(null);
      state.busy = false;
      els.addRegionBtn.disabled = false;
    }
  }

  async function detectRegion(rect) {
    state.busy = true;
    setStatus('Reading the selected region…');
    setProgress(0);
    try {
      let lines = await runOCR(rect, { psm: 6, regionMode: true, onProgress: setProgress });
      if (!lines.length) lines = [{ x0: rect.x, y0: rect.y, x1: rect.x + rect.w, y1: rect.y + rect.h, text: '', conf: 0 }];
      const fresh = lines.map(makeItem);
      // Replace any existing items this region covers.
      state.items = state.items.filter(it => !fresh.some(f => OCR.overlapRatio(f, it) > 0.5));
      state.items.push(...fresh);
      state.items.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
      state.erasedKey = null;
      renderOverlay(); renderList();
      setStatus(fresh[0].text ? `Added ${fresh.length} line${fresh.length > 1 ? 's' : ''}.` : 'No text recognized there; added an empty box you can type into.');
      select(fresh[0]);
      scheduleRender();
    } catch (err) {
      console.error(err);
      setStatus(`Region detection failed: ${err.message || err}`);
    } finally {
      setProgress(null);
      state.busy = false;
    }
  }

  // ---------- font matching ----------
  function ensureMatched(it) {
    if (!it.match) it.match = FontMatch.match(it, candidates());
    if (!it.style) resetStyle(it);
  }

  function resetStyle(it) {
    const m = it.match;
    it.style = {
      family: m.family, weight: m.weight, italic: m.italic,
      size: m.size, letterSpacing: m.letterSpacing,
      color: Analyze.toHex(it.color), align: it.autoAlign || 'left', dx: 0, dy: 0,
    };
  }

  async function backgroundMatch() {
    await Fonts.ready();
    const items = state.items;
    for (const it of items) {
      if (items !== state.items) return; // a new image was loaded
      if (!it.match) ensureMatched(it);
      await new Promise(r => setTimeout(r, 0));
    }
  }

  // ---------- rendering ----------
  function scheduleRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(() => { state.renderQueued = false; render(); });
  }

  function render() {
    if (!state.orig) return;
    const edited = state.items.filter(it => it.edited);
    const key = edited.map(it => it.id).join(',');
    if (key !== state.erasedKey) {
      const data = new Uint8ClampedArray(state.orig.data);
      for (const it of edited) Analyze.applyErase(it, state.orig, data);
      state.erased = new ImageData(data, state.W, state.H);
      state.erasedKey = key;
    }
    vctx.putImageData(state.erased, 0, 0);
    for (const it of edited) drawText(vctx, it);
  }

  function drawText(ctx, it) {
    const s = it.style, text = it.newText;
    if (!text) return;
    ctx.save();
    ctx.font = Fonts.fontStr(s.family, s.weight, s.size, s.italic);
    Analyze.setSpacing(ctx, s.letterSpacing);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = s.color;
    const m = Analyze.measure(ctx, text);
    let x = it.match.originX;
    if (s.align === 'right') x = it.ink.x1 - m.right;
    else if (s.align === 'center') x = (it.ink.x0 + it.ink.x1) / 2 - (m.right - m.left) / 2;
    ctx.fillText(text, x + s.dx, it.match.baseline + s.dy);
    Analyze.setSpacing(ctx, 0);
    ctx.restore();
  }

  // ---------- overlay & list ----------
  function renderOverlay() {
    els.overlay.innerHTML = '';
    const { W, H } = state;
    for (const it of state.items) {
      const b = document.createElement('div');
      b.className = 'box' + (it.edited ? ' edited' : '') + (it === state.selected ? ' selected' : '');
      const pad = 2;
      b.style.left = `${((it.x0 - pad) / W) * 100}%`;
      b.style.top = `${((it.y0 - pad) / H) * 100}%`;
      b.style.width = `${((it.x1 - it.x0 + 2 * pad) / W) * 100}%`;
      b.style.height = `${((it.y1 - it.y0 + 2 * pad) / H) * 100}%`;
      b.title = it.text;
      b.addEventListener('click', e => { e.stopPropagation(); select(it); });
      b.addEventListener('dblclick', e => { e.stopPropagation(); select(it); els.textInput.select(); });
      it.boxEl = b;
      els.overlay.appendChild(b);
    }
    els.overlay.classList.toggle('hidden', !els.showBoxes.checked);
  }

  function renderList() {
    const q = els.filterInput.value.trim().toLowerCase();
    els.itemList.innerHTML = '';
    for (const it of state.items) {
      const label = it.edited && it.newText !== it.text ? `${it.text} → ${it.newText || '(erased)'}` : it.text || '(empty box)';
      if (q && !label.toLowerCase().includes(q)) continue;
      const li = document.createElement('li');
      li.className = (it.edited ? 'edited' : '') + (it === state.selected ? ' selected' : '');
      li.innerHTML = '<span class="dot"></span><span class="t"></span>';
      li.querySelector('.t').textContent = label;
      li.addEventListener('click', () => { select(it); it.boxEl && it.boxEl.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }); });
      it.listEl = li;
      els.itemList.appendChild(li);
    }
  }

  function refreshMarks(it) {
    if (it.boxEl) {
      it.boxEl.classList.toggle('edited', it.edited);
      it.boxEl.classList.toggle('selected', it === state.selected);
    }
    if (it.listEl) {
      it.listEl.classList.toggle('edited', it.edited);
      it.listEl.classList.toggle('selected', it === state.selected);
      it.listEl.querySelector('.t').textContent =
        it.edited && it.newText !== it.text ? `${it.text} → ${it.newText || '(erased)'}` : it.text || '(empty box)';
    }
  }

  // ---------- selection & editor ----------
  async function select(it) {
    const prev = state.selected;
    state.selected = it;
    if (prev) refreshMarks(prev);
    refreshMarks(it);
    if (it.listEl) it.listEl.scrollIntoView({ block: 'nearest' });
    if (!it.match) await Fonts.ready();
    ensureMatched(it);
    fillEditor(it);
    els.editor.hidden = false;
    els.textInput.focus();
  }

  function deselect() {
    const prev = state.selected;
    state.selected = null;
    if (prev) refreshMarks(prev);
    els.editor.hidden = true;
  }

  function fillEditor(it) {
    ensureMatched(it);
    const s = it.style;
    els.origText.textContent = it.text || '(nothing recognized)';
    els.origConf.textContent = it.text ? `· ${Math.round(it.conf)}% confident` : '';
    els.textInput.value = it.newText;
    if (![...els.fontSelect.options].some(o => o.value === s.family)) {
      const o = document.createElement('option');
      o.value = o.textContent = s.family;
      els.fontSelect.appendChild(o);
    }
    els.fontSelect.value = s.family;
    if (![...els.weightSelect.options].some(o => +o.value === s.weight)) {
      const o = document.createElement('option');
      o.textContent = s.weight;
      els.weightSelect.appendChild(o);
    }
    els.weightSelect.value = String(s.weight);
    els.sizeInput.value = round(s.size);
    els.spacingInput.value = round(s.letterSpacing);
    els.spacingInput.disabled = !Analyze.hasLetterSpacing;
    els.colorInput.value = s.color;
    els.dxInput.value = s.dx;
    els.dyInput.value = s.dy;
    els.italicInput.checked = s.italic;
    for (const b of els.alignSeg.querySelectorAll('button')) b.classList.toggle('active', b.dataset.align === s.align);
    els.matchInfo.textContent = it.text ? `· auto-matched ${Math.round(it.match.iou * 100)}%` : '';
  }

  function edit(mutator) {
    const it = state.selected;
    if (!it) return;
    ensureMatched(it);
    mutator(it, it.style);
    it.edited = true;
    refreshMarks(it);
    scheduleRender();
  }

  els.textInput.addEventListener('input', () => edit(it => { it.newText = els.textInput.value; }));
  els.textInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const i = state.items.indexOf(state.selected);
      const next = state.items[(i + (e.shiftKey ? -1 : 1) + state.items.length) % state.items.length];
      if (next) select(next);
    } else if (e.key === 'Escape') {
      deselect();
    }
  });
  els.fontSelect.addEventListener('change', () => edit((it, s) => { s.family = els.fontSelect.value; }));
  els.weightSelect.addEventListener('change', () => edit((it, s) => { s.weight = +els.weightSelect.value; }));
  els.sizeInput.addEventListener('input', () => edit((it, s) => { const v = +els.sizeInput.value; if (v > 0) s.size = v; }));
  els.spacingInput.addEventListener('input', () => edit((it, s) => { s.letterSpacing = +els.spacingInput.value || 0; }));
  els.colorInput.addEventListener('input', () => edit((it, s) => { s.color = els.colorInput.value; }));
  els.dxInput.addEventListener('input', () => edit((it, s) => { s.dx = +els.dxInput.value || 0; }));
  els.dyInput.addEventListener('input', () => edit((it, s) => { s.dy = +els.dyInput.value || 0; }));
  els.italicInput.addEventListener('change', () => edit((it, s) => { s.italic = els.italicInput.checked; }));
  els.alignSeg.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    edit((it, s) => { s.align = b.dataset.align; });
    for (const x of els.alignSeg.querySelectorAll('button')) x.classList.toggle('active', x === b);
  });

  els.rematchBtn.addEventListener('click', async () => {
    const it = state.selected;
    if (!it) return;
    await Fonts.ready();
    const keepColor = it.style && it.style.color;
    it.match = FontMatch.match(it, candidates());
    resetStyle(it);
    if (keepColor) it.style.color = keepColor;
    fillEditor(it);
    if (it.edited) scheduleRender();
  });
  els.eraseBtn.addEventListener('click', () => {
    edit(it => { it.newText = ''; });
    els.textInput.value = '';
  });
  els.resetBtn.addEventListener('click', () => {
    const it = state.selected;
    if (!it) return;
    it.newText = it.text;
    it.edited = false;
    resetStyle(it);
    fillEditor(it);
    refreshMarks(it);
    scheduleRender();
  });
  els.resetAllBtn.addEventListener('click', () => {
    for (const it of state.items) {
      it.newText = it.text;
      it.edited = false;
      if (it.match) resetStyle(it);
      refreshMarks(it);
    }
    if (state.selected) fillEditor(state.selected);
    scheduleRender();
  });

  els.filterInput.addEventListener('input', renderList);
  els.showBoxes.addEventListener('change', () => els.overlay.classList.toggle('hidden', !els.showBoxes.checked));

  // ---------- compare ----------
  const showOriginal = () => { if (state.orig) vctx.putImageData(state.orig, 0, 0); };
  els.compareBtn.addEventListener('pointerdown', showOriginal);
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) els.compareBtn.addEventListener(ev, () => render());

  // ---------- zoom ----------
  function applyZoom() {
    els.stage.style.width = `${Math.max(1, state.W * state.zoom)}px`;
  }
  function fitZoom() {
    const r = els.stageWrap.getBoundingClientRect();
    const avW = Math.max(100, r.width - 48), avH = Math.max(100, r.height - 48);
    state.zoom = Math.min(1, avW / state.W, avH / state.H);
    applyZoom();
  }
  els.zoomIn.addEventListener('click', () => { state.zoom = Math.min(8, state.zoom * 1.25); applyZoom(); });
  els.zoomOut.addEventListener('click', () => { state.zoom = Math.max(0.05, state.zoom / 1.25); applyZoom(); });
  els.zoomFit.addEventListener('click', fitZoom);

  // ---------- region tool ----------
  els.addRegionBtn.addEventListener('click', () => {
    state.adding = !state.adding;
    els.addRegionBtn.classList.toggle('active', state.adding);
    els.stage.classList.toggle('adding', state.adding);
    if (state.adding) setStatus('Drag a box around the text you want to edit.');
  });

  function toImageCoords(e) {
    const r = els.view.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(state.W, ((e.clientX - r.left) / r.width) * state.W)),
      y: Math.max(0, Math.min(state.H, ((e.clientY - r.top) / r.height) * state.H)),
    };
  }

  let drag = null;
  els.stage.addEventListener('pointerdown', e => {
    if (!state.adding || state.busy) return;
    e.preventDefault();
    drag = { start: toImageCoords(e), end: null };
    els.stage.setPointerCapture(e.pointerId);
  });
  els.stage.addEventListener('pointermove', e => {
    if (!drag) return;
    drag.end = toImageCoords(e);
    const x0 = Math.min(drag.start.x, drag.end.x), y0 = Math.min(drag.start.y, drag.end.y);
    const x1 = Math.max(drag.start.x, drag.end.x), y1 = Math.max(drag.start.y, drag.end.y);
    Object.assign(els.dragRect.style, {
      left: `${(x0 / state.W) * 100}%`, top: `${(y0 / state.H) * 100}%`,
      width: `${((x1 - x0) / state.W) * 100}%`, height: `${((y1 - y0) / state.H) * 100}%`,
    });
    els.dragRect.hidden = false;
  });
  els.stage.addEventListener('pointerup', () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    els.dragRect.hidden = true;
    if (!d.end) return;
    const x0 = Math.floor(Math.min(d.start.x, d.end.x)), y0 = Math.floor(Math.min(d.start.y, d.end.y));
    const x1 = Math.ceil(Math.max(d.start.x, d.end.x)), y1 = Math.ceil(Math.max(d.start.y, d.end.y));
    if (x1 - x0 < 4 || y1 - y0 < 4) return;
    state.adding = false;
    els.addRegionBtn.classList.remove('active');
    els.stage.classList.remove('adding');
    detectRegion({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  });
  els.stage.addEventListener('click', e => {
    if (!state.adding && e.target === els.overlay) deselect();
  });

  // ---------- input sources ----------
  els.fileInput.addEventListener('change', () => { loadFile(els.fileInput.files[0]); els.fileInput.value = ''; });
  els.modeSelect.addEventListener('change', () => { if (state.orig && !state.busy) { state.erasedKey = null; state.selected = null; els.editor.hidden = true; vctx.putImageData(state.orig, 0, 0); detectAll(); } });

  window.addEventListener('paste', e => {
    const file = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith('image/'));
    if (file) { e.preventDefault(); loadFile(file); }
  });
  for (const ev of ['dragenter', 'dragover']) {
    els.stageWrap.addEventListener(ev, e => { e.preventDefault(); els.dropzone.classList.add('hover'); });
  }
  for (const ev of ['dragleave', 'drop']) {
    els.stageWrap.addEventListener(ev, e => { e.preventDefault(); els.dropzone.classList.remove('hover'); });
  }
  els.stageWrap.addEventListener('drop', e => loadFile(e.dataTransfer.files[0]));
  els.dropzone.addEventListener('click', e => { if (e.target.id !== 'sampleBtn') els.fileInput.click(); });
  $('sampleBtn').addEventListener('click', async () => {
    try {
      const res = await fetch('assets/sample.png');
      const blob = await res.blob();
      loadFile(new File([blob], 'sample.png', { type: 'image/png' }));
    } catch {
      setStatus('The sample only loads when the page is served over http(s), e.g. on GitHub Pages or via "python -m http.server".');
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.activeElement === document.body) deselect();
  });

  // ---------- export ----------
  els.downloadBtn.addEventListener('click', () => {
    render();
    els.view.toBlob(blob => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${state.name}-edited.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, 'image/png');
  });

  // Start downloading the OCR engine early so the first detection is faster.
  setTimeout(() => OCR.warmUp().catch(() => {}), 500);

  // Exposed for automated tests.
  window.__app = { state, loadFile, select, render };
})();
