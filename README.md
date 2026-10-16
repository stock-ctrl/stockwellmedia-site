# stock-ctrl.github.io

The Stockwell Media Co website, served from the root of this repo so the URL is
just **https://stock-ctrl.github.io** with no path. That is the URL to hand out
and to write to NFC cards.

This repo is the canonical home of the site. The old location,
`stock-ctrl/stockwell-media/website/`, now holds redirect stubs pointing here so
existing links keep working.

## Layout

    index.html      services.html   about.html   contact.html
    site.css        page styles
    styles.css      entry point, imports colors_and_type.css
    colors_and_type.css   brand truth: Jost + Spectral + JetBrains Mono, forest/sage/cream
    assets/logos/favicon.svg

## Contact form

`contact.html` POSTs to the `stockwell-lead` Supabase edge function, which stores
the lead, texts Stock via the outbox, and emails the Stockwell inbox. The
function's CORS allowlist contains `https://stock-ctrl.github.io`, which is the
same origin as before, so moving to the root did not change anything there.

Backend source lives in `stock-ctrl/stockwell-media` under `supabase/`.

## Related

- `card/` — the NFC business card, served at stockwellmedia.com/card/. Edit
  `card/index.template.html`, then `python3 card/build.py` (never edit `card/index.html`).
  `stock-ctrl/card` now only forwards the old stock-ctrl.github.io/card/ address
  (what the NFC tags open) here, and keeps the Flipper tooling.
- `stock-ctrl/stockwell-media` — digital business card, email signature, avatar,
  the Supabase backend, and the WIP trades estimator (`website/trades-demo.html`)

## Note on site.css

`site.css` is duplicated here and in `stockwell-media/website/`, because the WIP
trades estimator and aerial picker pages there still depend on it. If you change
this one for the site, that estimator can drift. Fold the estimator in here when
it ships and the duplicate goes away.
