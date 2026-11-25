// Günlük Algoritma Antrenmanı — Cloudflare Worker
// Oturum, API ve statik dosya koruması. Bağımlılık yok.

const OTURUM_CEREZ = 'oturum';
const OTURUM_SURE = 30 * 24 * 60 * 60 * 1000;        // 30 gün
const PBKDF2_TUR = 20000;                             // ücretsiz plan CPU sınırı için
const KILIT_PENCERE = 15 * 60 * 1000;                 // 15 dk
const EPOSTA_SINIR = 8;
const IP_SINIR = 30;
const ALAN_SINIR = 20000;                             // not alanı başına karakter
const SORU_ID = /^k(?:[0-9]|1[0-2])-(?:[1-9]|1[0-2])$/;

// Oturumsuz da sunulan dosyalar
const ACIK_DOSYALAR = new Set([
  '/giris.html',
  '/manifest.webmanifest',
  '/icon-180.png',
  '/icon-192.png',
  '/icon-512.png',
]);

// ---------- Şema ----------

const SEMA = [
  `CREATE TABLE IF NOT EXISTS kullanici (
     id INTEGER PRIMARY KEY,
     eposta TEXT NOT NULL UNIQUE,
     sifre TEXT NOT NULL,
     olusturma INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS oturum (
     token_hash TEXT PRIMARY KEY,
     kullanici_id INTEGER NOT NULL,
     olusturma INTEGER NOT NULL,
     bitis INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS deneme (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     anahtar TEXT NOT NULL,
     zaman INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS deneme_anahtar ON deneme (anahtar, zaman)`,
  `CREATE TABLE IF NOT EXISTS ilerleme (
     soru_id TEXT PRIMARY KEY,
     cozuldu INTEGER NOT NULL DEFAULT 0,
     cozulme_tarihi TEXT,
     zorlandim INTEGER NOT NULL DEFAULT 0,
     guncelleme INTEGER)`,
  `CREATE TABLE IF NOT EXISTS not_ (
     soru_id TEXT PRIMARY KEY,
     yaklasim TEXT, big_o TEXT, kod TEXT, takildigim TEXT,
     guncelleme INTEGER)`,
  `CREATE TABLE IF NOT EXISTS gun (
     tarih TEXT PRIMARY KEY,
     soru_id TEXT,
     tur TEXT)`,
];

// Sonradan eklenecek kolonlar: ['tablo', 'kolon tanımı']
const EK_KOLONLAR = [
  ['not_', 'cozum TEXT'],            // web editöründeki çözüm taslağı
  ['not_', 'cozum_yol TEXT'],        // GitHub'daki dosya yolu
  ['not_', 'cozum_commit TEXT'],     // son commit sha'sı
  ['not_', 'cozum_tarih INTEGER'],   // son commit zamanı
];

let semaHazir = null;
function semaKur(db) {
  if (!semaHazir) {
    semaHazir = (async () => {
      await db.batch(SEMA.map((s) => db.prepare(s)));
      for (const [tablo, kolon] of EK_KOLONLAR) {
        try {
          await db.prepare(`ALTER TABLE ${tablo} ADD COLUMN ${kolon}`).run();
        } catch (e) {
          if (!/duplicate column/i.test(String(e && e.message))) throw e;
        }
      }
    })().catch((e) => { semaHazir = null; throw e; });
  }
  return semaHazir;
}

// ---------- Yardımcılar ----------

const enc = new TextEncoder();

function b64(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}
function b64Coz(str) {
  const s = atob(str);
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}
function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function sha256(metin) {
  return crypto.subtle.digest('SHA-256', enc.encode(metin));
}
function rastgele(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

// Uzunluktan bağımsız sabit süreli karşılaştırma (önce ikisinin de özeti alınır)
async function esitMi(a, b) {
  const [x, y] = await Promise.all([sha256(String(a)), sha256(String(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let fark = 0;
  for (let i = 0; i < u.length; i++) fark |= u[i] ^ v[i];
  return fark === 0;
}

async function pbkdf2(sifre, tuz, tur) {
  const anahtar = await crypto.subtle.importKey('raw', enc.encode(sifre), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: tuz, iterations: tur }, anahtar, 256);
}
async function sifreHashle(sifre) {
  const tuz = rastgele(16);
  const h = await pbkdf2(sifre, tuz, PBKDF2_TUR);
  return `pbkdf2$${PBKDF2_TUR}$${b64(tuz)}$${b64(h)}`;
}
// Kullanıcı yoksa da aynı işi yapmak için sahte kayıt (zamanlama farkını azaltır)
const SAHTE_HASH = `pbkdf2$${PBKDF2_TUR}$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`;
async function sifreDogrula(sifre, kayit) {
  const p = String(kayit || '').split('$');
  if (p.length !== 4 || p[0] !== 'pbkdf2') return false;
  const tur = parseInt(p[1], 10);
  if (!(tur > 0 && tur <= 1000000)) return false;
  const h = await pbkdf2(sifre, b64Coz(p[2]), tur);
  const beklenen = b64Coz(p[3]);
  const gelen = new Uint8Array(h);
  if (beklenen.length !== gelen.length) return false;
  let fark = 0;
  for (let i = 0; i < gelen.length; i++) fark |= gelen[i] ^ beklenen[i];
  return fark === 0;
}

function epostaNormal(e) {
  // tr-TR kullanılmaz: 'I' → 'ı' dönüşümü e-postayı bozar.
  return String(e || '').trim().toLowerCase();
}
function epostaGecerli(e) {
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}
function sifreKuraliHatasi(s) {
  if (typeof s !== 'string' || s.length < 8) return 'Şifre en az 8 karakter olmalı.';
  if (s.length > 200) return 'Şifre en fazla 200 karakter olabilir.';
  if (!/\p{L}/u.test(s) || !/\d/.test(s)) return 'Şifre en az bir harf ve bir rakam içermeli.';
  return null;
}

// Türkiye saati (UTC+3, yaz saati uygulaması yok)
function bugunTR(simdi = Date.now()) {
  return new Date(simdi + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function saatTR(ms) {
  return new Date(ms + 3 * 60 * 60 * 1000).toISOString().slice(11, 16);
}

function cerezOku(req, ad) {
  const c = req.headers.get('Cookie') || '';
  for (const parca of c.split(';')) {
    const i = parca.indexOf('=');
    if (i > -1 && parca.slice(0, i).trim() === ad) return parca.slice(i + 1).trim();
  }
  return null;
}
function cerezYaz(token, maxAgeSn) {
  return `${OTURUM_CEREZ}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSn}`;
}

function guvenlikBasliklari(res, ek = {}) {
  const r = new Response(res.body, res);
  const h = r.headers;
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Referrer-Policy', 'same-origin');
  h.set('X-Robots-Tag', 'noindex, nofollow');
  for (const [k, v] of Object.entries(ek)) h.set(k, v);
  return r;
}

function json(veri, durum = 200, basliklar = {}) {
  return new Response(JSON.stringify(veri), {
    status: durum,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...basliklar },
  });
}
const hata = (mesaj, durum, ek) => json({ hata: mesaj, ...(ek || {}) }, durum);

function yonlendir(yer) {
  return new Response(null, { status: 302, headers: { Location: yer, 'Cache-Control': 'no-store' } });
}

async function govdeOku(req, sinir = 2_000_000) {
  const metin = await req.text();
  if (metin.length > sinir) throw new IstekHatasi('İstek çok büyük.', 413);
  if (!metin) return {};
  try { return JSON.parse(metin); } catch { throw new IstekHatasi('Geçersiz JSON.', 400); }
}
class IstekHatasi extends Error {
  constructor(m, d) { super(m); this.durum = d; }
}

// ---------- Oturum ----------

async function oturumBul(env, req) {
  const token = cerezOku(req, OTURUM_CEREZ);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const th = hex(await sha256(token));
  const simdi = Date.now();
  const o = await env.DB.prepare(
    'SELECT o.token_hash, o.bitis, k.id, k.eposta FROM oturum o JOIN kullanici k ON k.id = o.kullanici_id WHERE o.token_hash = ? AND o.bitis > ?'
  ).bind(th, simdi).first();
  if (!o) return null;
  let yeniCerez = null;
  // Sürenin yarısı geçtiyse uzat
  if (o.bitis - simdi < OTURUM_SURE / 2) {
    await env.DB.prepare('UPDATE oturum SET bitis = ? WHERE token_hash = ?').bind(simdi + OTURUM_SURE, th).run();
    yeniCerez = cerezYaz(token, OTURUM_SURE / 1000);
  }
  return { tokenHash: th, kullaniciId: o.id, eposta: o.eposta, yeniCerez };
}

async function oturumAc(env, kullaniciId) {
  const token = b64(rastgele(32)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const th = hex(await sha256(token));
  const simdi = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oturum WHERE bitis < ?').bind(simdi),
    env.DB.prepare('INSERT INTO oturum (token_hash, kullanici_id, olusturma, bitis) VALUES (?, ?, ?, ?)')
      .bind(th, kullaniciId, simdi, simdi + OTURUM_SURE),
  ]);
  return cerezYaz(token, OTURUM_SURE / 1000);
}

// ---------- Kaba kuvvet koruması ----------

// Kilitliyse açılacağı zamanı (ms) döner, değilse null
async function kilitKontrol(env, anahtar, sinir) {
  const r = await env.DB.prepare(
    'SELECT zaman FROM deneme WHERE anahtar = ? AND zaman > ? ORDER BY zaman DESC LIMIT 1 OFFSET ?'
  ).bind(anahtar, Date.now() - KILIT_PENCERE, sinir - 1).first();
  return r ? r.zaman + KILIT_PENCERE : null;
}
function kilitYaniti(acilis, kapsam) {
  const dk = Math.max(1, Math.ceil((acilis - Date.now()) / 60000));
  return hata(
    `Çok fazla hatalı deneme: ${kapsam} 15 dakikalığına kilitlendi. Kilit yaklaşık ${dk} dakika sonra (${saatTR(acilis)}) açılacak. ` +
      'Kilitliyken doğru şifre de kabul edilmez; lütfen bekleyip tekrar deneyin.',
    429,
    { kilitAcilis: acilis }
  );
}
async function denemeKaydet(env, anahtarlar) {
  const simdi = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM deneme WHERE zaman < ?').bind(simdi - 24 * 60 * 60 * 1000),
    ...anahtarlar.map((a) => env.DB.prepare('INSERT INTO deneme (anahtar, zaman) VALUES (?, ?)').bind(a, simdi)),
  ]);
}

// ---------- Oturum uç noktaları (oturumsuz erişilebilir) ----------

async function kullaniciVarMi(env) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM kullanici').first();
  return r.n > 0;
}

async function durum(env, req) {
  const o = await oturumBul(env, req);
  return json({ kurulum: !(await kullaniciVarMi(env)), girisli: !!o });
}

async function kurulum(env, req, ip) {
  if (await kullaniciVarMi(env)) return hata('Kurulum tamamlanmış. Bu uç nokta kapalı.', 409);
  if (!env.KURULUM_KODU) {
    return hata("KURULUM_KODU Secret'ı tanımlı değil. Cloudflare → Worker → Settings → Variables and Secrets bölümünden ekleyin.", 503);
  }
  const ipAnahtar = 'ip:' + ip;
  const ipKilit = await kilitKontrol(env, ipAnahtar, IP_SINIR);
  if (ipKilit) return kilitYaniti(ipKilit, 'bu IP adresi');

  const g = await govdeOku(req, 10_000);
  if (!(await esitMi(g.kod || '', env.KURULUM_KODU))) {
    await denemeKaydet(env, [ipAnahtar]);
    return hata('Kurulum kodu yanlış.', 403);
  }
  const eposta = epostaNormal(g.eposta);
  if (!epostaGecerli(eposta)) return hata('Geçerli bir e-posta girin.', 400);
  const kural = sifreKuraliHatasi(g.sifre);
  if (kural) return hata(kural, 400);

  const hash = await sifreHashle(g.sifre);
  const r = await env.DB.prepare(
    'INSERT INTO kullanici (eposta, sifre, olusturma) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM kullanici)'
  ).bind(eposta, hash, Date.now()).run();
  if (!r.meta.changes) return hata('Kurulum tamamlanmış. Bu uç nokta kapalı.', 409);
  const k = await env.DB.prepare('SELECT id FROM kullanici WHERE eposta = ?').bind(eposta).first();
  const cerez = await oturumAc(env, k.id);
  return json({ tamam: true }, 200, { 'Set-Cookie': cerez });
}

async function giris(env, req, ip) {
  const g = await govdeOku(req, 10_000);
  const eposta = epostaNormal(g.eposta);
  const sifre = typeof g.sifre === 'string' ? g.sifre : '';
  if (!eposta || !sifre) return hata('E-posta ve şifre gerekli.', 400);

  // Kilit kontrolü şifre kontrolünden ÖNCE
  const eAnahtar = 'e:' + eposta, ipAnahtar = 'ip:' + ip;
  const eKilit = await kilitKontrol(env, eAnahtar, EPOSTA_SINIR);
  if (eKilit) return kilitYaniti(eKilit, 'bu hesap');
  const ipKilit = await kilitKontrol(env, ipAnahtar, IP_SINIR);
  if (ipKilit) return kilitYaniti(ipKilit, 'bu IP adresi');

  const k = await env.DB.prepare('SELECT id, sifre FROM kullanici WHERE eposta = ?').bind(eposta).first();
  const dogru = await sifreDogrula(sifre, k ? k.sifre : SAHTE_HASH);
  if (!k || !dogru) {
    await denemeKaydet(env, [eAnahtar, ipAnahtar]);
    const kalan = await env.DB.prepare('SELECT COUNT(*) AS n FROM deneme WHERE anahtar = ? AND zaman > ?')
      .bind(eAnahtar, Date.now() - KILIT_PENCERE).first();
    const hak = Math.max(0, EPOSTA_SINIR - kalan.n);
    return hata(
      hak > 0 ? `E-posta ya da şifre yanlış. Kilitlenmeden önce ${hak} deneme hakkın kaldı.`
              : 'E-posta ya da şifre yanlış. Bu hesap 15 dakikalığına kilitlendi; bu sürede doğru şifre de kabul edilmez.',
      hak > 0 ? 401 : 429
    );
  }
  await env.DB.prepare('DELETE FROM deneme WHERE anahtar = ?').bind(eAnahtar).run();
  const cerez = await oturumAc(env, k.id);
  return json({ tamam: true }, 200, { 'Set-Cookie': cerez });
}

// ---------- Uygulama API'si (oturum gerekli) ----------

async function cikis(env, o) {
  // Bu oturum dahil tüm oturumlar kapanır
  await env.DB.prepare('DELETE FROM oturum WHERE kullanici_id = ?').bind(o.kullaniciId).run();
  return json({ tamam: true }, 200, { 'Set-Cookie': cerezYaz('', 0) });
}

async function sifreDegistir(env, req, o, ip) {
  const g = await govdeOku(req, 10_000);
  const eAnahtar = 'e:' + o.eposta;
  const kilit = await kilitKontrol(env, eAnahtar, EPOSTA_SINIR);
  if (kilit) return kilitYaniti(kilit, 'bu hesap');
  const k = await env.DB.prepare('SELECT sifre FROM kullanici WHERE id = ?').bind(o.kullaniciId).first();
  if (!(await sifreDogrula(String(g.mevcut || ''), k.sifre))) {
    await denemeKaydet(env, [eAnahtar, 'ip:' + ip]);
    return hata('Mevcut şifre yanlış.', 403);
  }
  const kural = sifreKuraliHatasi(g.yeni);
  if (kural) return hata(kural, 400);
  const hash = await sifreHashle(g.yeni);
  // Diğer tüm oturumlar silinir, bu cihaz için yeni oturum açılır
  await env.DB.batch([
    env.DB.prepare('UPDATE kullanici SET sifre = ? WHERE id = ?').bind(hash, o.kullaniciId),
    env.DB.prepare('DELETE FROM oturum WHERE kullanici_id = ?').bind(o.kullaniciId),
  ]);
  const cerez = await oturumAc(env, o.kullaniciId);
  return json({ tamam: true }, 200, { 'Set-Cookie': cerez });
}

async function tumVeri(env) {
  const [il, no, gu] = await env.DB.batch([
    env.DB.prepare('SELECT soru_id, cozuldu, cozulme_tarihi, zorlandim, guncelleme FROM ilerleme'),
    env.DB.prepare('SELECT soru_id, yaklasim, big_o, kod, takildigim, guncelleme, cozum, cozum_yol, cozum_commit, cozum_tarih FROM not_'),
    env.DB.prepare('SELECT tarih, soru_id, tur FROM gun ORDER BY tarih'),
  ]);
  return { ilerleme: il.results, notlar: no.results, gunler: gu.results };
}

async function veri(env, o) {
  return json({ eposta: o.eposta, bugun: bugunTR(), ...(await tumVeri(env)) });
}

// Soruyu bugün çözülmüş olarak işaretleyen ifadeler (zaten çözülmüşse boş)
async function cozulduIfadeleri(db, soruId, simdi) {
  const bugun = bugunTR(simdi);
  const m = await db.prepare('SELECT cozuldu FROM ilerleme WHERE soru_id = ?').bind(soruId).first();
  if (m && m.cozuldu) return [];
  return [
    db.prepare(`INSERT INTO ilerleme (soru_id, cozuldu, cozulme_tarihi, zorlandim, guncelleme) VALUES (?1, 1, ?2, 0, ?3)
       ON CONFLICT(soru_id) DO UPDATE SET cozuldu = 1, cozulme_tarihi = ?2, guncelleme = ?3`).bind(soruId, bugun, simdi),
    db.prepare("INSERT OR IGNORE INTO gun (tarih, soru_id, tur) VALUES (?, ?, 'yeni')").bind(bugun, soruId),
  ];
}

async function ilerlemeGuncelle(env, req, soruId) {
  const g = await govdeOku(req, 10_000);
  const simdi = Date.now();
  const bugun = bugunTR(simdi);
  const db = env.DB;
  const mevcut = (await db.prepare('SELECT * FROM ilerleme WHERE soru_id = ?').bind(soruId).first()) ||
    { cozuldu: 0, cozulme_tarihi: null, zorlandim: 0 };

  let cozuldu = mevcut.cozuldu, tarih = mevcut.cozulme_tarihi, zorlandim = mevcut.zorlandim;
  const islemler = [];

  if (typeof g.zorlandim === 'boolean') zorlandim = g.zorlandim ? 1 : 0;

  if (typeof g.cozuldu === 'boolean') {
    if (g.cozuldu && !mevcut.cozuldu) {
      cozuldu = 1;
      tarih = bugun;
      islemler.push(db.prepare("INSERT OR IGNORE INTO gun (tarih, soru_id, tur) VALUES (?, ?, 'yeni')").bind(bugun, soruId));
    } else if (!g.cozuldu && mevcut.cozuldu) {
      cozuldu = 0;
      tarih = null;
      // Bugünün kaydı bu soruya aitse: bugün çözülen başka soru varsa ona aktar, yoksa sil
      islemler.push(db.prepare(
        `UPDATE gun SET soru_id = (SELECT soru_id FROM ilerleme WHERE cozulme_tarihi = ?1 AND cozuldu = 1 AND soru_id <> ?2 LIMIT 1)
         WHERE tarih = ?1 AND soru_id = ?2 AND tur = 'yeni'`
      ).bind(bugun, soruId));
      islemler.push(db.prepare("DELETE FROM gun WHERE tarih = ? AND soru_id IS NULL AND tur = 'yeni'").bind(bugun));
    }
  }

  await db.batch([
    db.prepare(
      `INSERT INTO ilerleme (soru_id, cozuldu, cozulme_tarihi, zorlandim, guncelleme) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(soru_id) DO UPDATE SET cozuldu = ?2, cozulme_tarihi = ?3, zorlandim = ?4, guncelleme = ?5`
    ).bind(soruId, cozuldu, tarih, zorlandim, simdi),
    ...islemler,
  ]);
  return json({ bugun, ...(await tumVeri(env)) });
}

async function tekrarYapildi(env, req) {
  const g = await govdeOku(req, 10_000);
  if (!SORU_ID.test(String(g.soru_id || ''))) return hata('Geçersiz soru.', 400);
  const bugun = bugunTR();
  await env.DB.prepare("INSERT OR IGNORE INTO gun (tarih, soru_id, tur) VALUES (?, ?, 'tekrar')").bind(bugun, g.soru_id).run();
  return json({ bugun, ...(await tumVeri(env)) });
}

function metinAlani(v) {
  if (v == null) return '';
  const s = String(v);
  if (s.length > ALAN_SINIR) throw new IstekHatasi(`Not alanı en fazla ${ALAN_SINIR} karakter olabilir.`, 413);
  return s;
}

async function notKaydet(env, req, soruId) {
  const g = await govdeOku(req, 200_000);
  const alanlar = [metinAlani(g.yaklasim), metinAlani(g.big_o), metinAlani(g.kod), metinAlani(g.takildigim)];
  const simdi = Date.now();
  await env.DB.prepare(
    `INSERT INTO not_ (soru_id, yaklasim, big_o, kod, takildigim, guncelleme) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(soru_id) DO UPDATE SET yaklasim = ?2, big_o = ?3, kod = ?4, takildigim = ?5, guncelleme = ?6`
  ).bind(soruId, ...alanlar, simdi).run();
  return json({ tamam: true, guncelleme: simdi });
}

async function aktar(env, req) {
  const g = await govdeOku(req, 50_000);
  const ids = Array.isArray(g.ids) ? [...new Set(g.ids.filter((x) => SORU_ID.test(String(x))))] : [];
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM ilerleme').first();
  if (n.n > 0) return hata('Sunucuda zaten ilerleme kaydı var; aktarma yapılmadı.', 409);
  if (!ids.length) return hata('Aktarılacak soru yok.', 400);
  const simdi = Date.now();
  await env.DB.batch(ids.map((id) =>
    env.DB.prepare('INSERT INTO ilerleme (soru_id, cozuldu, cozulme_tarihi, zorlandim, guncelleme) VALUES (?, 1, NULL, 0, ?)').bind(id, simdi)
  ));
  return json({ aktarilan: ids.length, bugun: bugunTR(), ...(await tumVeri(env)) });
}

async function yedekAl(env) {
  const v = await tumVeri(env);
  return json({ uygulama: 'algoritma-antrenmani', surum: 1, tarih: new Date().toISOString(), ...v }, 200, {
    'Content-Disposition': `attachment; filename="algoritma-yedek-${bugunTR()}.json"`,
  });
}

async function yedekYukle(env, req) {
  const g = await govdeOku(req, 5_000_000);
  if (g.uygulama !== 'algoritma-antrenmani' || !Array.isArray(g.ilerleme) || !Array.isArray(g.notlar) || !Array.isArray(g.gunler)) {
    return hata('Bu dosya bu uygulamanın yedeği değil.', 400);
  }
  const db = env.DB;
  const tarihOk = (t) => typeof t === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t);
  const sayi = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
  const islemler = [db.prepare('DELETE FROM ilerleme'), db.prepare('DELETE FROM not_'), db.prepare('DELETE FROM gun')];
  for (const r of g.ilerleme) {
    if (!r || !SORU_ID.test(String(r.soru_id))) continue;
    islemler.push(db.prepare('INSERT OR REPLACE INTO ilerleme (soru_id, cozuldu, cozulme_tarihi, zorlandim, guncelleme) VALUES (?, ?, ?, ?, ?)')
      .bind(r.soru_id, r.cozuldu ? 1 : 0, tarihOk(r.cozulme_tarihi) ? r.cozulme_tarihi : null, r.zorlandim ? 1 : 0, sayi(r.guncelleme)));
  }
  for (const r of g.notlar) {
    if (!r || !SORU_ID.test(String(r.soru_id))) continue;
    const yol = typeof r.cozum_yol === 'string' && COZUM_YOL.test(r.cozum_yol) ? r.cozum_yol : null;
    const commit = typeof r.cozum_commit === 'string' && /^[0-9a-f]{40}$/.test(r.cozum_commit) ? r.cozum_commit : null;
    islemler.push(db.prepare('INSERT OR REPLACE INTO not_ (soru_id, yaklasim, big_o, kod, takildigim, guncelleme, cozum, cozum_yol, cozum_commit, cozum_tarih) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(r.soru_id, metinAlani(r.yaklasim), metinAlani(r.big_o), metinAlani(r.kod), metinAlani(r.takildigim), sayi(r.guncelleme),
        cozumAlani(r.cozum), yol, commit, sayi(r.cozum_tarih)));
  }
  for (const r of g.gunler) {
    if (!r || !tarihOk(r.tarih)) continue;
    const tur = r.tur === 'tekrar' ? 'tekrar' : 'yeni';
    const sid = SORU_ID.test(String(r.soru_id)) ? r.soru_id : null;
    islemler.push(db.prepare('INSERT OR REPLACE INTO gun (tarih, soru_id, tur) VALUES (?, ?, ?)').bind(r.tarih, sid, tur));
  }
  await db.batch(islemler); // tek işlem: hata olursa hiçbir şey değişmez
  return json({ tamam: true, bugun: bugunTR(), ...(await tumVeri(env)) });
}

// ---------- Çözümler ve GitHub ----------

const COZUM_SINIR = 100000;
const COZUM_YOL = /^solutions\/kademe-(0\d|1[0-2])\/(\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.cs$/;

function cozumAlani(v) {
  if (v == null) return null;
  const s = String(v);
  if (s.length > COZUM_SINIR) throw new IstekHatasi(`Çözüm en fazla ${COZUM_SINIR} karakter olabilir.`, 413);
  return s;
}

function githubDurum(env) {
  const repo = String(env.GITHUB_REPO || '');
  return { hazir: !!(env.GITHUB_TOKEN && /^[\w.-]+\/[\w.-]+$/.test(repo)), repo, dal: env.GITHUB_DAL || null };
}

async function gh(env, yontem, yol, govde) {
  const taban = env.GITHUB_API || 'https://api.github.com';
  const r = await fetch(taban + yol, {
    method: yontem,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'algoritma-antrenmani-worker',
      ...(govde ? { 'Content-Type': 'application/json' } : {}),
    },
    body: govde ? JSON.stringify(govde) : undefined,
  });
  let j = null;
  try { j = await r.json(); } catch { j = null; }
  return { durum: r.status, j };
}

function ghHata(durum, j) {
  const m = j && j.message ? ` (${j.message})` : '';
  if (durum === 401) return hata("GitHub token'ı geçersiz ya da süresi dolmuş. GITHUB_TOKEN Secret'ını yenile." + m, 502);
  if (durum === 403 || durum === 404) return hata("GitHub repoya yazılamadı: token'ın bu repoda 'Contents: Read and write' izni yok ya da GITHUB_REPO yanlış." + m, 502);
  if (durum === 409) return hata('GitHub dosyası bu sırada değişti. Önce "GitHub\'dan çek" ile güncel hâlini al.' + m, 409);
  if (durum === 422) return hata('GitHub isteği reddetti' + m, 502);
  return hata(`GitHub hatası: ${durum}` + m, 502);
}

function yolKontrol(soruId, yol) {
  const m = COZUM_YOL.exec(String(yol || ''));
  const s = /^k(\d+)-(\d+)$/.exec(soruId);
  return !!(m && +m[1] === +s[1] && +m[2] === +s[2]);
}
const dosyaYolu = (yol) => yol.split('/').map(encodeURIComponent).join('/');
const refParam = (env) => (env.GITHUB_DAL ? `?ref=${encodeURIComponent(env.GITHUB_DAL)}` : '');

async function cozumTaslak(env, req, soruId) {
  const g = await govdeOku(req, 300_000);
  const kod = cozumAlani(g.cozum) || '';
  const simdi = Date.now();
  await env.DB.prepare(
    `INSERT INTO not_ (soru_id, cozum, guncelleme) VALUES (?1, ?2, ?3)
     ON CONFLICT(soru_id) DO UPDATE SET cozum = ?2, guncelleme = ?3`
  ).bind(soruId, kod, simdi).run();
  return json({ tamam: true, guncelleme: simdi });
}

async function cozumCommit(env, req, soruId) {
  const d = githubDurum(env);
  if (!d.hazir) return hata('GitHub bağlantısı kurulmamış: GITHUB_TOKEN Secret\'ı ve GITHUB_REPO ayarı gerekli (README → GitHub çözümleri).', 503);
  const g = await govdeOku(req, 300_000);
  const kod = cozumAlani(g.cozum) || '';
  if (!kod.trim()) return hata('Boş çözüm gönderilemez.', 400);
  if (!yolKontrol(soruId, g.yol)) return hata('Geçersiz dosya yolu.', 400);
  const baslik = String(g.baslik || soruId).replace(/[\r\n]+/g, ' ').slice(0, 120);

  const yolUrl = `/repos/${d.repo}/contents/${dosyaYolu(g.yol)}`;
  const mevcut = await gh(env, 'GET', yolUrl + refParam(env));
  if (mevcut.durum !== 200 && mevcut.durum !== 404) return ghHata(mevcut.durum, mevcut.j);
  const sha = mevcut.durum === 200 && mevcut.j && mevcut.j.sha ? mevcut.j.sha : undefined;

  const icerik = kod.endsWith('\n') ? kod : kod + '\n';
  if (sha && typeof mevcut.j.content === 'string') {
    const eski = new TextDecoder().decode(b64Coz(mevcut.j.content.replace(/\s/g, '')));
    if (eski === icerik) return hata('GitHub\'daki dosya zaten bu hâliyle aynı; commit atılmadı.', 409, { ayni: true });
  }

  const sonuc = await gh(env, 'PUT', yolUrl, {
    message: `${sha ? 'Çözüm güncellendi' : 'Çözüm eklendi'}: ${baslik}`,
    content: b64(enc.encode(icerik)),
    ...(sha ? { sha } : {}),
    ...(env.GITHUB_DAL ? { branch: env.GITHUB_DAL } : {}),
  });
  if (sonuc.durum !== 200 && sonuc.durum !== 201) return ghHata(sonuc.durum, sonuc.j);

  const commit = sonuc.j && sonuc.j.commit ? sonuc.j.commit.sha : null;
  const adres = sonuc.j && sonuc.j.content ? sonuc.j.content.html_url : null;
  const simdi = Date.now();
  const db = env.DB;
  await db.batch([
    db.prepare(
      `INSERT INTO not_ (soru_id, cozum, cozum_yol, cozum_commit, cozum_tarih, guncelleme) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT(soru_id) DO UPDATE SET cozum = ?2, cozum_yol = ?3, cozum_commit = ?4, cozum_tarih = ?5, guncelleme = ?5`
    ).bind(soruId, kod, g.yol, commit, simdi),
    ...(await cozulduIfadeleri(db, soruId, simdi)),
  ]);
  return json({ tamam: true, yeni: !sha, commit, adres, bugun: bugunTR(), ...(await tumVeri(env)) });
}

async function cozumCek(env, url, soruId) {
  const d = githubDurum(env);
  if (!d.hazir) return hata('GitHub bağlantısı kurulmamış.', 503);
  const yol = url.searchParams.get('yol');
  if (!yolKontrol(soruId, yol)) return hata('Geçersiz dosya yolu.', 400);
  const r = await gh(env, 'GET', `/repos/${d.repo}/contents/${dosyaYolu(yol)}` + refParam(env));
  if (r.durum === 404) return hata('Bu soru için GitHub\'da henüz dosya yok.', 404);
  if (r.durum !== 200) return ghHata(r.durum, r.j);
  const kod = new TextDecoder().decode(b64Coz(String(r.j.content || '').replace(/\s/g, '')));
  return json({ cozum: kod, adres: r.j.html_url });
}

// ---------- Yönlendirici ----------

async function api(env, req, yol, ip, url) {
  const m = req.method;
  // CSRF: GET dışındaki her API isteğinde özel başlık zorunlu
  if (m !== 'GET' && m !== 'HEAD' && req.headers.get('X-Uygulama') !== '1') {
    return hata('Geçersiz istek (X-Uygulama başlığı eksik).', 403);
  }

  if (yol === '/api/oturum/durum' && m === 'GET') return durum(env, req);
  if (yol === '/api/oturum/kurulum' && m === 'POST') return kurulum(env, req, ip);
  if (yol === '/api/oturum/giris' && m === 'POST') return giris(env, req, ip);

  const o = await oturumBul(env, req);
  if (!o) return hata('Oturum gerekli.', 401);

  let yanit;
  const soru = yol.match(/^\/api\/(ilerleme|not|cozum)\/([^/]+?)(\/github)?$/);
  if (soru && !SORU_ID.test(soru[2])) yanit = hata('Geçersiz soru.', 400);
  else if (yol === '/api/oturum/cikis' && m === 'POST') return cikis(env, o);
  else if (yol === '/api/oturum/sifre' && m === 'POST') return sifreDegistir(env, req, o, ip);
  else if (yol === '/api/veri' && m === 'GET') yanit = await veri(env, o);
  else if (soru && soru[3] && soru[1] !== 'cozum') yanit = hata('Bulunamadı.', 404);
  else if (soru && soru[1] === 'ilerleme' && m === 'PUT') yanit = await ilerlemeGuncelle(env, req, soru[2]);
  else if (soru && soru[1] === 'not' && m === 'PUT') yanit = await notKaydet(env, req, soru[2]);
  else if (yol === '/api/tekrar' && m === 'POST') yanit = await tekrarYapildi(env, req);
  else if (yol === '/api/aktar' && m === 'POST') yanit = await aktar(env, req);
  else if (yol === '/api/yedek' && m === 'GET') yanit = await yedekAl(env);
  else if (yol === '/api/yedek' && m === 'POST') yanit = await yedekYukle(env, req);
  else if (yol === '/api/github' && m === 'GET') yanit = json(githubDurum(env));
  else if (soru && soru[1] === 'cozum' && !soru[3] && m === 'PUT') yanit = await cozumTaslak(env, req, soru[2]);
  else if (soru && soru[1] === 'cozum' && soru[3] && m === 'POST') yanit = await cozumCommit(env, req, soru[2]);
  else if (soru && soru[1] === 'cozum' && soru[3] && m === 'GET') yanit = await cozumCek(env, url, soru[2]);
  else yanit = hata('Bulunamadı.', 404);

  if (o.yeniCerez) yanit.headers.append('Set-Cookie', o.yeniCerez);
  return yanit;
}

async function isle(req, env) {
  const url = new URL(req.url);
  const yol = url.pathname;
  const ip = req.headers.get('CF-Connecting-IP') || 'yerel';

  await semaKur(env.DB);

  if (yol.startsWith('/api/')) {
    try {
      return guvenlikBasliklari(await api(env, req, yol, ip, url), { 'Cache-Control': 'no-store' });
    } catch (e) {
      if (e instanceof IstekHatasi) return guvenlikBasliklari(hata(e.message, e.durum));
      console.error(e);
      return guvenlikBasliklari(hata('Sunucu hatası.', 500));
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return guvenlikBasliklari(new Response('İzin verilmeyen yöntem', { status: 405 }));
  }

  const o = await oturumBul(env, req);

  if (!o) {
    if (ACIK_DOSYALAR.has(yol)) return guvenlikBasliklari(await env.ASSETS.fetch(req));
    return guvenlikBasliklari(yonlendir('/giris.html'));
  }

  if (yol === '/giris.html') return guvenlikBasliklari(yonlendir('/'));

  // Oturum var: statik dosya
  const hedef = new URL(req.url);
  if (yol === '/' || yol === '') hedef.pathname = '/index.html';
  let res = await env.ASSETS.fetch(new Request(hedef, req));
  if (res.status === 404) res = new Response('Bulunamadı', { status: 404 });
  const ek = { 'Cache-Control': 'private, no-cache' };
  const r = guvenlikBasliklari(res, ek);
  if (o.yeniCerez) r.headers.append('Set-Cookie', o.yeniCerez);
  return r;
}

export default {
  async fetch(req, env) {
    try {
      return await isle(req, env);
    } catch (e) {
      console.error(e);
      return guvenlikBasliklari(new Response('Sunucu hatası', { status: 500 }));
    }
  },
};
