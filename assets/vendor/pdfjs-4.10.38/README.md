# pdf.js 4.10.38

The legacy browser build of [pdf.js](https://github.com/mozilla/pdf.js), copied
from `node_modules/pdfjs-dist/legacy/build/` of the version pinned in
`package.json`. The files are unchanged apart from their names: `.mjs` became
`.js`, so any static host serves them as JavaScript. Apache 2.0; see `LICENSE`.

Used only by the Email the reports panel, to read the text of each page of a
saved reports PDF and work out whose report it is. Nothing loads it until a
PDF is chosen there. To upgrade, bump the version in `package.json`, run
`npm install`, copy `pdf.min.mjs` and `pdf.worker.min.mjs` into a new folder
named for the version (as `.js`), and change `PDFJS` in `assets/mailer.js`.
