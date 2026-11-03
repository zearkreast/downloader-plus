# UMD+ for developers

How the app is put together, how to build and test it, and where it keeps
its files. For using the app, see the [README](../README.md).

## Architecture

UMD+ is a Tauri 2 app. A React interface (`src/`) talks to a Rust core
(`src-tauri/`) over Tauri's IPC, and only through `src/services/ipc.ts`. The
same core and interface make the Android app; a browser extension
(`extension/`) hands links and sessions to the desktop app over native
messaging.

```
src/                       React interface
  App.tsx, main.tsx        The shell: routing between screens, shortcuts, overlays
  pages/                   One per screen: Home, Downloads, Editor, Convert,
                           History, Settings, About
  components/ui/           Design-system primitives (buttons, menus, dialogs)
  components/layout/       Sidebar, phone tab bar, top bar, background, the mark
  components/home/         Analyse, preview and download options
  components/downloads/    Queue rows and the detail window
  components/history/      History rows, clearing it, recent downloads
  components/editor/       The editor's preview, timeline and inspector
  components/convert/      Conversion job rows
  components/settings/     Tool cards, hotkey recorder, browser link
  components/intro/        First run: the phone's film (Remotion), the
                           desktop's welcome
  components/updates/      The update prompt and the silent desktop updater
  stores/                  Zustand stores (settings, queue, convert, editor,
                           tools, analysis, update)
  services/ipc.ts          The only place that calls `invoke`
  lib/                     Pure helpers (formatting, URLs, option derivation),
                           tested beside them
  hooks/                   Shared React hooks
  i18n/                    English source dictionary + Turkish translation;
                           a first launch takes the system's language
  styles/globals.css       Design tokens and the few global classes

src-tauri/                 Rust core and the native projects
  src/lib.rs               Wiring: what starts once, in what order
  src/commands.rs          The IPC surface: every command the interface calls
  src/providers/           Reading a link: source adapters and URL detection
  src/downloader/          Getting the file: planning, HTTP and segmented
                           transfer, control, speed, the queue and its schedule
  src/media/               Everything FFmpeg: merging, converting, the editor's
                           export, range fetches, timeline waveforms and frames
  src/bridge/              The browser link: native messaging host, handoffs,
                           lent sessions (src/bin/ud-bridge.rs is the host)
  src/tools.rs             Finding and installing yt-dlp, FFmpeg and Deno
  src/updater.rs           Finding and installing a newer build
  src/db.rs, cache.rs      SQLite (settings, history, durable queue), thumbnails
  src/android.rs           What only the phone does (see below)
  tests/                   Integration tests against local servers, and the
                           online ones
  gen/android/             The Android project (Gradle, Kotlin plugin)
  capabilities/            What the interface may ask of Tauri
  tauri.conf.json          App, window and installer settings

extension/                 The browser extension: what ships in src/, its tests,
                           its store listing (see extension/README.md)
scripts/                   Tools for working on it (see scripts/README.md)
packaging/arch/            The Arch Linux package
```

### Provider architecture

Every source adapter implements the same three-method `MediaProvider` trait
(`id`, `can_handle`, `analyze`) in `src-tauri/src/providers/mod.rs`. Adding a
platform means adding a module and a branch in `analyze`. Resolution order is:
a service that encrypts its streams (refused at once) or a song shared from
Spotify → a direct media file → a photo post → the engine → the generic page
reader → unsupported.

The engine is a video tool, and photo posts are where that shows. It is run
with `--ignore-no-formats-error`, so a post with pictures and no stream is
reported rather than refused, and on Instagram and Pinterest the pictures it
lists are offered at full size. For the platforms whose photos it does not
return at all -- X, Reddit and TikTok photo mode -- `providers/photos/` reads
the post from the same public data the platform's website loads for a
signed-out visitor, before the engine is started; anything that turns out to
be a video is left to the engine as before. A gallery is one analysis with
every item in it (`MediaMetadata::entries`), and each queued item names its
position, so it downloads that item and not the first one again.

The trait is used for static dispatch rather than behind `dyn`: its methods are
async and the set of providers is closed, so calling them directly keeps the
path allocation-free while still making the shared contract explicit.

### Android

The phone build is the same Rust core and the same interface. What differs is
confined to `src-tauri/src/android.rs`, a Kotlin plugin in
`src-tauri/gen/android` (`BridgePlugin.kt`, `BackgroundWorkService.kt`) and a
handful of `IS_MOBILE` branches in the front end.

- **Tools.** Android refuses to run a file an app has downloaded, so Python 3,
  FFmpeg, ffprobe and QuickJS ship inside the APK as native libraries -- the
  packaging maintained by [youtubedl-android](https://github.com/JunkFood02/youtubedl-android),
  whose `jni` folders the Gradle build extracts. Their support libraries are
  unpacked once per install. yt-dlp itself is a Python program, so it is still
  fetched on request and kept up to date exactly as on Windows; the bundled
  interpreter runs it, and QuickJS is passed to it as the JavaScript runtime.
- **Files.** Downloads are written to the shared Downloads folder and then
  announced to the media index. Files picked for conversion arrive as content
  URIs, so they are copied into the cache first, and results go to Downloads.
- **Background.** A foreground service runs while anything is downloading or
  converting; without it Android freezes the app as soon as it leaves the
  screen. It stops when the queue is empty.
- **Interface.** A bottom tab bar replaces the sidebar, Back returns to Home,
  and links shared from other apps are analysed on arrival. Settings is a list
  of sections, each opening on its own page, with rows and controls sized for
  touch. Desktop-only settings (tray, autostart, shortcuts, tool paths, folder
  pickers) are hidden. Pressing Download moves to the Downloads tab.
- **First run.** The first launch plays a short film of how the app is used,
  drawn live from the app's own screens and strings with `@remotion/player`
  (`src/components/intro`, loaded only then), so it follows the language and
  theme and adds no video to the APK. The screen is held upright while it
  plays, About can play it again, and with reduced motion or low resource mode
  it is the still welcome the desktop shows. `node scripts/intro-video/render.mjs`
  renders the same film to stills or an MP4 for review.
- **Heat.** A phone pays for effects a desktop does not notice. Frosted glass
  and the moving aurora are replaced by solid panels and a still backdrop,
  progress bars move by transform, list items skip layout animation, and the
  app no longer re-renders every screen on each progress tick. The analysis
  the user just saw is reused when Download is pressed rather than run again
  -- for YouTube that is a Python start and a JavaScript challenge solved
  twice -- and yt-dlp reports progress twice a second instead of per block.
- **Updates.** A build records the commit it came from (`build.rs`). Releases
  are unversioned, so `src-tauri/src/updater.rs` compares that commit with the
  one the `latest` tag points at; a difference means a newer build. The APK is
  verified against the SHA-256 digest GitHub publishes for the asset, and
  `BridgePlugin.installApk` asks for the install permission if needed and opens
  the system installer. Always build release APKs from a committed tree, and
  move the tag only after the new files are uploaded.

### Two external tools

On Windows neither is bundled. Both are fetched once, on request, into the
app's own data directory — and a copy already on your `PATH` is preferred over
downloading anything. (On Android FFmpeg ships inside the APK and only yt-dlp
is fetched; see above.)

- **yt-dlp** reads public metadata and stream URLs. It changes weekly, so a
  bundled copy would be stale the month after release.
- **FFmpeg** merges separate audio and video streams and handles conversion.
  It is GPL, which is cleanest to keep as a separate process the user opts into.

Both run as separate processes with an argument vector. No user-supplied URL
ever reaches a command line as text that could be re-parsed.

### The download path

`downloader/plan.rs` turns a request into concrete streams — this is where
"Best quality" stops being a word. It is pure, so the selection rules are
tested directly. The UI asks this same code what a selection resolves to
(`summarize_plan`), which is why the quality, container and estimated size it
shows always match what the download does.

Progressive streams are fetched by `downloader/http.rs` in bounded chunks. A
file on a host that answers ranged requests and states its size is handed to
`downloader/segmented.rs` instead, which splits it over the configured number
of connections, writes each piece at its own offset of one preallocated
`.part` file, and keeps the pieces' progress in a `.part.segs` sidecar written
only after the data it describes has been synced, so a pause, a crash or a
restart carries on every piece where it stopped. A file that changed on the
server is fetched again rather than stitched. Its progress reports carry the
segment map the detail window draws. Anything that cannot be split -- no range
support, no stated size, under 4 MiB -- stays on the single-connection path.
Segmented protocols (HLS, DASH) are handed to the engine, whose progress is
read back through a machine-readable template so the UI shows the same real
byte counts either way.

### The conversion path

`media/converter.rs` starts from a local file rather than a URL, but reuses
the same machinery: FFmpeg is driven through `ffmpeg::run_with_progress`
(`media/ffmpeg.rs`), and a job is interrupted through the same `TaskControl`
a download uses.

Each job runs up to three passes, stopping at the first that produces a file:

1. **Repackage.** Attempted when the target container can already hold the
   source codecs -- H.264 and AAC moving from MKV into MP4, say. No encoder is
   named at all, so it is I/O bound and lossless. Where a quality is offered,
   only "Original" asks for it; High, Balanced and Small always re-encode, and
   so does asking for a smaller frame, a lower frame rate or a specific
   bitrate, since a copy would ignore them. A GIF is never a copy: its palette
   is the conversion.
2. **GPU encode.** Attempted for an H.264 video target when hardware
   acceleration is enabled. It is absent on most machines without an NVIDIA
   card, so it is only ever an attempt.
3. **CPU encode.** Always last, and what actually guarantees a result.

Conversions run one at a time: encoding saturates every core it is given, so a
second job alongside finishes neither any sooner. Nothing is written over the
source -- the output name is made unique in its directory at the moment the job
runs, so converting `clip.mkv` to MP4 beside itself yields `clip.mp4`, and doing
it again yields `clip (2).mp4`.

The job list is deliberately not persisted. An interrupted encode has no
resumable state, and re-running one nobody asked for would burn a CPU at sign-in.

### Single source of truth

Three rules the codebase holds to:

- Platform detection lives only in `providers/detect.rs`. The front end asks
  over IPC rather than keeping a second copy of the host patterns.
- Format selection lives only in `downloader/plan.rs`. The options panel calls
  it rather than re-deriving the same rules in TypeScript.
- The set of conversion targets lives only in `media/converter.rs`. The Convert screen
  fetches it (`convert_formats`) rather than listing formats a second time, so
  it cannot offer one the backend would refuse.

---

## Development

Requirements: Node 22.12+, Rust 1.82+, and the MSVC build tools.

```bash
npm install
npm run app:dev      # Vite + Tauri, hot reload
```

Other scripts:

```bash
npm run build          # type-check and build the front end
npm run app:build      # production build + NSIS installer
npm run android:build  # signed release APKs for arm64, armv7 and x86_64
npm run android:dev    # run on a connected phone or emulator
npm run test:web       # front-end unit tests (Vitest)
npm run test:extension # the browser extension's tests (node --test)
npm run test:rust      # Rust unit and hermetic integration tests
npm run test:python    # the DNS fallback the phone app loads into yt-dlp
npm run test:online    # network tests (installs the engine, downloads real files)
npm run test:all       # build, then the web, Rust and Python tests
npm run lint:rust      # clippy, warnings denied
npm run ui:preview     # the interface in a browser, on a mocked backend
npm run extension:pack # the extension's store, full and Firefox zips
npm run release:notes  # the release page's text, for a look before a release
```

Everything under `scripts/` is listed, with what it is for, in
[scripts/README.md](../scripts/README.md).

The Android build needs JDK 17, the Android SDK with NDK r29, and the Rust
targets `aarch64-linux-android`, `armv7-linux-androideabi` and
`x86_64-linux-android`, with `JAVA_HOME`, `ANDROID_HOME` and `NDK_HOME` set.
Release APKs are signed from `src-tauri/gen/android/keystore.properties`, which
is not in the repository:

```properties
storeFile=C:/path/to/universal-downloader.jks
storePassword=...
keyAlias=universal-downloader
keyPassword=...
```

Without it the release build is produced unsigned. Keep the keystore safe: an
APK signed with a different key cannot update an installed copy.

Releases are built and published by GitHub Actions, for Windows, Android and
Arch Linux at once. See [RELEASING.md](RELEASING.md) for how to run
it and which secrets it needs.

There is no JavaScript linter configured. `typescript-eslint` does not yet
support TypeScript 7, and forcing it past its peer range would leave a parser
running against a compiler API it does not understand. The TypeScript config
carries the checks that would otherwise be delegated to lint rules — `strict`,
`noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`,
`noFallthroughCasesInSwitch` — and should be revisited once the plugin
catches up.

### Tests

- `src/**/*.test.ts` — front-end unit tests (Vitest) for the pure helpers and
  stores: option derivation, the editor's segments and bitrates, settings,
  hand-offs, recent downloads.
- `extension/tests/` — the browser extension's tests, `npm run
  test:extension`, kept outside `extension/src/` so no package ever carries
  them.
- `src-tauri/src/**` — unit tests next to the code they cover: URL
  classification, format selection, file naming, speed smoothing, pause/cancel
  signalling, engine output parsing, FFmpeg argument construction.
- `src-tauri/tests/resume.rs` — chunking and resume, against a purpose-built
  local HTTP server. Hermetic: no network, and the server's range behaviour is
  a controlled variable rather than a guess about some CDN.
- `src-tauri/tests/segmented.rs` — splitting over real concurrent connections
  against a local server: byte-exact output, the segment map, resume of every
  piece, a host that refuses extra connections, a file that changed between
  runs, a split partial continued by one connection, and one that lost its
  record.
- `src-tauri/tests/pipeline.rs` — `#[ignore]`d online tests that install the
  engine, read live metadata, and download a real file end to end.
- `src-tauri/tests/photos.rs` — `#[ignore]`d online tests that read photo posts
  on each platform and download real pictures through the queue's own path,
  plus a check that videos on the same platforms still go to the engine.

### Looking at the interface without the app

`npm run ui:preview` serves the real interface at http://localhost:1430 with
`scripts/dev/ui-preview/mock-tauri.js` standing in for the Rust side, so every
screen can be looked at and clicked through without building it. Add
`?platform=android` for the phone, `?theme=light`, or `?lang=en`; the header of
`mock-tauri.js` lists the other switches.

### Driving the running app

`scripts/dev/drive-ui.mjs` talks to the running app's WebView over the Chrome
DevTools Protocol, so real flows can be exercised against the real backend:

```bash
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 \
  ./src-tauri/target/debug/universal-downloader.exe &

node scripts/dev/drive-ui.mjs type "https://..."
node scripts/dev/drive-ui.mjs press Enter
node scripts/dev/drive-ui.mjs wait "text==Download" 30000
node scripts/dev/drive-ui.mjs click "text==Download"
node scripts/dev/drive-ui.mjs text
```

`scripts/dev/capture-window.ps1` captures the window to a PNG (via `PrintWindow`
with `PW_RENDERFULLCONTENT`, which a plain screen copy would render black).

### Generated assets

```bash
python scripts/generate/icon.py               # the mark, flat on transparency, at 1024
node scripts/extension/make-icons.mjs         # the extension's toolbar icons
npx tauri icon src-tauri/icons/app-icon.json -o src-tauri/icons
python scripts/generate/licenses.py           # third-party licence list for About
```

The mark is an eight-blade aperture with a plus in its opening and nothing
else: no tile, no plate, no backing. It is the same shape in three hands — `scripts/generate/icon.py`,
`src/components/layout/Logo.tsx` and `scripts/extension/make-icons.mjs` — which
have to be changed together.

The Tauri CLI is pointed at `app-icon.json` rather than straight at a PNG for
two reasons. A bare-PNG run writes its own default background into
`gen/android/app/src/main/res/values/ic_launcher_background.xml`, losing the
colour the adaptive icon sits on; and Android's launcher mask crops a
foreground that reaches the canvas edge, so the manifest points at the inset
`icon-source-fg.png` instead. Every run also drops a `src-tauri/icons/ios/`
directory this project has no target for; delete it afterwards. There is nothing
separate to generate for the notification area — the tray takes the window icon
the bundle already carries.

---

## Where things are stored

Everything the app writes lives under `%APPDATA%\UniversalDownloader` (on
Android, in the app's private storage):

```
library.db     settings, history and the durable queue (SQLite, WAL)
host-limits.json
               hosts that turned connections away, and how many they took
tools/         managed copies of yt-dlp and ffmpeg
cache/         thumbnails, bounded by the configured cache limit
temp/          in-flight downloads; a finished file is moved out
logs/          app.log and error.log, rotated by size
bridge/        the browser link's state and the sessions it lends, sealed
               with DPAPI (Windows only)
```

Downloads themselves go to your own Downloads folder by default.
