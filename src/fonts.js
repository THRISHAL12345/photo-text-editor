// Candidate fonts used for matching. System fonts are used if installed;
// Google Fonts are downloaded so common web/app UI fonts can be matched too.
const Fonts = (() => {
  const SYSTEM = [
    { family: 'Segoe UI', weights: [300, 400, 600, 700] },
    { family: 'Arial', weights: [400, 700] },
    { family: 'Helvetica Neue', weights: [400, 500, 700] },
    { family: 'Helvetica', weights: [400, 700] },
    { family: 'SF Pro Text', weights: [400, 500, 600, 700] },
    { family: 'Calibri', weights: [400, 700] },
    { family: 'Verdana', weights: [400, 700] },
    { family: 'Tahoma', weights: [400, 700] },
    { family: 'Trebuchet MS', weights: [400, 700] },
    { family: 'Times New Roman', weights: [400, 700] },
    { family: 'Georgia', weights: [400, 700] },
    { family: 'Consolas', weights: [400, 700] },
    { family: 'Courier New', weights: [400, 700] },
  ];

  // Each Google family is loaded with its own <link> so one bad entry can't break the rest.
  const GOOGLE = [
    { family: 'Inter', weights: [400, 500, 600, 700] },
    { family: 'Roboto', weights: [400, 500, 700] },
    { family: 'Open Sans', weights: [400, 600, 700] },
    { family: 'Lato', weights: [400, 700] },
    { family: 'Montserrat', weights: [400, 500, 600, 700] },
    { family: 'Poppins', weights: [400, 500, 600, 700] },
    { family: 'Noto Sans', weights: [400, 500, 700] },
    { family: 'Source Sans 3', weights: [400, 600, 700] },
    { family: 'Nunito Sans', weights: [400, 600, 700] },
    { family: 'IBM Plex Sans', weights: [400, 500, 600] },
    { family: 'Merriweather', weights: [400, 700] },
    { family: 'Playfair Display', weights: [400, 700] },
    { family: 'Roboto Mono', weights: [400, 500] },
    { family: 'JetBrains Mono', weights: [400, 500] },
  ];

  let available = [];
  let readyPromise = null;

  const fontStr = (family, weight, size, italic) =>
    `${italic ? 'italic ' : ''}${weight} ${size}px "${family}"`;

  // A font is installed if text renders at a different width than the generic fallbacks.
  function isInstalled(family) {
    const c = document.createElement('canvas').getContext('2d');
    const probe = 'mmmmmmmmmlli1WQ@#';
    for (const generic of ['monospace', 'serif', 'sans-serif']) {
      c.font = `72px ${generic}`;
      const base = c.measureText(probe).width;
      c.font = `72px "${family}", ${generic}`;
      if (Math.abs(c.measureText(probe).width - base) > 0.5) return true;
    }
    return false;
  }

  function signature(family) {
    const c = document.createElement('canvas').getContext('2d');
    return [400, 700].map(w => {
      c.font = fontStr(family, w, 72, false);
      return c.measureText('Hamburgefonstiv 0123456789').width.toFixed(2);
    }).join('/');
  }

  // Resolves when every stylesheet has loaded (or failed), so @font-face rules exist.
  function injectGoogle() {
    return Promise.all(GOOGLE.map(f => new Promise(resolve => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(f.family).replace(/%20/g, '+')}:wght@${f.weights.join(';')}&display=swap`;
      link.onload = link.onerror = resolve;
      document.head.appendChild(link);
    })));
  }

  function ready() {
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      await Promise.race([injectGoogle(), new Promise(r => setTimeout(r, 6000))]);
      // Force every face to download before it is used for matching.
      const loads = [];
      for (const f of GOOGLE) {
        for (const w of f.weights) loads.push(document.fonts.load(fontStr(f.family, w, 32, false), 'AaBb').catch(() => []));
      }
      await Promise.race([Promise.all(loads), new Promise(r => setTimeout(r, 8000))]);
      // Drop aliases (e.g. Windows maps "Helvetica" to Arial) so each face is tried once.
      const seen = new Set();
      available = [...SYSTEM, ...GOOGLE].filter(f => {
        if (!isInstalled(f.family)) return false;
        const sig = signature(f.family);
        if (seen.has(sig)) return false;
        seen.add(sig);
        return true;
      });
      return available;
    })();
    return readyPromise;
  }

  // --- User-uploaded fonts --------------------------------------------------
  // Lets people match fonts that aren't installed, e.g. SF Pro for Mac/iPhone
  // screenshots. Family, weight and style are read from the file name
  // ("SF-Pro-Text-Semibold.otf" -> "SF Pro Text", 600).
  const custom = [];
  const WEIGHT_WORDS = {
    thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300,
    regular: 400, normal: 400, book: 400, roman: 400, medium: 500,
    semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800,
    heavy: 900, black: 900,
  };
  const FONT_FILE = /\.(ttf|otf|woff2?)$/i;

  function parseFontName(fileName) {
    const raw = fileName.replace(FONT_FILE, '');
    const variable = /variable|\[[^\]]*wght[^\]]*\]/i.test(raw);
    const tokens = raw.replace(/\[[^\]]*\]/g, '').replace(/VariableFont.*$/i, '').split(/[-_\s]+/).filter(Boolean);
    let weight = 400, italic = false;
    const keep = [];
    for (const t of tokens) {
      let w = t.toLowerCase();
      if (w === 'variable' || w === 'vf') continue;
      if (w.endsWith('italic') || w.endsWith('oblique')) {
        italic = true;
        w = w.replace(/(italic|oblique)$/, '');
        if (!w) continue;
      }
      if (w in WEIGHT_WORDS) weight = WEIGHT_WORDS[w];
      else keep.push(t);
    }
    let family = keep.join(' ') || 'Uploaded font';
    // Don't merge into a font of the same name that's already present (a Google font, or
    // an installed system font). An uploaded "SF Pro Text" on Windows keeps its name.
    const same = f => f.family.toLowerCase() === family.toLowerCase();
    const clash = GOOGLE.some(same) || SYSTEM.some(f => same(f) && isInstalled(f.family));
    if (clash) family += ' (uploaded)';
    return { family, weight, italic, variable };
  }

  async function addFontFile(file) {
    const { family, weight, italic, variable } = parseFontName(file.name);
    const face = new FontFace(family, await file.arrayBuffer(), {
      weight: variable ? '100 900' : String(weight),
      style: italic ? 'italic' : 'normal',
    });
    await face.load();
    document.fonts.add(face);
    let entry = custom.find(f => f.family === family);
    if (!entry) { entry = { family, weights: [] }; custom.push(entry); }
    // Italic faces are used when "Italic" is ticked; matching tries upright weights.
    const weights = variable ? [300, 400, 500, 600, 700] : italic ? [] : [weight];
    for (const w of weights) if (!entry.weights.includes(w)) entry.weights.push(w);
    entry.weights.sort((a, b) => a - b);
    if (!entry.weights.length) entry.weights.push(400);
    return { family, weight: variable ? 'variable' : weight, italic };
  }

  return {
    ready,
    fontStr,
    addFontFile,
    parseFontName,
    isFontFile: file => FONT_FILE.test(file.name),
    get available() { return available.length ? [...custom, ...available] : []; },
    get all() { return [...custom, ...SYSTEM, ...GOOGLE]; },
  };
})();
