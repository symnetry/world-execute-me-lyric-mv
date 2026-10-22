// Vite config: the film is a plain front-end app (native ES modules, no framework), so the only jobs here are
//   1. serve it in dev with the same URLs the build will use (base '/worldexcuteme/'),
//   2. emit a self-contained folder that can be dropped at <webroot>/worldexcuteme/ and opened at
//      https://<your-domain>/worldexcuteme/.
//
// Two things Vite cannot infer, so they are done by the plugins below:
//   - the run-time files the engine fetches by name at boot (config.json, data/, assets/, docs/v4/, the song);
//   - the fonts. They are loaded as raw URLs out of node_modules/@fontsource (see src/engine/engine.js), and the
//     four CJK packages alone are ~300 MB, of which this film needs 48 glyphs. mvFontSubset keeps only the
//     unicode-range slices that actually contain them.
import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** The path the site is published under. Change it here (and nowhere else) if the URL changes. */
const DEPLOY_PATH = 'worldexcuteme';
const OUT_DIR = `dist/${DEPLOY_PATH}`;

const readCfg = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const abs = (rel) => path.join(ROOT, rel);
const out = (rel) => path.join(ROOT, OUT_DIR, rel);

function copyFile(rel) {
  const src = abs(rel);
  if (!fs.existsSync(src)) { console.warn(`[vite] missing ${rel}, left out of ${OUT_DIR}`); return false; }
  fs.mkdirSync(path.dirname(out(rel)), { recursive: true });
  fs.copyFileSync(src, out(rel));
  return true;
}
const copyDir = (rel) => fs.existsSync(abs(rel)) && fs.cpSync(abs(rel), out(rel), { recursive: true });

/** Everything the page fetches at run time, at the paths config.json names. */
function mvRuntimeFiles() {
  return {
    name: 'mv-runtime-files',
    apply: 'build',
    closeBundle() {
      const cfg = readCfg();
      copyDir('data');
      copyDir(cfg.paths.art);
      copyDir(path.dirname(cfg.paths.script));
      // the song gets a folder of its own: no non-ASCII name has to survive the upload
      const audio = cfg.paths.audio;
      if (fs.existsSync(abs(audio))) {
        const name = path.basename(audio);
        fs.mkdirSync(out('audio'), { recursive: true });
        fs.copyFileSync(abs(audio), out(`audio/${name}`));
        cfg.paths.audio = `audio/${name}`;
      } else {
        console.warn(`[vite] no song at "${audio}": the build plays no sound (config.json -> paths.audio)`);
      }
      fs.writeFileSync(out('config.json'), JSON.stringify(cfg, null, 1) + '\n', 'utf8');
      const mb = (dir) => (fs.readdirSync(out(dir), { recursive: true })
        .reduce((n, f) => n + (fs.statSync(path.join(out(dir), f)).isFile() ? fs.statSync(path.join(out(dir), f)).size : 0), 0) / 1e6).toFixed(1);
      console.log(`[vite] runtime files -> ${OUT_DIR}/: config.json, data/ ${mb('data')} MB, assets/ ${mb('assets')} MB`);
    },
  };
}

// ---- fonts ---------------------------------------------------------------------------------------------
/** Does a CSS `unicode-range` list hold any of `cps`? */
function covers(rangeList, cps) {
  for (const part of rangeList.split(',')) {
    const m = /^u\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?$/i.exec(part.trim());
    if (!m) continue;
    const lo = parseInt(m[1].replace(/\?/g, '0'), 16);
    const hi = m[1].includes('?') ? parseInt(m[1].replace(/\?/g, 'f'), 16) : m[2] ? parseInt(m[2], 16) : lo;
    if (cps.some((c) => c >= lo && c <= hi)) return true;
  }
  return false;
}

/** The latin faces the engine names, copied under the URL it builds (`<base>node_modules/@fontsource/...`). */
function latinFonts(cfg) {
  let n = 0;
  for (const key of ['mono', 'serif', 'sans']) {
    const { pkg, weights = [], italic = [] } = cfg.fonts[key] ?? {};
    if (!pkg) continue;
    const faces = [...weights.map((w) => [w, 'normal']), ...italic.map((w) => [w, 'italic'])];
    for (const [w, style] of faces) {
      const rel = `node_modules/@fontsource/${pkg}/files/${pkg}-latin-${w}-${style}.woff2`;
      if (copyFile(rel)) n++;
    }
  }
  return n;
}

/** One CJK package at one weight: the @font-face blocks whose unicode-range holds a configured glyph, and their files. */
function cjkFont(cfg, { pkg, weight, family, text, role }) {
  const cssRel = `node_modules/@fontsource/${pkg}/${weight}.css`;
  const css = fs.readFileSync(abs(cssRel), 'utf8');
  const cps = [...new Set([...text].map((c) => c.codePointAt(0)))];
  const blocks = css.split(/(?=@font-face)/).filter((s) => s.includes('@font-face'));
  const kept = [];
  for (const b of blocks) {
    const range = /unicode-range\s*:\s*([^;}]+)/i.exec(b);
    if (range && !covers(range[1], cps)) continue;
    const src = /src:\s*url\(([^)]+\.woff2)\)[^;]*;/i.exec(b);
    if (!src) continue;
    const file = src[1].replace(/^\.\//, '');
    copyFile(`node_modules/@fontsource/${pkg}/${file}`);
    kept.push(b.replace(src[0], `src: url(${file}) format('woff2');`).trim());   // woff2 only: no 404 for the fallback
  }
  if (!kept.length) throw new Error(`[vite] no slice of ${pkg} ${weight} covers "${text}" (${role})`);
  fs.mkdirSync(path.dirname(out(cssRel)), { recursive: true });
  fs.writeFileSync(out(cssRel), kept.join('\n\n') + '\n', 'utf8');
  return kept.length;
}

function mvFontSubset() {
  return {
    name: 'mv-font-subset',
    apply: 'build',
    closeBundle() {
      const cfg = readCfg();
      const latin = latinFonts(cfg);
      let cjk = 0, slices = 0;
      for (const c of cfg.fonts.cjk ?? []) { slices += cjkFont(cfg, c); cjk++; }
      console.log(`[vite] fonts -> ${OUT_DIR}/node_modules/@fontsource/: ${latin} latin files, ${cjk} CJK faces (${slices} unicode slices)`);
    },
  };
}

export default defineConfig(({ command }) => ({
  // Dev serves from the site root: the app only ever reads BASE_URL (src/engine/url.js), so it does not mind where
  // it is mounted, and keeping dev at '/' means the plain repository preview and this server behave alike.
  // The build is mounted at /worldexcuteme/ — `vite preview` serves it there, so the deployed shape can be checked.
  base: command === 'build' ? `/${DEPLOY_PATH}/` : '/',
  plugins: [mvRuntimeFiles(), mvFontSubset()],
  server: { port: 5173, open: false },
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    target: 'es2022',                 // top-level await, FontFace, Path2D
    assetsDir: 'bundle',              // 'assets/' stays the character art, not hashed bundles
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: `bundle/${DEPLOY_PATH}-[hash].js`,
        chunkFileNames: 'bundle/[name]-[hash].js',
        assetFileNames: 'bundle/[name]-[hash][extname]',
      },
    },
  },
}));
