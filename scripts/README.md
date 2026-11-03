# scripts

Tools for working on the app. None of them ship with it. Run them from the
repository root.

| Folder | What is in it | Run |
| --- | --- | --- |
| `dev/` | Looking at and driving the interface while you work on it | |
| `dev/ui-preview/` | The interface in a plain browser, on a mocked backend | `npm run ui:preview` |
| `dev/drive-ui.mjs` | Types, clicks and reads in the running app's WebView | `node scripts/dev/drive-ui.mjs text` |
| `dev/capture-window.ps1` | A PNG of the app's window (Windows) | `powershell -File scripts/dev/capture-window.ps1` |
| `extension/` | Building and packing the browser extension | |
| `extension/pack.mjs` | The store, full and Firefox zips | `npm run extension:pack` |
| `extension/pack-debug.mjs` | Unpacked copies for the debug edition of the app | `node scripts/extension/pack-debug.mjs` |
| `extension/edition.mjs` | Cuts the store build out of the full one (used by the two above) | |
| `extension/key.mjs` | Makes the development signing key, once | `node scripts/extension/key.mjs` |
| `extension/make-icons.mjs` | The toolbar icons, from the mark | `node scripts/extension/make-icons.mjs` |
| `extension/store-assets.mjs` | The store listing's screenshots | `node scripts/extension/store-assets.mjs` |
| `generate/` | Files that are generated but committed | |
| `generate/icon.py` | The mark at every size the app, the README and Android use | `python scripts/generate/icon.py` |
| `generate/licenses.py` | The third-party licence list shown in About | `python scripts/generate/licenses.py` |
| `release/notes.mjs` | The text of the release page | `npm run release:notes` |
| `intro-video/` | Renders the phone's first-run film to stills or a video | `node scripts/intro-video/render.mjs --sheet` |

The extension's tests are in `extension/tests/`, and the interface's sit beside
the code they test in `src/`.
