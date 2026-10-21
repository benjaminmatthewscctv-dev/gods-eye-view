/**
 * God's Eye View on the cyberdeck: upstream's own Vite config, wrapped.
 *
 *   npx vite --config ~/godseye/vite.deck.config.mjs       (what godseye.service runs; cwd = the upstream checkout; .mjs so
 *                                                           Vite bundles it as ESM like upstream's own config)
 *
 * Upstream is cloned untouched at ~/gods-eye-view (setup.sh pins the commit). This file adds one plugin in front of it:
 *   POST /api/hud-summary  -> the home LLM on the PC (BIMO's mind, OpenAI-compatible) instead of OpenAI. The globe's
 *                             five-word HUD caption is the one place upstream calls a chat model from the server side;
 *                             the voice console is OpenAI Realtime over WebRTC with no base URL to point elsewhere, so
 *                             the deck's own voice path (cyberdeck.py: Whisper -> mind -> Kokoro) is the AI for the map.
 * Everything else the deck needs is upstream as shipped: ?embed=1 + postMessage views (src/app/embed.js), /api/geocode,
 * /api/route (OSRM with steps), and the MCP tool server at /mcp (loopback only), which cyberdeck.py calls for the mind.
 *
 * Env (from ~/gods-eye-view/.env, written by setup.sh): HOST=127.0.0.1 PORT=4173, GEV_EMBED_FRAME_ANCESTORS so the
 * cyberdeck window (:8130) may frame the embed page, DECK_MIND_URL for the HUD caption.
 */
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const upstreamRoot = process.env.GEV_ROOT || path.join(process.env.HOME || '', 'gods-eye-view');
const require = createRequire(path.join(upstreamRoot, 'package.json'));
const { defineConfig } = require('vite');

const HUD_INSTRUCTIONS =
  "Write one concise intelligence-HUD summary for God's Eye View. Use only the supplied place, street, nearby-place, " +
  'enabled-layer labels, and feedProvenance. Prefer the clearest named place and include a relevant enabled layer only when ' +
  'useful. If any enabled layer is not nominal, the five words MUST include that feedState token (STALE, DEGRADED, FALLBACK, ' +
  'LOADING, or UNAVAILABLE) and must not present the view as live. Do not infer from coordinates or invent a place or feed ' +
  'state. Output exactly five words with no title, punctuation, markdown, or introductory phrase.';

function fiveWords(text) {
  return String(text || '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** The deck's additions, mounted before upstream's own middlewares. */
function deckPlugin() {
  const mind = (process.env.DECK_MIND_URL || '').replace(/\/+$/, '');
  const deckApp = (process.env.DECK_APP_URL || 'http://127.0.0.1:8130').replace(/\/+$/, '');
  const install = (server) => {
    // the deck's position for deck/follow.js: a loopback proxy, so the embed page stays same-origin (its CSP allows no plain-http hosts)
    server.middlewares.use('/deck/pos', async (req, res) => {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json');
      try {
        const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 1500);
        const r = await fetch(`${deckApp}/gev/pos`, { signal: ctl.signal }); clearTimeout(timer);
        res.statusCode = r.status; res.end(await r.text());
      } catch { res.statusCode = 503; res.end('{"ok":false,"error":"deck app not answering"}'); }
    });
    // STUDIO tab recordings: the deck asks deck/follow.js to record the globe (GET /deck/clipcmd), follow.js reports back (POST)
    const passJson = async (req, res, target) => {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json');
      try {
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 4000);
        const r = await fetch(`${deckApp}${target}`, { method: req.method, headers: body ? { 'Content-Type': 'application/json' } : {}, body, signal: ctl.signal }); clearTimeout(timer);
        res.statusCode = r.status; res.end(await r.text());
      } catch { res.statusCode = 503; res.end('{"ok":false,"error":"deck app not answering"}'); }
    };
    server.middlewares.use('/deck/clipcmd', (req, res) => passJson(req, res, '/gev/clipcmd'));
    // the recorded clip itself (tens to hundreds of MB): streamed through to the deck app, never buffered here
    server.middlewares.use('/deck/clips/upload', (req, res) => {
      const u = new URL(deckApp); const q = (req.url || '').includes('?') ? (req.url || '').slice((req.url || '').indexOf('?')) : '';
      const out = http.request({ host: u.hostname, port: u.port || 80, path: '/studio/upload' + q, method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': req.headers['content-length'] || '0' } }, (r) => {
        res.statusCode = r.statusCode || 502; res.setHeader('Content-Type', 'application/json'); r.pipe(res);
      });
      out.on('error', () => { res.statusCode = 503; res.end('{"ok":false,"error":"deck app not answering"}'); });
      req.pipe(out);
    });
    // road info around the deck (ALPR / Flock, DOT events, Rad detections, reports) - deck/follow.js draws them as markers
    server.middlewares.use('/deck/alerts', async (req, res) => {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json');
      try {
        const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 3000);
        const r = await fetch(`${deckApp}/gev/alerts`, { signal: ctl.signal }); clearTimeout(timer);
        res.statusCode = r.status; res.end(await r.text());
      } catch { res.statusCode = 503; res.end('{"ok":false,"error":"deck app not answering"}'); }
    });
    // the route the deck is navigating (deck/follow.js draws it as the progress bar)
    server.middlewares.use('/deck/route', async (req, res) => {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json');
      try {
        const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 4000);
        const r = await fetch(`${deckApp}/gev/route`, { signal: ctl.signal }); clearTimeout(timer);
        res.statusCode = r.status; res.end(await r.text());
      } catch { res.statusCode = 503; res.end('{"ok":false,"error":"deck app not answering"}'); }
    });
    server.middlewares.use('/api/hud-summary', async (req, res, next) => {
      if (!mind || req.method !== 'POST') return next();
      const send = (code, obj) => {
        res.statusCode = code;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(obj));
      };
      try {
        const context = await readBody(req);
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 20_000);
        const r = await fetch(`${mind}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-BiMo-Surface': 'panel' },
          body: JSON.stringify({
            messages: [
              { role: 'system', content: HUD_INSTRUCTIONS },
              { role: 'user', content: context.slice(0, 20_000) },
            ],
            max_tokens: 40,
            temperature: 0.2,
          }),
          signal: ctl.signal,
        });
        clearTimeout(timer);
        const d = await r.json().catch(() => ({}));
        const summary = fiveWords(d?.choices?.[0]?.message?.content);
        if (!r.ok || !summary) return send(502, { summary: null, error: 'home LLM HUD summary failed' });
        send(200, { summary, error: null });
      } catch {
        send(502, { summary: null, error: 'home LLM HUD summary failed' });
      }
    });
  };
  return {
    name: 'cyberdeck',
    enforce: 'pre',
    configureServer: install,
    configurePreviewServer: install,
    // the follow script rides along only on the embed page (the deck window's MAP tab); the normal page is upstream's
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const url = ctx.originalUrl || ctx.path || '';
        if (!/[?&]embed=1(&|$)/.test(url)) return html;
        return [{ tag: 'script', attrs: { type: 'module', src: '/deck/follow.js' }, injectTo: 'body' }];
      },
    },
  };
}

export default defineConfig(async (env) => {
  // The deck's keys first (upstream's config reads process.env when it builds its plugins, e.g. the embed framing policy),
  // then upstream's own .env semantics on top; a value already in the environment always wins.
  const envFile = path.join(here, 'godseye.env');
  if (fs.existsSync(envFile))
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  const upstream = (await import(pathToFileURL(path.join(upstreamRoot, 'vite.config.js')).href)).default;
  const base = typeof upstream === 'function' ? await upstream(env) : upstream;
  return { ...base, plugins: [deckPlugin(), ...(base.plugins || [])] };
});
