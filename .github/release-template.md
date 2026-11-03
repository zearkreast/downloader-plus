<p align="center">
  <img src="{{raw}}/docs/logo.png" width="88" alt="">
</p>

<h1 align="center">Universal Media Downloader+ {{version}}</h1>

<p align="center">
  Bağlantıyı yapıştır, indir. Reklam yok, hesap yok, takip yok.<br>
  <sub>Paste a link, download it. No ads, no account, no tracking. · <a href="#english">English below</a></sub>
</p>

<p align="center">
  <a href="{{download}}/UMD-Plus_x64-setup.exe"><img alt="Windows" src="https://img.shields.io/badge/Windows-%C4%B0ndir-0078D4?style=for-the-badge&logo=windows&logoColor=white"></a>
  <a href="{{download}}/UMD-Plus_android_arm64.apk"><img alt="Android" src="https://img.shields.io/badge/Android-%C4%B0ndir-3DDC84?style=for-the-badge&logo=android&logoColor=white"></a>
  <a href="{{download}}/UMD-Plus_x86_64.pkg.tar.zst"><img alt="Arch Linux" src="https://img.shields.io/badge/Arch%20Linux-%C4%B0ndir-1793D1?style=for-the-badge&logo=archlinux&logoColor=white"></a>
  <a href="{{download}}/extension-full.zip"><img alt="Tarayıcı eklentisi" src="https://img.shields.io/badge/Eklenti-%C4%B0ndir-ff7a3d?style=for-the-badge&logo=googlechrome&logoColor=white"></a>
</p>

<p align="center">
  <img src="{{raw}}/docs/screens/home.png" width="860" alt="UMD+ ana sayfası">
</p>

## Yenilikler

{{changes}}

<table>
  <tr>
    <td width="50%"><img src="{{raw}}/docs/screens/playlist.png" alt="Bir oynatma listesinden video seçmek"></td>
    <td width="50%"><img src="{{raw}}/docs/screens/downloads.png" alt="İndirmeler ekranı"></td>
  </tr>
  <tr>
    <td align="center"><sub>Listeden istediğin videoları seç</sub></td>
    <td align="center"><sub>İndirmeler, hızı ve kalan süresiyle</sub></td>
  </tr>
</table>

## Hangi dosya bana göre?

| Cihazın | İndireceğin dosya |
| --- | --- |
| **Windows 10 / 11** | [`UMD-Plus_x64-setup.exe`]({{download}}/UMD-Plus_x64-setup.exe) |
| **Android telefon** (neredeyse hepsi) | [`UMD-Plus_android_arm64.apk`]({{download}}/UMD-Plus_android_arm64.apk) |
| Eski, 32 bit Android telefon | [`UMD-Plus_android_armv7.apk`]({{download}}/UMD-Plus_android_armv7.apk) |
| **Arch Linux, CachyOS, EndeavourOS, Manjaro** | [`UMD-Plus_x86_64.pkg.tar.zst`]({{download}}/UMD-Plus_x86_64.pkg.tar.zst) |
| **Chrome, Edge, Brave, Opera, Vivaldi** eklentisi | [`extension-full.zip`]({{download}}/extension-full.zip) |
| **Firefox** eklentisi | [`extension-firefox.zip`]({{download}}/extension-firefox.zip) |

## Kurulum

<details>
<summary><b>Windows</b></summary>

1. `UMD-Plus_x64-setup.exe` dosyasını indirip açın.
2. Mavi bir "Windows bilgisayarınızı korudu" penceresi çıkarsa **Ek bilgi**'ye, sonra **Yine de çalıştır**'a basın. Kurulum dosyası imzalı olmadığı için bu uyarı çıkar.
3. Kurulum bitince UMD+ açılır. Yönetici izni gerekmez.

Daha önce kurulmuş bir sürüm varsa üzerine kurulur; ayarlarınız ve geçmişiniz kalır. Bundan sonraki güncellemeler kendiliğinden gelir.
</details>

<details>
<summary><b>Android</b></summary>

<img src="{{raw}}/docs/screens/phone.png" width="220" align="right" alt="UMD+ telefonda">

1. Telefonun tarayıcısında `UMD-Plus_android_arm64.apk` dosyasını indirin.
2. İndirilen dosyaya dokunun. Android "bilinmeyen kaynaklar" için izin isterse bu kez izin verin.
3. **Yükle**'ye basın.

Android 7.0 ya da daha yenisi gerekir. Eski **Universal Downloader** uygulaması kuruluysa önce onu kaldırın: ikisinin paket adı aynı, imzası farklı.

Başka bir uygulamadaki videoyu indirmek için **Paylaş**'a basıp UMD+'yı seçin. Yeni sürüm çıktığında uygulama açılırken haber verir.
<br clear="right">
</details>

<details>
<summary><b>Arch Linux ve türevleri</b></summary>

Dosyayı indirin, sonra bulunduğu klasörde:

```bash
sudo pacman -U ./UMD-Plus_x86_64.pkg.tar.zst
```

yt-dlp ve FFmpeg paketle birlikte kurulur. YouTube için `deno` paketini de kurun:

```bash
sudo pacman -S deno
```

Paket imzalı değildir ve kendini güncellemez. Güncellemek için yeni paketi aynı komutla kurmanız yeterli.
</details>

<details>
<summary><b>Tarayıcı eklentisi</b></summary>

Eklenti, tarayıcıda oynayan videoyu uygulamaya gönderir. Şimdilik yalnızca Windows'ta çalışır.

1. `extension-full.zip` dosyasını kalıcı bir klasöre açın.
2. Tarayıcıda eklentiler sayfasını açın (`chrome://extensions`, `edge://extensions` ya da `brave://extensions`).
3. **Geliştirici modu**'nu açın, **Paketlenmemiş öğe yükle**'ye basın ve klasörü seçin.

Eski sürümü güncelliyorsanız dosyayı aynı klasöre açıp eklentiler sayfasında **Yeniden yükle**'ye basın.

Firefox için `extension-firefox.zip`, `about:debugging` sayfasından geçici eklenti olarak yüklenir ve Firefox kapanınca kalkar.
</details>

---

<a id="english"></a>
<details>
<summary><b>English</b></summary>

{{changes_en}}

**Windows:** run `UMD-Plus_x64-setup.exe`. It is not code-signed, so choose **More info → Run anyway**. An installed copy updates itself from then on.

**Android 7+:** install `UMD-Plus_android_arm64.apk` (`armv7` for old 32-bit phones). Uninstall the upstream Universal Downloader first; its signature differs.

**Arch Linux and derivatives:** `sudo pacman -U ./UMD-Plus_x86_64.pkg.tar.zst`, plus `deno` for YouTube. Unsigned, and it does not update itself.

**Browser extension (Windows only for now):** unzip `extension-full.zip`, turn on Developer mode on the extensions page and use **Load unpacked**.
</details>

<sub>Her dosyanın SHA-256 özeti `SHA256SUMS.txt` içinde. · Built from <a href="https://github.com/{{repo}}/commit/{{sha}}"><code>{{short}}</code></a> · Based on <a href="https://github.com/unsalable/downloader">unsalable/downloader</a> by Melih, MIT License.</sub>
