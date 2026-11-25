# Günlük Algoritma Antrenmanı

13 kademe, 120 soru. Cloudflare Workers + D1 üzerinde çalışan, **sadece senin girebildiğin** kişisel antrenman uygulaması. Kod public, içerik ve veriler giriş arkasında.

- İlerleme, notlar ve günlük zincir D1'de: telefonda ve bilgisayarda aynı veri.
- Her soruda: işaret kutusu, **Zorlandım**, **Bana gönder** (panoya kopyalar), **Notlarım** (Yaklaşım / Big O / Kod / Takıldığım yer, otomatik kayıt).
- Üstte: Bugün: Gün N · Zincir, bugünün önerilen sorusu (her 7. gün tekrar günü), kademe bazında ilerleme, tekrar listesi.
- Her sorunun ipucunun altında **Çözüm (C#)** editörü: taslak otomatik kaydedilir, **Onayla ve GitHub'a gönder** ile `algoritmalar` reposunun `solutions/` klasörüne commitlenir.
- Menü: Şifre değiştir · Yedek (JSON indir / geri yükle) · Çıkış.

## Kurulum (adım adım)

### 1. GitHub
1. Repo: **`bilaltozluyurt/algoritmalar`** (public). Uygulama kodu ve `solutions/` klasöründeki çözümler aynı repoda durur.
2. Bu klasördeki tüm dosyaları repo **köküne** yükle (alt klasöre koyma). Kökte `wrangler.jsonc`, `package.json`, `worker/`, `public/` görünmeli.
   - `.gitignore` da gelsin; `node_modules/`, `.wrangler/`, `.dev.vars` repoya girmez.

### 2. D1 veritabanı
1. Cloudflare panel → **Storage & Databases → D1** → **Create database**.
2. Ad: `algoritmalar`. Location: **Eastern Europe**.
3. Oluşan veritabanının **Database ID** değerini kopyala.
4. GitHub'da `wrangler.jsonc` dosyasını aç, `"database_id"` satırındaki sıfırları bu ID ile değiştir, commit et.
   (Database ID gizli bilgi değildir, repoda durabilir.)

Tablolar elle kurulmaz; Worker ilk istekte kendisi oluşturur.

### 3. Worker'ı bağla
1. **Workers & Pages → Create → Import a repository**.
2. GitHub'ı bağla, repoyu seç.
3. Proje adı: **`algoritmalar`** (`wrangler.jsonc` içindeki `"name"` ile aynı olmalı).
4. Build command: boş bırak. Deploy command: `npx wrangler deploy`. Root directory: `/` (boş).
5. **Deploy**. Bundan sonra her push otomatik yayınlanır.
6. Worker → Settings → **Build** → **Build watch paths**: Include `*`, Exclude `solutions/*`. Böylece web sayfasından atılan çözüm commit'leri gereksiz yere yeniden yayın başlatmaz.

### 4. Kurulum kodu (Secret)
1. Worker → **Settings → Variables and Secrets** (Build bölümündeki değil!).
2. **Add** → Type: **Secret** → Name: `KURULUM_KODU` → Value: uzun, tahmin edilemez bir metin → **Deploy**.

> Düz **Variable** (Text) kullanma: panelden eklenen düz değişkenler her git yayınında silinir. Secret kalıcıdır.

### 5. Hesabını oluştur
1. Worker adresini aç (`https://algoritmalar.<hesabın>.workers.dev`).
2. Ekran **İlk kurulum** modunda açılır: kurulum kodu + e-posta + şifre (en az 8 karakter, harf + rakam).
3. Hesap oluşunca kurulum kalıcı olarak kapanır (409). İstersen `KURULUM_KODU` Secret'ını artık silebilirsin.

### 6. Telefona ekle
- iPhone: Safari'de aç → Paylaş → **Ana Ekrana Ekle**.
- Android: Chrome menüsü → **Ana ekrana ekle**.

### 7. GitHub çözümleri (algoritmalar reposu)
Çözümler `bilaltozluyurt/algoritmalar` reposuna, sorunun kademesine göre şu yapıda commitlenir:
```
solutions/kademe-00/01-en-buyuk-ve-en-kucuk.cs
solutions/kademe-02/04-anagram-mi.cs
solutions/kademe-12/10-duzenleme-mesafesi-ileri.cs
```
**Token oluştur (bir kez):**
1. GitHub → Settings → Developer settings → **Personal access tokens → Fine-grained tokens → Generate new token**.
2. Repository access: **Only select repositories** → `algoritmalar`.
3. Permissions → Repository permissions → **Contents: Read and write** (başka izin verme).
4. Süre: istediğin kadar (dolunca uygulama "token geçersiz" der, yenisini koyarsın).
5. Cloudflare → Worker → Settings → **Variables and Secrets** → Type **Secret** → `GITHUB_TOKEN` → token'ı yapıştır → Deploy.

Repo adı `wrangler.jsonc` içindeki `"vars"` → `GITHUB_REPO` satırında (gizli değil). Varsayılan dal dışında bir dala yazmak için oraya `"GITHUB_DAL": "dal-adi"` ekle.

**Nasıl çalışır:**
- Editör boşsa sorunun başlığı, açıklaması, örneği ve çalıştırma komutuyla bir şablon gelir. Yazdıkların 1 sn sonra D1'e taslak olarak kaydedilir (GitHub'a gitmez).
- **Onayla ve GitHub'a gönder** → dosya yoksa oluşturulur, varsa güncellenir (commit: `Çözüm eklendi: K2 · 4. Anagram mı?`). Soru çözülmüş olarak işaretlenir. İçerik GitHub'dakiyle aynıysa commit atılmaz.
- PC'de dosyayı düzenleyip push'ladıysan **GitHub'dan çek** ile editöre al.
- Token yalnızca Worker'da durur; tarayıcıya hiç gelmez. Dosya yolu sunucuda doğrulanır, sadece `solutions/kademe-XX/NN-*.cs` yazılabilir.

**VS Code'da test (PC):**
1. .NET **10** SDK kurulu olsun (`dotnet --version` → 10.x). VS Code'da **C# Dev Kit** eklentisi.
2. `git pull`, sonra repo kökünden:
   ```
   dotnet run --file solutions/kademe-02/04-anagram-mi.cs
   ```
   Her dosya kendi başına çalışan tek dosyalık bir C# programıdır (proje dosyası gerekmez). İlk satırdaki `#:property PublishAot=false` ilk çalıştırmayı hızlandırır, silme.
3. **Repo kökünde bir `.csproj` varsa** (ör. `Program.cs`'li proje): .NET o projeyi derlerken `solutions/` altındaki dosyaları da içine alır ve proje derlenmez. `.csproj` dosyasına şunu ekle:
   ```xml
   <ItemGroup>
     <Compile Remove="solutions/**" />
   </ItemGroup>
   ```
   Ayrıca `--file` bayrağını kullan: kökte `.csproj` varken düz `dotnet run dosya.cs` ana projeyi çalıştırır.

### Eski ilerlemeni taşı
Eski statik sayfada işaretlediğin sorular o tarayıcının hafızasındaydı. Uygulamayı **aynı tarayıcıda** ilk açtığında sunucu boşsa “Bu cihazdaki X işaretli soru buluta aktarılsın mı?” diye sorar. Not: eski sayfa claude.ai üzerinde açıldıysa o veri farklı bir adrese (origin) aittir ve yeni uygulama göremez; bu durumda soruları elle işaretle.

## Güvenlik özeti
- Her istek önce Worker'a gelir (`run_worker_first`). Oturum yoksa yalnızca giriş sayfası, ikonlar ve manifest sunulur; geri kalan her şey `/giris.html`'e yönlenir, `/api/*` 401 döner.
- Şifre: PBKDF2-SHA256, 16 byte tuz, 20.000 tur (`pbkdf2$tur$tuz$hash`). Ücretsiz plandaki 10 ms CPU sınırı için tur sayısı bilinçli olarak düşük tutuldu.
- Oturum: 32 byte rastgele token, veritabanında yalnızca SHA-256 özeti. Çerez `HttpOnly; Secure; SameSite=Strict`, 30 gün; süre yarılanınca uzar. Çıkışta ve şifre değişikliğinde diğer oturumlar silinir.
- Kaba kuvvet: 15 dakikada e-posta başına 8, IP başına 30 hatalı deneme → 429. Kilit şifre kontrolünden önce çalışır: kilitliyken doğru şifre de reddedilir, mesaj bunu söyler.
- CSRF: GET dışındaki API isteklerinde `X-Uygulama: 1` başlığı zorunlu (yoksa 403).
- Başlıklar: `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `X-Robots-Tag: noindex`; API'de `Cache-Control: no-store`.
- Repoda gizli bilgi yok. Tek gizli değer `KURULUM_KODU` (Secret).

## Yerelde çalıştırma
```bash
npm install
echo KURULUM_KODU=test > .dev.vars
npx wrangler dev --local
```
`http://localhost:8787` → kurulum kodu `test`.

Windows PowerShell'de ikinci satır yerine: `Set-Content .dev.vars "KURULUM_KODU=test"`

## Sık karşılaşılan sorunlar
| Belirti | Sebep / Çözüm |
|---|---|
| Build "wrangler.jsonc bulunamadı" | Dosyalar alt klasörde. Köke taşı (ya da Build → Root directory ayarla). |
| Deploy'da isim uyuşmazlığı | `wrangler.jsonc` → `"name"` ile Cloudflare'deki Worker adı aynı olmalı. |
| Giriş ekranında “KURULUM_KODU Secret'ı tanımlı değil” | Secret eklenmemiş ya da Variable (Text) olarak eklenmiş ve silinmiş. Secret olarak ekle. |
| “D1 database not found” | `database_id` hâlâ sıfır ya da yanlış. |
| Doğru şifre kabul edilmiyor (429) | 15 dakikalık kilit aktif. Mesajdaki saati bekle. |
| “GitHub bağlantısı kurulmamış” | `GITHUB_TOKEN` Secret'ı yok. 7. adım. |
| “token'ı geçersiz” / “yazılamadı” | Token süresi dolmuş, `algoritmalar` seçilmemiş ya da Contents izni Read-only. |
| PC'de ana proje “CS9298 '#:' directives” hatası | `.csproj`'a `<Compile Remove="solutions/**" />` ekle. |

## Dosyalar
```
wrangler.jsonc       Worker + D1 + statik dosya ayarları
package.json         sadece devDependency: wrangler
worker/index.js      oturum, API, statik dosya koruması, şema
public/index.html    antrenman sayfası (içerik)
public/app.js        ilerleme, notlar, zincir, yedek, menü
public/app.css       uygulama eklemelerinin stili
public/giris.html    giriş + ilk kurulum
public/manifest.webmanifest, public/icon-*.png
```

## Veri modeli (D1)
- `ilerleme(soru_id, cozuldu, cozulme_tarihi, zorlandim, guncelleme)`; `soru_id` = `k0-1` … `k12-10`
- `not_(soru_id, yaklasim, big_o, kod, takildigim, guncelleme, cozum, cozum_yol, cozum_commit, cozum_tarih)` (çözüm kolonları sonradan `ALTER TABLE` ile kendiliğinden eklenir)
- `gun(tarih, soru_id, tur)`; tur = `yeni` | `tekrar`. Çalışılan her gün için bir satır.
- `kullanici`, `oturum`, `deneme`

**Gün sayısı** = çalışılan (soru çözülen ya da tekrar yapılan) farklı gün sayısı. **Zincir** bugün ya da dün çalışıldıysa sürer. Tarihler Türkiye saatine (UTC+3) göre. Gün numarası 7'nin katıysa **tekrar günü**dür: “Zorlandım” işaretli sorulardan en uzun süredir tekrar edilmeyeni önerilir.
