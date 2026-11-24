# Releasing

`.github/workflows/release.yml` builds the app for Windows, Android and Arch
Linux and publishes the files as a release of their own, `v<version>`, with
that version's notes, marked latest. Run it by hand:
**Actions → Release → Run workflow**, on the default branch.

The same files also go to the rolling `latest` release, which is kept as a
pre-release for copies from before 3.3.3: those read only that release. From
3.3.3 the updater reads whichever release GitHub marks as latest.

## What it publishes

| File | Built on | Updates itself |
| --- | --- | --- |
| `UMD-Plus_x64-setup.exe`, `UMD-Plus_x64.msi` | `windows-latest` | yes |
| `UMD-Plus_android_arm64.apk`, `_armv7.apk`, `_x86_64.apk` | `ubuntu-latest` | yes, through Android's installer |
| `UMD-Plus_x86_64.pkg.tar.zst` | an Arch Linux container | no; pacman replaces it |
| `extension-full.zip`, `extension-firefox.zip` | `ubuntu-latest` | no |
| `extension-firefox.xpi`, `firefox-updates.json` | `ubuntu-latest`, signed by addons.mozilla.org | yes; Firefox reads `firefox-updates.json` |
| `SHA256SUMS.txt` | | |

The names are fixed. The updater (`src-tauri/src/updater.rs`) looks files up
by name, and the README links to `releases/latest/download/<name>`, which
GitHub sends to the release marked latest.

## How a run goes

1. **Check.** The Android signing secrets are present, the interface
   type-checks and builds, and the interface and extension tests pass.
2. **Build.** The Firefox add-on is signed first, then Windows, Android and
   Arch build in parallel, all from the same commit. The Windows and Arch
   builds carry the signed add-on (`UD_FIREFOX_XPI`, read by `build.rs`), and
   the app writes it beside the unpacked extension folder. A failed or skipped
   signing does not stop the run: that release simply has no `.xpi`.
3. **Publish.** Only if all three built. The files replace the rolling
   release's old ones and the `latest` tag is moved to the commit they were
   built from. Then the version is tagged, its release is made as a draft,
   filled, and published as latest, and the rolling release is marked a
   pre-release so it never takes that mark.

The order in step 3 matters. Installed apps decide whether there is something
new by comparing their own commit with the one their tag points at: `latest`
for copies before 3.3.3, the latest release's `v<version>` after. If the tag
moved first, an app could download the old file under the new commit's name,
install it, and find itself out of date again on the next start.

For the same reason, Windows and Android are never released one without the
other. A failed build stops the whole run, and the tag stays where it was.

## The release page

Each run writes the release's title and page. The page is
`.github/release-template.md`, filled in by `scripts/release/notes.mjs`: the
version, download buttons, screenshots from `docs/screens/`, install steps
for each platform, and what is new.

What is new comes from `docs/releases/<version>.md`: a short Turkish list, then
a line `## English` and the same in English. Write it before running the
workflow. Text in the run's **notes** box replaces the Turkish part. With
neither, the page points at the commits.

To see the page before a run:

```bash
node scripts/release/notes.mjs > notes.md
```

The run also tags the commit `v<version>`, unless that tag already exists.

## Secrets

The Android build needs its own, and the Firefox signing two more that may be
left out. GitHub provides the token that publishes the release
(`GITHUB_TOKEN`) by itself.

Add them under **Settings → Secrets and variables → Actions → New repository
secret**:

| Secret | Needed | What it is |
| --- | --- | --- |
| `ANDROID_KEYSTORE_BASE64` | yes | The keystore file (JKS, or PKCS12 as `.p12` or `.pfx`), base64-encoded |
| `ANDROID_KEYSTORE_PASSWORD` | yes | The keystore's password |
| `ANDROID_KEY_ALIAS` | no | The key to sign with. Left out, the keystore's only key is used |
| `ANDROID_KEY_PASSWORD` | no | The key's own password. Left out, the keystore's is used, as it always is for PKCS12 |
| `AMO_JWT_ISSUER` | no | addons.mozilla.org API key ("JWT issuer"). Left out, no signed Firefox add-on is made |
| `AMO_JWT_SECRET` | no | The secret that goes with it |

### The Firefox signing keys

Release Firefox installs only add-ons Mozilla has signed. The workflow sends
the Firefox build to addons.mozilla.org as an **unlisted** add-on: it is
checked automatically and signed, but not shown in the store, and updates come
from `firefox-updates.json` on this repository's release rather than from AMO.

1. Sign in at <https://addons.mozilla.org/developers/> with a Firefox account.
2. Open <https://addons.mozilla.org/developers/addon/api/key/> and generate
   credentials. Put the **JWT issuer** in `AMO_JWT_ISSUER` and the **JWT
   secret** in `AMO_JWT_SECRET`.

### Firefox Add-ons (AMO)

The Release workflow sends the build to the unlisted channel only. To publish
a version on the add-on's AMO page as well, run **Actions → Firefox (AMO) →
Run workflow** (`.github/workflows/amo.yml`). It submits the Firefox build to
the listed channel, with no `update_url`, and with release notes from
`docs/releases/<version>.md`. Mozilla reviews it; nothing comes back to the
release.

AMO takes a version number once across both channels, and the Release workflow
has already used the app's own number for the unlisted channel. So the listed
one goes out with a fourth part, `.1` unless a version is given: 3.3.4 goes to
AMO as 3.3.4.1, and a second try needs 3.3.4.2.

AMO signs each version once. If a run fails after the Firefox job finished, use
**Re-run failed jobs**, which keeps the signed file; a fresh run of the same
version is refused by AMO. The add-on's id is `connector@umdplus.app`
(`scripts/extension/pack.mjs`); changing it makes a different add-on, which
installed copies will not update to.
Keep the keystore file and its password somewhere safe and backed up. Every
APK has to be signed with the same key, because Android installs an update
only when its signature matches the installed copy's. A lost key means
everyone has to uninstall the app and lose their settings and history.

If you already sign APKs by hand with `keystore.properties`, use that keystore
rather than making a new one.

Use only English letters and digits in the password. The build reads it from a
Java properties file, which takes the file as Latin-1, so letters such as ş or
ı would arrive as something else.

### Making the keystore on Windows, with nothing to install

PowerShell can make the key and export it. Run these one at a time in a normal
PowerShell window; it does not need to be run as administrator.

```powershell
$cert = New-SelfSignedCertificate -Subject "CN=UMD Plus" -KeyAlgorithm RSA -KeyLength 4096 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(30) -CertStoreLocation Cert:\CurrentUser\My
```

```powershell
$password = Read-Host "Keystore password (English letters and digits)"
```

```powershell
$file = Join-Path ([Environment]::GetFolderPath("Desktop")) "umd-plus-release.pfx"
Export-PfxCertificate -Cert $cert -FilePath $file -Password (ConvertTo-SecureString $password -AsPlainText -Force)
```

```powershell
Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)" -DeleteKey
```

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes($file)) | Set-Clipboard
```

The third command writes `umd-plus-release.pfx` to the desktop: that file is
the keystore, so keep it. The fourth removes the copy Windows kept in its own
certificate store. The last puts the base64 text on the clipboard: paste it as
`ANDROID_KEYSTORE_BASE64`, and the password as `ANDROID_KEYSTORE_PASSWORD`.
The other two secrets are not needed.

### Making the keystore with a JDK

`keytool` comes with any JDK. Android Studio has one in `jbr\bin`.

```bash
keytool -genkeypair -v -keystore umd-plus-release.jks -storetype PKCS12 -alias umd-plus -keyalg RSA -keysize 4096 -validity 10000
```

Then encode it.

Linux:

```bash
base64 -w0 umd-plus-release.jks > keystore.b64
```

macOS:

```bash
base64 -i umd-plus-release.jks | tr -d '\n' > keystore.b64
```

Windows (PowerShell):

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("umd-plus-release.jks")) | Set-Content -NoNewline keystore.b64
```

Paste the contents of `keystore.b64` as `ANDROID_KEYSTORE_BASE64`, then delete
`keystore.b64`. With the GitHub CLI:

```bash
gh secret set ANDROID_KEYSTORE_BASE64 < keystore.b64
gh secret set ANDROID_KEYSTORE_PASSWORD
```

## The move to app.umdplus

The phone app's package changes from `io.universaldownloader.app` to
`app.umdplus` (see `docs/DEVELOPMENT.md`). Release it in this order:

1. A build still under the old package that has the move prompts in it.
   Installed copies update to it as usual.
2. The build under the new package. Each old copy's updater installs it as a
   second app; the old copy then sends the user to the new one, and the new
   one offers to remove the old.

A copy that skips the first build still gets the new app from its updater,
and the new app still offers to remove it; it only misses the old copy's
hand-over.

Keep signing every APK with the same key. Android lets an app remove another
only with the user's yes, whatever the key, but a later update of the new
package is refused under a different one.

## Repository settings

- **Settings → Actions → General → Workflow permissions.** The publish job
  asks for `contents: write` itself. This only matters if an organisation
  policy limits workflows to read access.
- **Immutable releases** must stay off. The workflow replaces files in an
  existing release, which an immutable release forbids.

## Not covered

- **Code signing for Windows.** The installers are unsigned, as before, so
  SmartScreen warns on first run. Signing needs a certificate, for example
  Azure Trusted Signing or an OV/EV certificate, and a signing step after
  `npx tauri build`.
- **Signing the Arch package.** It is unsigned. pacman installs an unsigned
  package from a local file, but not straight from a URL, so the README says
  to download it first.

## Versions from before releases had their own

Until 3.3.2 every version went only to the rolling release. The one-off
`.github/workflows/backfill-releases.yml` gives those versions releases of
their own from the files their Release runs kept as artifacts (kept 90 days),
with the notes `scripts/release/version-notes.mjs` takes from
`docs/releases`. It compiles nothing.
