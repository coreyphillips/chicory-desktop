# Desktop gallery

The gallery draws every state in the mobile gallery's inventory using the
desktop renderer. That includes the browser motion, layout, focus and SVG
adapters, which mobile screenshots do not exercise. The state modules in
`web/gallery/` are ported from chicory `native-tests/gallery/` at the commit
pinned in `sources.json`, along with `test-support/fixtures.ts`.

## Running it

```sh
npm run test:gallery        # deterministic CI subset, two configurations
npm run test:gallery:full   # every state in eight configurations (release check)
node scripts/desktop/gallery.mjs --only '^send, review'   # states matching a regex
```

Screenshots and `report.json` are written to `artifacts/gallery/<config>/`.
Set `CHICORY_GALLERY_OUTPUT` to write them somewhere else. On Linux without a
display, use `xvfb-run -a`.

The CI subset runs a full window (1320x860) with normal motion at 1x, and a
compact window (960x720) with reduced motion at a 1.3 zoom factor. The full
run covers both sizes, both motion settings and zoom factors 1 and 1.3. Every
release must pass the full run. Review the screenshots against those from the
previous release before shipping.

## What each state is checked for

- It is reached with no `MISS` or `ERROR` from its steps, and the renderer
  throws no exceptions or console errors.
- No payment figure is cut off horizontally by the window or by a clipping
  ancestor.
- Every hold confirmation is on screen, or can be scrolled fully into view.
- No icon-only control has a glyph that paints nothing.
- Nothing focusable is inside an `aria-hidden` pane unless it is also `inert`,
  and focus never rests inside a hidden pane.

The runner also checks that a short keyboard hold cancels and keeps focus, and
that a pointer hold cancels on early release and on leaving the control. It
checks the hold's screen-reader name and that focus after a payment outcome
stays out of exiting panes. It verifies that a hidden balance exposes no
amount, either visibly or through accessible names. Finally, it resizes the
window during the review transition and audits the result.

## Isolation

`scripts/desktop/gallery-window.cjs` runs the gallery outside the desktop
app. That file lives outside `desktop/`, so it is never packaged. The window
has no preload or desktop bridge, and it uses an in-memory partition and a
temporary profile. It never starts the manager or Tor. Every request outside
the gallery build is refused, as is every permission. In the renderer,
`vite.gallery.config.ts` aliases the secure store, clipboard and camera to
in-memory stand-ins. `web/gallery/breaches.ts` replaces `fetch`, XHR,
WebSocket, EventSource, beacons, `navigator.clipboard` and
`navigator.mediaDevices` with stubs that refuse and record every attempt. The
runner fails if any state makes one. The wallet is fake (`web/gallery/fakes.ts`)
and answers at once, so no recovery words are read from anywhere and no
payment leaves the page.

The gallery is built to `dist-gallery/` from `gallery.html`. The production
build (`index.html`, `dist/`) does not import it.

## Desktop differences

- Sessions are host sessions (`mode: 'host'`) with no device erase, as in
  `web/platform/useWalletSession.ts`. The mobile state "settings, confirming
  an erase" has no desktop counterpart and is left out.
- Browser holds read real pointer and key events instead of a gesture handler.
  The runner presses "send, review, held down", "hold, held" and "hold, let go
  early" with the real pointer.
- The desktop lock has no biometry, so the Face ID, fingerprint and iris lock
  states draw the desktop lock.
- Text scale is Chromium's zoom factor. A renderer has no separate font scale.
- States are drawn on the stage itself, as on mobile. The desktop shell
  (sidebar, title bar, native menus) is covered by `npm run test:smoke`.

## Known findings

The runner keeps a short `KNOWN` list of real bugs the gallery found that are
tracked separately. Each entry is still audited and printed in the report on
every run. If an entry stops reproducing, the run fails so the entry gets
removed.

- Below 900 CSS px (a compact window at 1.3 zoom), the Settings layer is wider
  than the window. The wallet drain's "Send everything" hold is cut off to the
  right and cannot be scrolled into view.
