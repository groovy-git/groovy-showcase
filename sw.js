// The offline copy of the published site (a service worker). scripts/protect.mjs writes this
// to dist/sw.js and fills in the placeholders below; login/unlock.js registers it.
//
// It saves only what is already public: the login page, the encrypted app, the photos, the
// icons and the fonts. Nothing decrypted is stored here, and it knows no credentials.
//
// The rule that keeps it safe: for the page and the encrypted app the internet comes first,
// exactly as without this script, and the saved copy is used only when the server gives no
// answer. So a new version, or a changed password, reaches every device that is online, and
// no device is left on an old copy while it has a connection.

// Changes with every build, which is how a device notices there is a new one to save
const VERSION = '49ca0b1858addadf';
// One name for this site alone: the address is shared with other sites, and so are its caches
const CACHE = 'groovy-showcase-offline';
// Everything published, relative to the site ("./" is the login page)
const FILES = ["./","app.enc","backgrounds/gold.jpg","backgrounds/noir.jpg","backgrounds/rose.jpg","icons/apple-touch-icon.png","icons/icon-192.png","icons/icon-512.png","icons/icon-maskable-512.png","manifest.webmanifest"];
const APP_FILE = 'app.enc';
// The first four bytes of the encrypted app, by which a real copy of it is recognised
const APP_MAGIC = 'GRV1';
const FONTS_CSS = 'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700;800&family=Cormorant+Garamond:ital,wght@0,400;0,600;0,700;1,400;1,600&family=Playfair+Display:ital,wght@0,400;0,600;0,700;0,800;1,400;1,600&family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=Great+Vibes&family=Alex+Brush&family=Kaushan+Script&display=swap';

// How long the server gets to answer before the saved copy is used instead
const NETWORK_WAIT_MS = 5000;
// After one such wait, the requests that follow do not sit through it again
const QUICK_WAIT_MS = 800;
const QUICK_FOR_MS = 20000;

const scope = self.registration.scope;
const PAGE = scope;
const APP = new URL(APP_FILE, scope).href;
const FONT_HOSTS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

let slowUntil = 0;

// ---- Saving a copy when this script is installed or updated
const save = async (cache, url, init) => {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  await cache.put(url, response);
};

// The fonts come from Google, one file per script (Latin, Cyrillic, Greek...). The catalogue is
// written in Latin letters, so those files are saved up front for every typeface, whichever
// theme happens to be showing. Any other file is saved the first time a page asks for it.
const saveFonts = async cache => {
  if (!FONTS_CSS) return;
  const response = await fetch(FONTS_CSS);
  if (!response.ok) return;
  const css = await response.clone().text();
  await cache.put(FONTS_CSS, response);

  const files = new Set();
  for (const block of css.split('/*').slice(1)) {
    const script = block.slice(0, block.indexOf('*/')).trim();
    if (script !== 'latin' && script !== 'latin-ext') continue;
    for (const match of block.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)) files.add(match[1]);
  }
  await Promise.allSettled(
    [...files].map(async url => {
      // A font file never changes once published, so one that is already saved is kept
      if (!(await cache.match(url, { ignoreVary: true }))) await save(cache, url);
    })
  );
};

const saveSite = async () => {
  const cache = await caches.open(CACHE);
  // "no-cache" asks the server whether its copy has changed, so nothing stale is saved
  const fresh = { cache: 'no-cache' };
  // Without the page and the app there is no offline copy worth having: fail, to be retried
  await Promise.all([PAGE, APP].map(url => save(cache, url, fresh)));
  // The rest is best effort, and anything missed is saved when a page first asks for it
  const others = FILES.map(file => new URL(file, scope).href).filter(url => url !== PAGE && url !== APP);
  await Promise.allSettled([...others.map(url => save(cache, url, fresh)), saveFonts(cache)]);
};

self.addEventListener('install', event => {
  // Taking over at once is safe because the page and the app are always asked of the server first
  event.waitUntil(saveSite().then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

// ---- Answering requests
// The device's storage can fail (full, or cleared by the browser). Nothing here may turn that
// into a failed page: without storage every request is simply passed to the server.
const openCache = () => caches.open(CACHE).catch(() => null);
const lookUp = (cache, key) => (cache ? cache.match(key, { ignoreVary: true }).catch(() => undefined) : undefined);

// Lets background work finish after the answer has gone out. The browser may refuse to wait
// (it then throws); the work carries on regardless, and no request is failed over it.
const keepAlive = (event, work) => {
  try {
    event.waitUntil(work);
  } catch {
    // Nothing to do
  }
};

// What is worth keeping as the saved copy: the real thing, not an error page that came back
// with a good status
const isPage = (body, response) => (response.headers.get('content-type') || '').includes('text/html');
const isApp = body => body.byteLength > 36 && String.fromCharCode(...new Uint8Array(body, 0, 4)) === APP_MAGIC;

// The page and the encrypted app: the server first, the saved copy if it does not answer
const internetFirst = async (event, request, key, worthSaving) => {
  const cache = await openCache();

  const answer = fetch(request).then(async response => {
    // Whatever the server says is passed on as it is. Only a good answer is saved, and only
    // whole: a download that stops half way reaches neither the page nor the saved copy.
    if (!response.ok) return response;
    const body = await response.arrayBuffer();
    const headers = new Headers(response.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    const copy = () => new Response(body, { status: response.status, statusText: response.statusText, headers });
    if (cache && worthSaving(body, response)) await cache.put(key, copy()).catch(() => {});
    return copy();
  });
  // If the saved copy ends up being used, a slow download still finishes and is kept for next time
  keepAlive(event, answer.catch(() => {}));

  const saved = await lookUp(cache, key);
  if (!saved) return answer;

  let timer;
  const gaveUp = new Promise(resolve => {
    timer = setTimeout(() => {
      slowUntil = Date.now() + QUICK_FOR_MS;
      resolve(saved);
    }, Date.now() < slowUntil ? QUICK_WAIT_MS : NETWORK_WAIT_MS);
  });
  try {
    return await Promise.race([answer, gaveUp]);
  } catch {
    return saved;
  } finally {
    clearTimeout(timer);
  }
};

// Photos, icons and fonts: the saved copy at once, brought up to date in the background
const savedFirst = async (event, request) => {
  const cache = await openCache();
  const saved = await lookUp(cache, request.url);

  const refresh = fetch(request).then(response => {
    if (cache && response.ok) keepAlive(event, cache.put(request.url, response.clone()).catch(() => {}));
    return response;
  });
  if (!saved) return refresh;

  keepAlive(event, refresh.catch(() => {}));
  return saved;
};

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const address = url.origin + url.pathname;
  // Last resort for anything unforeseen in the code above: ask the server, as if this script
  // were not there
  const answerWith = handler => event.respondWith(handler().catch(() => fetch(request)));

  if (address.startsWith(scope)) {
    if (request.mode === 'navigate') {
      // Only the site's one page; any other address is left to the browser
      if (address === PAGE || address === `${PAGE}index.html`) answerWith(() => internetFirst(event, request, PAGE, isPage));
      return;
    }
    if (address === APP) answerWith(() => internetFirst(event, request, APP, isApp));
    else answerWith(() => savedFirst(event, request));
    return;
  }

  if (FONT_HOSTS.includes(url.origin)) answerWith(() => savedFirst(event, request));
});
