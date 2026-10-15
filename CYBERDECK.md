# God's Eye View, cyberdeck branch

This is a fork of [bilawalsidhu/gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view) (MIT) for the AI Cyberdeck:
the Pi 5 in the deck shows the globe in the MAP tab of its window, the deck's GPS is the position on it, driving directions
are spoken through the deck's voice, and BIMO's mind on the home PC (the home LLM on the GPU) is its AI.

**Branches**

| branch | what |
|---|---|
| `main` | upstream, untouched; pull from `upstream/main` to take new releases |
| `cyberdeck` | `main` plus the `deck/` folder and, when needed, changes to upstream files for the deck. Everything the deck runs. |

The deck's **app-side** code (the navigation engine, the MAP tab, the NAV page, the mind's tools) stays in the AI-Cyberdeck
repo under `pi/cyberdeck/` (`nav.py`, `front.html`, `cyberdeck.py`); it talks to this checkout only over HTTP on the Pi
(`/api/geocode`, `/api/route`, `/mcp`, and the `?embed=1` page). Changes that live **inside the globe** belong here.

## deck/

| file | purpose |
|---|---|
| `setup.sh` | one command on the Pi: Node 24 (nvm), `npm ci`, the wrapper, the user service |
| `vite.deck.config.mjs` | upstream's Vite config wrapped: `POST /api/hud-summary` goes to the mind (`DECK_MIND_URL`) instead of OpenAI |
| `godseye.env` | `HOST/PORT` (loopback :4173), `GEV_EMBED_FRAME_ANCESTORS` (the deck window may frame the embed page), `DECK_MIND_URL`, optional upstream keys |
| `godseye.service` | the user unit |

On the Pi the checkout is `~/gods-eye-view` (this branch), the wrapper is copied to `~/godseye/`, and the AI-Cyberdeck
staging bundle's `pi/godseye/setup.sh` is only a pointer that clones this branch and runs `deck/setup.sh`.

## Working on it

```bash
git checkout cyberdeck
# edit, then on the Pi:  cd ~/gods-eye-view && git pull && bash deck/setup.sh
```

Taking an upstream update:

```bash
git fetch upstream
git checkout main && git merge --ff-only upstream/main && git push
git checkout cyberdeck && git merge main      # resolve, re-test the MAP tab (embed API, /api/route, /mcp), push
```

What the deck relies on in upstream, worth re-checking after a merge: `src/app/embed.js` (`gev:view` messages),
`server/providers/places/routes.js` (`/api/route?steps=1`), `server/providers/regional/place.js` (`/api/geocode`),
`server/mcp/plugin.js` (`/mcp`, loopback only), `build/embed-framing.js` (`GEV_EMBED_FRAME_ANCESTORS`),
`server/providers/openai/hud-summary.js` (the HUD caption the wrapper overrides).
