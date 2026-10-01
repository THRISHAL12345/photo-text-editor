// UI: loading images, detection flow, selection/editing, compositing, export.
(() => {
  const $ = id => document.getElementById(id);
  const els = {
    fileInput: $('fileInput'), modeSelect: $('modeSelect'), addRegionBtn: $('addRegionBtn'),
    fontInput: $('fontInput'), undoBtn: $('undoBtn'), redoBtn: $('redoBtn'),
    showBoxes: $('showBoxes'), compareBtn: $('compareBtn'), zoomIn: $('zoomIn'), zoomOut: $('zoomOut'),
    zoomFit: $('zoomFit'), resetAllBtn: $('resetAllBtn'), copyBtn: $('copyBtn'), downloadBtn: $('downloadBtn'),
    stageWrap: $('stageWrap'), dropzone: $('dropzone'), stage: $('stage'), view: $('view'),
    overlay: $('overlay'), dragRect: $('dragRect'), status: $('status'), progress: $('progress'),
    progressBar: $('progressBar'), editor: $('editor'), origText: $('origText'), origConf: $('origConf'),
    textInput: $('textInput'), fontSelect: $('fontSelect'), matchInfo: $('matchInfo'),
    weightSelect: $('weightSelect'), sizeInput: $('sizeInput'), spacingInput: $('spacingInput'),
    colorInput: $('colorInput'), alignSeg: $('alignSeg'), dxInput: $('dxInput'), dyInput: $('dyInput'),
    italicInput: $('italicInput'), rematchBtn: $('rematchBtn'), eraseBtn: $('eraseBtn'), resetBtn: $('resetBtn'),
    findPanel: $('findPanel'), findInput: $('findInput'), replaceInput: $('replaceInput'),
    matchCase: $('matchCase'), findCount: $('findCount'), replaceAllBtn: $('replaceAllBtn'),
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
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const nextTick = () => new Promise(r => setTimeout(r, 0));
  const isTyping = el => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');

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
    rematchUnedited();
  });

  // Matches made before a font became available may be wrong; redo them.
  function rematchUnedited() {
    for (const it of state.items) if (!it.edited) { it.match = null; it.style = null; }
    if (state.selected) fillEditor(state.selected);
    backgroundMatch();
  }

  // ---------- undo / redo ----------
  // Snapshots hold the item list (the region tool can replace items) and each
  // item's editable fields. Consecutive edits of the same kind on the same item
  // (typing, dragging a slider) are merged into one step.
  const history = { undo: [], redo: [], lastKey: null, lastTime: 0 };

  function snapshot() {
    return {
      items: [...state.items],
      vals: state.items.map(it => ({ it, newText: it.newText, edited: it.edited, style: it.style && { ...it.style } })),
    };
  }

  function checkpoint(key = null) {
    const now = Date.now();
    if (key && key === history.lastKey && now - history.lastTime < 1000) {
      history.lastTime = now;
      return;
    }
    history.undo.push(snapshot());
    if (history.undo.length > 200) history.undo.shift();
    history.redo = [];
    history.lastKey = key;
    history.lastTime = now;
    updateHistoryButtons();
  }

  function restore(snap) {
    state.items = snap.items;
    for (const v of snap.vals) {
      v.it.newText = v.newText;
      v.it.edited = v.edited;
      v.it.style = v.style && { ...v.style };
    }
    if (state.selected && !state.items.includes(state.selected)) deselect();
    renderOverlay(); renderList(); updateFind();
    if (state.selected) fillEditor(state.selected);
    scheduleRender();
  }

  function undo() {
    if (!history.undo.length) return;
    history.redo.push(snapshot());
    restore(history.undo.pop());
    history.lastKey = null;
    updateHistoryButtons();
  }

  function redo() {
    if (!history.redo.length) return;
    history.undo.push(snapshot());
    restore(history.redo.pop());
    history.lastKey = null;
    updateHistoryButtons();
  }

  function clearHistory() {
    history.undo = []; history.redo = []; history.lastKey = null;
    updateHistoryButtons();
  }

  function updateHistoryButtons() {
    els.undoBtn.disabled = !history.undo.length;
    els.redoBtn.disabled = !history.redo.length;
  }

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
    clearHistory();

    els.view.width = W; els.view.height = H;
    vctx.putImageData(state.orig, 0, 0);
    els.dropzone.hidden = true;
    els.stage.hidden = false;
    els.findPanel.hidden = false;
    for (const b of [els.addRegionBtn, els.compareBtn, els.resetAllBtn, els.copyBtn, els.downloadBtn]) b.disabled = false;
    els.editor.hidden = true;
    fitZoom();
    renderOverlay(); renderList(); updateFind();
    detectAll();
  }

  async function addFonts(files) {
    const fonts = [...files].filter(f => Fonts.isFontFile(f));
    if (!fonts.length) return;
    const added = [];
    for (const f of fonts) {
      try {
        const r = await Fonts.addFontFile(f);
        added.push(`${r.family} ${r.weight}${r.italic ? ' italic' : ''}`);
      } catch (err) {
        console.error(err);
        setStatus(`Couldn't load font "${f.name}": ${err.message || err}`);
        return;
      }
    }
    populateFonts();
    const n = state.items.filter(it => !it.edited).length;
    setStatus(`Added ${added.join(', ')}.${n ? ` Re-matching ${plural(n, 'unedited line')}. Use "Re-match font" for lines you already edited.` : ''}`);
    await Fonts.ready();
    rematchUnedited();
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
      renderOverlay(); renderList(); updateFind();
      setStatus(state.items.length
        ? `Found ${plural(state.items.length, 'text line')}. Click one to edit it. Use "+ Region" for anything that was missed.`
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
      checkpoint();
      // Replace any existing items this region covers.
      state.items = state.items.filter(it => !fresh.some(f => OCR.overlapRatio(f, it) > 0.5));
      state.items.push(...fresh);
      state.items.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
      state.erasedKey = null;
      renderOverlay(); renderList(); updateFind();
      setStatus(fresh[0].text ? `Added ${plural(fresh.length, 'line')}.` : 'No text recognized there; added an empty box you can type into.');
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

  let matchRun = 0;
  async function backgroundMatch() {
    await Fonts.ready();
    const run = ++matchRun;
    for (const it of state.items) {
      if (run !== matchRun) return; // superseded (new image, new fonts)
      if (!it.match) ensureMatched(it);
      await nextTick();
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
    for (const it of state.items) {
      it.drawn = it.edited ? drawText(vctx, it) : null;
      positionBox(it);
    }
  }

  // Draws the item's new text; returns the drawn ink box (image coordinates).
  function drawText(ctx, it) {
    const s = it.style, text = it.newText;
    if (!text) return null;
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
    x += s.dx;
    const y = it.match.baseline + s.dy;
    ctx.fillText(text, x, y);
    Analyze.setSpacing(ctx, 0);
    ctx.restore();
    return { x0: x - m.left, x1: x + m.right, y0: y - m.asc, y1: y + m.desc };
  }

  // ---------- overlay & list ----------
  // Boxes follow the text as drawn, so they stay accurate after edits and moves.
  function positionBox(it) {
    const b = it.boxEl;
    if (!b) return;
    const s = it.style;
    const r = it.drawn
      ? { x0: Math.min(it.drawn.x0, it.x0 + s.dx), y0: Math.min(it.drawn.y0, it.y0 + s.dy), x1: it.drawn.x1, y1: Math.max(it.drawn.y1, it.y1 + s.dy) }
      : it;
    const pad = 2, { W, H } = state;
    b.style.left = `${((r.x0 - pad) / W) * 100}%`;
    b.style.top = `${((r.y0 - pad) / H) * 100}%`;
    b.style.width = `${((r.x1 - r.x0 + 2 * pad) / W) * 100}%`;
    b.style.height = `${((r.y1 - r.y0 + 2 * pad) / H) * 100}%`;
  }

  function renderOverlay() {
    els.overlay.innerHTML = '';
    for (const it of state.items) {
      const b = document.createElement('div');
      b.className = 'box' + (it.edited ? ' edited' : '') + (it === state.selected ? ' selected' : '');
      b.title = it.text;
      b.addEventListener('pointerdown', e => startBoxDrag(e, it));
      b.addEventListener('click', e => {
        e.stopPropagation();
        if (suppressClick) { suppressClick = false; return; }
        select(it);
      });
      b.addEventListener('dblclick', e => { e.stopPropagation(); select(it).then(() => els.textInput.select()); });
      it.boxEl = b;
      positionBox(it);
      els.overlay.appendChild(b);
    }
    els.overlay.classList.toggle('hidden', !els.showBoxes.checked);
  }

  const itemLabel = it =>
    it.edited && it.newText !== it.text ? `${it.text} → ${it.newText || '(erased)'}` : it.text || '(empty box)';

  function renderList() {
    const q = els.filterInput.value.trim().toLowerCase();
    els.itemList.innerHTML = '';
    for (const it of state.items) {
      const label = itemLabel(it);
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
      it.listEl.querySelector('.t').textContent = itemLabel(it);
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
    if (els.textInput.value !== it.newText) els.textInput.value = it.newText;
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
    els.dxInput.value = round(s.dx);
    els.dyInput.value = round(s.dy);
    els.italicInput.checked = s.italic;
    for (const b of els.alignSeg.querySelectorAll('button')) b.classList.toggle('active', b.dataset.align === s.align);
    els.matchInfo.textContent = it.text ? `· auto-matched ${Math.round(it.match.iou * 100)}%` : '';
  }

  // Applies a change to the selected item. `kind` groups rapid edits into one undo step.
  function edit(mutator, kind = null) {
    const it = state.selected;
    if (!it) return;
    ensureMatched(it);
    checkpoint(kind && `${it.id}:${kind}`);
    mutator(it, it.style);
    it.edited = true;
    refreshMarks(it);
    scheduleRender();
  }

  els.textInput.addEventListener('input', () => {
    edit(it => { it.newText = els.textInput.value; }, 'text');
    updateFind();
  });
  els.textInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const i = state.items.indexOf(state.selected);
      const next = state.items[(i + (e.shiftKey ? -1 : 1) + state.items.length) % state.items.length];
      if (next) select(next);
    } else if (e.key === 'Escape') {
      deselect();
      els.textInput.blur();
    }
  });
  els.fontSelect.addEventListener('change', () => edit((it, s) => { s.family = els.fontSelect.value; }));
  els.weightSelect.addEventListener('change', () => edit((it, s) => { s.weight = +els.weightSelect.value; }));
  els.sizeInput.addEventListener('input', () => edit((it, s) => { const v = +els.sizeInput.value; if (v > 0) s.size = v; }, 'size'));
  els.spacingInput.addEventListener('input', () => edit((it, s) => { s.letterSpacing = +els.spacingInput.value || 0; }, 'spacing'));
  els.colorInput.addEventListener('input', () => edit((it, s) => { s.color = els.colorInput.value; }, 'color'));
  els.dxInput.addEventListener('input', () => edit((it, s) => { s.dx = +els.dxInput.value || 0; }, 'move'));
  els.dyInput.addEventListener('input', () => edit((it, s) => { s.dy = +els.dyInput.value || 0; }, 'move'));
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
    checkpoint();
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
    updateFind();
  });
  els.resetBtn.addEventListener('click', () => {
    const it = state.selected;
    if (!it) return;
    checkpoint();
    it.newText = it.text;
    it.edited = false;
    resetStyle(it);
    fillEditor(it);
    refreshMarks(it);
    updateFind();
    scheduleRender();
  });
  els.resetAllBtn.addEventListener('click', () => {
    checkpoint();
    for (const it of state.items) {
      it.newText = it.text;
      it.edited = false;
      if (it.match) resetStyle(it);
      refreshMarks(it);
    }
    if (state.selected) fillEditor(state.selected);
    updateFind();
    scheduleRender();
  });

  els.filterInput.addEventListener('input', renderList);
  els.showBoxes.addEventListener('change', () => els.overlay.classList.toggle('hidden', !els.showBoxes.checked));
  els.undoBtn.addEventListener('click', undo);
  els.redoBtn.addEventListener('click', redo);

  // ---------- drag to move ----------
  let boxDrag = null, suppressClick = false;

  function startBoxDrag(e, it) {
    if (state.adding || e.button !== 0) return;
    e.stopPropagation();
    boxDrag = { it, start: toImageCoords(e), cx: e.clientX, cy: e.clientY, moved: false, id: e.pointerId };
    it.boxEl.setPointerCapture(e.pointerId);
    it.boxEl.addEventListener('pointermove', moveBoxDrag);
    it.boxEl.addEventListener('pointerup', endBoxDrag);
    it.boxEl.addEventListener('pointercancel', endBoxDrag);
  }

  function moveBoxDrag(e) {
    const d = boxDrag;
    if (!d || e.pointerId !== d.id) return;
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.cx, e.clientY - d.cy) < 4) return;
      d.moved = true;
      ensureMatched(d.it);
      if (state.selected !== d.it) select(d.it);
      checkpoint();
      d.dx0 = d.it.style.dx; d.dy0 = d.it.style.dy;
      d.it.boxEl.classList.add('dragging');
    }
    const p = toImageCoords(e);
    const s = d.it.style;
    s.dx = Math.round((d.dx0 + p.x - d.start.x) * 2) / 2;
    s.dy = Math.round((d.dy0 + p.y - d.start.y) * 2) / 2;
    d.it.edited = true;
    refreshMarks(d.it);
    if (state.selected === d.it) { els.dxInput.value = s.dx; els.dyInput.value = s.dy; }
    scheduleRender();
  }

  function endBoxDrag(e) {
    const d = boxDrag;
    if (!d || e.pointerId !== d.id) return;
    const b = d.it.boxEl;
    b.removeEventListener('pointermove', moveBoxDrag);
    b.removeEventListener('pointerup', endBoxDrag);
    b.removeEventListener('pointercancel', endBoxDrag);
    b.classList.remove('dragging');
    if (d.moved) {
      suppressClick = true;
      els.textInput.blur(); // so plain arrow keys fine-tune the position next
    }
    boxDrag = null;
  }

  function nudge(dx, dy) {
    edit((it, s) => { s.dx = round(s.dx + dx); s.dy = round(s.dy + dy); }, 'nudge');
    if (state.selected) { els.dxInput.value = state.selected.style.dx; els.dyInput.value = state.selected.style.dy; }
  }

  // ---------- find & replace ----------
  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const findRe = () => new RegExp(escapeRe(els.findInput.value), els.matchCase.checked ? 'g' : 'gi');

  function updateFind() {
    const q = els.findInput.value;
    let total = 0, lines = 0;
    for (const it of state.items) {
      const n = q ? (it.newText.match(findRe()) || []).length : 0;
      if (n) { total += n; lines++; }
      if (it.boxEl) it.boxEl.classList.toggle('match', n > 0);
    }
    els.findCount.textContent = q ? (total ? `${plural(total, 'match')} in ${plural(lines, 'line')}` : 'No matches') : '';
    els.replaceAllBtn.disabled = !total || state.busy;
  }

  async function replaceAll() {
    const q = els.findInput.value, rep = els.replaceInput.value;
    if (!q) return;
    const targets = state.items.filter(it => findRe().test(it.newText));
    if (!targets.length) return;
    els.replaceAllBtn.disabled = true;
    await Fonts.ready();
    checkpoint();
    let total = 0;
    for (const [i, it] of targets.entries()) {
      if (!it.match) {
        setStatus(`Matching fonts… ${i + 1}/${targets.length}`);
        await nextTick();
      }
      ensureMatched(it);
      total += (it.newText.match(findRe()) || []).length;
      it.newText = it.newText.replace(findRe(), () => rep);
      it.edited = true;
      refreshMarks(it);
    }
    if (state.selected) fillEditor(state.selected);
    scheduleRender();
    updateFind();
    setStatus(`Replaced ${plural(total, 'occurrence')} in ${plural(targets.length, 'line')}.`);
  }

  for (const el of [els.findInput, els.matchCase]) el.addEventListener('input', updateFind);
  els.findInput.addEventListener('keydown', e => { if (e.key === 'Enter') els.replaceInput.focus(); });
  els.replaceInput.addEventListener('keydown', e => { if (e.key === 'Enter') replaceAll(); });
  els.replaceAllBtn.addEventListener('click', replaceAll);
  els.findPanel.addEventListener('toggle', () => { if (els.findPanel.open) els.findInput.focus(); });

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
  els.fontInput.addEventListener('change', () => { addFonts(els.fontInput.files); els.fontInput.value = ''; });
  els.modeSelect.addEventListener('change', () => {
    if (state.orig && !state.busy) {
      state.erasedKey = null; state.selected = null; els.editor.hidden = true;
      clearHistory();
      vctx.putImageData(state.orig, 0, 0);
      detectAll();
    }
  });

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
  // Dropped font files are added for matching; a dropped image is opened.
  els.stageWrap.addEventListener('drop', e => {
    const files = [...e.dataTransfer.files];
    if (files.some(f => Fonts.isFontFile(f))) addFonts(files);
    const img = files.find(f => f.type.startsWith('image/'));
    if (img) loadFile(img);
  });
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

  // ---------- keyboard ----------
  const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  document.addEventListener('keydown', e => {
    const active = document.activeElement;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    // Our undo replaces the browser's in the text box and on the canvas; other inputs
    // (filter, find, number fields) keep their native undo.
    const ownsUndo = !isTyping(active) || active === els.textInput;
    if (mod && key === 'z' && ownsUndo && state.orig) {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    } else if (mod && key === 'y' && ownsUndo && state.orig) {
      e.preventDefault();
      redo();
    } else if (mod && key === 'c' && !isTyping(active) && !String(window.getSelection())) {
      if (state.orig) { e.preventDefault(); copyImage(); }
    } else if (ARROWS[e.key] && state.selected && (e.altKey || !isTyping(active))) {
      // Arrow keys move the selected text (Alt+arrows also work while typing).
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      nudge(ARROWS[e.key][0] * step, ARROWS[e.key][1] * step);
    } else if (e.key === 'Escape' && !isTyping(active)) {
      deselect();
    }
  });

  // ---------- export ----------
  const pngBlob = () => new Promise(resolve => { render(); els.view.toBlob(resolve, 'image/png'); });

  async function copyImage() {
    setStatus('Copying…');
    try {
      if (!navigator.clipboard || !window.ClipboardItem) throw new Error('your browser does not allow copying images here');
      // Passing a promise keeps Safari happy (the write must start inside the click).
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob() })]);
      setStatus('Copied the edited image. Paste it anywhere with Ctrl+V.');
    } catch (err) {
      setStatus(`Couldn't copy: ${err.message || err}. Use Download PNG instead.`);
    }
  }

  els.copyBtn.addEventListener('click', copyImage);
  els.downloadBtn.addEventListener('click', async () => {
    const blob = await pngBlob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.name}-edited.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  // Start downloading the OCR engine early so the first detection is faster.
  setTimeout(() => OCR.warmUp().catch(() => {}), 500);

  // Exposed for automated tests.
  window.__app = { state, loadFile, select, render, undo, redo, addFonts };
})();
