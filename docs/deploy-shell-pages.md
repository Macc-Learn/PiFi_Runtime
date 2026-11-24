# Publishing the shell on GitHub Pages

The workflow `.github/workflows/pages.yml` builds `packages/shell` plus the echo
example front-end on every push to `main` and publishes them to GitHub Pages.

## One-time setup

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. **Settings → Secrets and variables → Actions → Variables** (variables, not secrets:
   they end up in public JavaScript anyway):
   - `PIFI_SIGNAL_URL` = `wss://<your-signaling-server>/ws` (required; the build fails without it)
   - `PIFI_ICE_SERVERS` = `["stun:stun.l.google.com:19302"]` (optional). Never put
     TURN credentials here: anything in the shell is public.
3. Push to `main` (or run the workflow by hand from the Actions tab).

The site appears at `https://<owner>.github.io/<repo>/`, for this repo
`https://macc-learn.github.io/PiFi_Runtime/`. The echo front-end is at
`…/PiFi_Runtime/examples/echo/`, which is what `examples/echo-app/pifi.json` points to.

## Base path

A project site lives under `/<repo>/`. The workflow sets `VITE_BASE=/<repo>/`,
so asset URLs and the `pair/` page work there. For a custom domain at the root,
use `VITE_BASE=/`.

## Pointing `pifi pair` at it

`pifi pair` defaults to `https://macc-learn.github.io/PiFi_Runtime`. For a fork
or another host, set `PIFI_FRONTEND_URL` (or pass `--frontend`). The command
prints "Open this on https://…" so a wrong host is easy to notice.

## Known limitations (testing only)

- **Shared origin.** `<owner>.github.io` is ONE origin for every Pages site
  of that account. Any other site published there can read the shell's
  IndexedDB, including the ability to *use* (not export) the phone keys. Fine
  for testing; before public use, move the shell to a dedicated domain.
- **Moving the shell means re-pairing.** Keys belong to the origin. After moving
  to a new domain, every phone must pair again (`pifi pair`).
- **No HTTP headers.** Pages can't set headers, so the Content-Security-Policy
  is a `<meta>` tag (it can't use `frame-ancestors` or reporting). A real
  domain behind a CDN should add the same policy as headers.
- **Whoever can publish to the repo controls the shell**, and so can use the keys
  of every phone that opens it. Protect the repo: 2FA for everyone with write
  access, branch protection on `main`, required reviews.
