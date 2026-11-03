# Releasing

`.github/workflows/release.yml` builds the app for Windows, Android and Arch
Linux and publishes the files to the rolling `latest` release. Run it by hand:
**Actions → Release → Run workflow**, on the default branch.

## What it publishes

| File | Built on | Updates itself |
| --- | --- | --- |
| `UMD-Plus_x64-setup.exe`, `UMD-Plus_x64.msi` | `windows-latest` | yes |
| `UMD-Plus_android_arm64.apk`, `_armv7.apk`, `_x86_64.apk` | `ubuntu-latest` | yes, through Android's installer |
| `UMD-Plus_x86_64.pkg.tar.zst` | an Arch Linux container | no; pacman replaces it |
| `extension-full.zip`, `extension-firefox.zip` | `ubuntu-latest` | no |
| `SHA256SUMS.txt` | | |

The names are fixed. The updater (`src-tauri/src/updater.rs`) looks files up
by name, and the README links to `releases/latest/download/<name>`.

## How a run goes

1. **Check.** The Android signing secrets are present, the interface
   type-checks and builds, and the interface and extension tests pass.
2. **Build.** Windows, Android and Arch build in parallel, all from the same
   commit.
3. **Publish.** Only if all three built. The files replace the release's old
   ones, and then the `latest` tag is moved to the commit they were built
   from.

The order in step 3 matters. Installed apps decide whether there is something
new by comparing their own commit with the one `latest` points at. If the tag
moved first, an app could download the old file under the new commit's name,
install it, and find itself out of date again on the next start.

For the same reason, Windows and Android are never released one without the
other. A failed build stops the whole run, and the tag stays where it was.

## Secrets

Only the Android build needs any. GitHub provides the token that publishes the
release (`GITHUB_TOKEN`) by itself.

Add them under **Settings → Secrets and variables → Actions → New repository
secret**:

| Secret | What it is |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | The release keystore file, base64-encoded on one line |
| `ANDROID_KEYSTORE_PASSWORD` | The keystore's password |
| `ANDROID_KEY_ALIAS` | The key's alias in the keystore |
| `ANDROID_KEY_PASSWORD` | The key's password; the same as the keystore's for a PKCS12 keystore |

### Making the keystore

Do this once and keep the file somewhere safe and backed up. Every APK has to
be signed with the same key. Android installs an update only when its
signature matches the installed copy's. A lost key means everyone has to
uninstall the app and lose their settings and history.

If you already sign APKs by hand with `keystore.properties`, use that keystore
instead of making a new one.

`keytool` comes with any JDK. Android Studio has one in `jbr\bin`.

```bash
keytool -genkeypair -v \
  -keystore umd-plus-release.jks -storetype PKCS12 \
  -alias umd-plus -keyalg RSA -keysize 4096 -validity 10000
```

It asks for a password and a name. The name can be anything.
`ANDROID_KEY_ALIAS` is then `umd-plus`, and both password secrets are the
password you typed.

Avoid backslashes in the password. The build reads it from a Java properties
file, where a backslash starts an escape.

### Encoding it

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

Paste the contents of `keystore.b64` as `ANDROID_KEYSTORE_BASE64`. With the
GitHub CLI you can set all four from a terminal instead:

```bash
gh secret set ANDROID_KEYSTORE_BASE64 < keystore.b64
gh secret set ANDROID_KEYSTORE_PASSWORD
gh secret set ANDROID_KEY_ALIAS --body umd-plus
gh secret set ANDROID_KEY_PASSWORD
```

Delete `keystore.b64` afterwards.

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
