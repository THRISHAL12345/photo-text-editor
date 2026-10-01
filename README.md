# Photo Text Editor

Upload a screenshot or photo. The tool detects its text automatically, and you can click any
line and retype it. The replacement keeps the original font, weight, size, color and position,
and the background behind it is preserved.

Everything runs in the browser. The image never leaves your machine: OCR runs locally in
WebAssembly, and only the OCR engine and font files are downloaded.

## Run it

Open `index.html` in Chrome or Edge (double-click it). There's no build step and no install.
You need an internet connection the first time, to download Tesseract.js (~5 MB, then cached)
and the Google Fonts used for matching.

Or serve the folder: `python -m http.server` and open http://localhost:8000.

## Use it

1. **Upload**, drag-and-drop, or **paste** a screenshot (Ctrl+V).
2. Detected lines get boxes. Click one (or pick it from the list on the right).
3. Type the new text. The canvas updates live. **Enter** / **Tab** jumps to the next line.
4. Adjust if needed: font, weight, size, letter spacing, color, alignment, nudge X/Y.
5. **Hold to compare** shows the original. **Download PNG** exports at full resolution.

If some text wasn't detected, click **+ Region** and drag a box around it. If nothing is
recognized there, you still get an empty box you can type into.

**Detection mode:** use *Screenshot / UI* (sparse text, the default) for apps and web pages,
and *Document* for paragraphs of running text.

## How it works

| Step | File | What happens |
|---|---|---|
| Detect | `src/ocr.js` | Tesseract runs twice: on plain grayscale, and on a "region ink" image. The region-ink pass finds large flat or gradient backgrounds (page, bars, buttons, pills, photo areas after denoising), gives every pixel the color of its nearest background pixel, and redraws text as dark ink on white. This catches white-on-blue buttons, dark-mode text and text on images, which plain OCR misses. Words from both passes are de-duplicated and grouped into lines by row, spacing and color, so a link inside a sentence becomes its own item. |
| Analyze | `src/analyze.js` | Background color comes from a ring around the text, and text color from its most saturated ink pixels. It builds an anti-aliased coverage mask and guesses alignment: text centered inside a button or pill stays centered. |
| Match font | `src/fontmatch.js` | Each candidate font and weight is rendered the way the original was drawn (detected text color on detected background) and compared pixel by pixel. Stage 1 tries every font, sized from the measured word widths, and compares blurred masks. Stage 2 refines size and sub-pixel position for the best few. Result: family, weight, exact px size, letter spacing, baseline. |
| Erase | `src/analyze.js` | On flat backgrounds, the glyph pixels are filled with the background color. On gradients and photos, each glyph pixel is interpolated from the nearest clean pixels in four directions, then grain sampled from the surroundings is added back so it doesn't look smudged. |
| Render | `src/app.js` | Draws the new text with canvas `fillText` on the original baseline, then composites. |

On the test screenshots, the matcher found the exact font, weight and size for every line:
Segoe UI 600 24px, Arial 15px, Inter 500 14px, Roboto 500 16px, Georgia 18px, Poppins 700 56px
and JetBrains Mono 26px, including 2x (Retina) screenshots.

## Fonts

Candidates are listed in `src/fonts.js`: common system fonts (Segoe UI, Arial, Calibri,
Verdana, Georgia, Consolas, …) plus Google Fonts (Inter, Roboto, Open Sans, Lato, Montserrat,
Poppins, Noto Sans, Source Sans 3, Nunito Sans, IBM Plex Sans, Merriweather, Playfair Display,
Roboto Mono, JetBrains Mono). Fonts that aren't installed are skipped automatically.

**If a screenshot uses a font that isn't in the list**, the closest one is chosen. For example,
macOS screenshots use SF Pro, which usually matches to Inter on Windows. To get an exact match,
add the font to `SYSTEM` (if installed) or `GOOGLE` in `src/fonts.js`.

## Limitations

- Each item is a single line. Longer replacement text isn't wrapped onto a new line.
- Making one item longer can overlap the next item on the same row (for example, a link right
  after the sentence you edited). Edit or nudge the neighbor too.
- Windows ClearType's colored sub-pixel fringes aren't reproduced. The new text is grayscale
  anti-aliased, which is invisible at normal zoom.
- Rotated, curved or perspective text (photos of signs, for example) isn't supported. Erasing
  on busy photo textures is an approximation.
- OCR quality depends on Tesseract. Very small text (under ~9px), stylized display fonts and
  non-Latin scripts may need the **+ Region** tool. Only English (`eng`) is loaded; change it in
  `OCR.warmUp` / `createWorker('eng', …)` in `src/ocr.js`.
