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

| Secret | Needed | What it is |
| --- | --- | --- |
| `ANDROID_KEYSTORE_BASE64` | yes | The keystore file (JKS, or PKCS12 as `.p12` or `.pfx`), base64-encoded |
| `ANDROID_KEYSTORE_PASSWORD` | yes | The keystore's password |
| `ANDROID_KEY_ALIAS` | no | The key to sign with. Left out, the keystore's only key is used |
| `ANDROID_KEY_PASSWORD` | no | The key's own password. Left out, the keystore's is used, as it always is for PKCS12 |

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
