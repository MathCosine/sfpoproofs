# modern-screenshot 4.7.0

The ES module build of [modern-screenshot](https://github.com/qq15725/modern-screenshot),
copied unchanged from `node_modules/modern-screenshot/dist/index.mjs` of the
version pinned in `package.json`, renamed to `.js`. MIT licensed; see `LICENSE`.

Used only when emailing the score reports: each report page is laid out in a
hidden frame and drawn to an image at print resolution by the browser itself,
then set on a Letter page with pdf-lib. Nothing loads it until a send starts.
