# RaceLog Phase 0

Throwaway test app. It checks whether an installed web app on an iPhone opens with no signal and keeps its saved entries. It holds no real setup data.

Files: `index.html`, `app.js`, `style.css`, `sw.js` (offline cache), `manifest.webmanifest`, icons.

The real RaceLog product will live in a separate private repository.

## Phase 0b (folder `b/`)

Sync test. Entries saved on the phone upload to a Supabase database when there is signal. It checks nothing is lost or doubled. Run `b/supabase-setup.sql` once in the Supabase SQL editor, then put the project URL and the publishable key in `b/config.js`. Never put a secret key in that file.

The Phase 0 files in the repository root are left unchanged on purpose, so the 7-day storage test on the phone is not disturbed.
