// Where the run-time files sit.
// Everything the page fetches after boot (config.json, data/, assets/, docs/v4/, the song, the fonts) is addressed
// from the deploy base, so the same code runs from the repository root (export/server.mjs, no bundler) and from a
// sub-path of a built site (https://host/worldexcuteme/): Vite fills BASE_URL in from vite.config.js -> base.
// Without a bundler `import.meta.env` does not exist and the base is the site root.
const env = import.meta.env;
export const BASE = (env && env.BASE_URL) || '/';

/**
 * A project-relative path ('data/lyrics.json', 'audio/song.mp3') as a URL the page can fetch
 * ('/worldexcuteme/data/lyrics.json'). Each segment is encoded, so spaces and non-ASCII names are safe.
 *
 * Keep the paths in config.json free of '&', '#', '?' and '%' anyway. encodeURIComponent turns '&' into '%26', and
 * Vite's dev server does not always decode that back: it answers with index.html instead of the file, and the <audio>
 * element reports a 404. That is why the song lives in 'audio/' and not in a folder with an '&' in its name.
 */
export const assetUrl = (p) => BASE + String(p).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
