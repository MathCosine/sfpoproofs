# supabase-js 2.45.4

The browser build of [supabase-js](https://github.com/supabase/supabase-js),
copied unchanged from `node_modules/@supabase/supabase-js/dist/umd/` of the
version pinned in `package.json`. MIT licensed; see `LICENSE`.

It is served from this site rather than a CDN so that contest day depends on
two services, not three: a venue network that blocks or stalls a CDN cannot
stop anyone signing in. To upgrade, bump the version in `package.json`, run
`npm install`, copy the two `.js` files into a new folder named for the
version, and change `SUPABASE_JS` in `assets/store.js`. `npm run test:auth`
loads this exact file.
