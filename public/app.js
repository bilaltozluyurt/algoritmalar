// Günlük Algoritma Antrenmanı — istemci
(function () {
  'use strict';

  var ESKI_ANAHTAR = 'algoritma-antrenmani';
  var AKTARMA_SORULDU = 'algoritma-antrenmani-aktarma-soruldu';

  // ---------- Durum ----------
  var D = { ilerleme: {}, notlar: {}, gunler: [], bugun: bugunTR(), eposta: '' };
  var GH = { hazir: false, repo: '' };
  var sorular = [];          // { id, kademe, no, ad, kutu, li }
  var soruHarita = {};

  // ---------- Yardımcılar ----------
  function bugunTR() {
    return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  }
  function oncekiGun(t) {
    var d = new Date(t + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  function el(etiket, ozellik, cocuklar) {
    var e = document.createElement(etiket);
    if (ozellik) Object.keys(ozellik).forEach(function (k) {
      if (k === 'text') e.textContent = ozellik[k];
      else if (k === 'class') e.className = ozellik[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), ozellik[k]);
      else e.setAttribute(k, ozellik[k]);
    });
    (cocuklar || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }

  var bildirimEl, bildirimZaman;
  function bildir(mesaj, hataMi) {
    if (!bildirimEl) {
      bildirimEl = el('div', { class: 'bildirim', role: 'status', 'aria-live': 'polite' });
      bildirimEl.hidden = true;
      document.body.appendChild(bildirimEl);
    }
    bildirimEl.textContent = mesaj;
    bildirimEl.className = 'bildirim' + (hataMi ? ' hata' : '');
    bildirimEl.hidden = false;
    clearTimeout(bildirimZaman);
    bildirimZaman = setTimeout(function () { bildirimEl.hidden = true; }, hataMi ? 6000 : 2600);
  }

  function api(yontem, yol, govde, ek) {
    var ayar = { method: yontem, credentials: 'same-origin', headers: { 'X-Uygulama': '1' } };
    if (govde !== undefined) {
      ayar.headers['Content-Type'] = 'application/json';
      ayar.body = JSON.stringify(govde);
    }
    if (ek && ek.keepalive) ayar.keepalive = true;
    return fetch(yol, ayar).then(function (r) {
      if (r.status === 401) { location.href = '/giris.html'; throw new Error('Oturum kapandı.'); }
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.hata || ('İstek başarısız (' + r.status + ').'));
        return j;
      });
    });
  }

  function veriyiAl(j) {
    if (j.bugun) D.bugun = j.bugun;
    if (j.ilerleme) {
      D.ilerleme = {};
      j.ilerleme.forEach(function (r) { D.ilerleme[r.soru_id] = r; });
    }
    if (j.notlar) {
      D.notlar = {};
      j.notlar.forEach(function (r) { D.notlar[r.soru_id] = r; });
    }
    if (j.gunler) D.gunler = j.gunler;
    if (j.eposta) D.eposta = j.eposta;
  }

  // ---------- Hesaplar ----------
  function cozulduMu(id) { var r = D.ilerleme[id]; return !!(r && r.cozuldu); }
  function zorlandimMi(id) { var r = D.ilerleme[id]; return !!(r && r.zorlandim); }

  function gunBilgisi() {
    var tarihler = D.gunler.map(function (g) { return g.tarih; }).sort();
    var set = {};
    tarihler.forEach(function (t) { set[t] = true; });
    var bugun = D.bugun;
    var bugunYapildi = !!set[bugun];
    var sayi = tarihler.length;
    var gunNo = bugunYapildi ? sayi : sayi + 1;
    // Zincir: bugün ya da dün çalışıldıysa devam eder
    var zincir = 0;
    var t = bugunYapildi ? bugun : oncekiGun(bugun);
    while (set[t]) { zincir++; t = oncekiGun(t); }
    var bugunKayit = null;
    D.gunler.forEach(function (g) { if (g.tarih === bugun) bugunKayit = g; });
    return { tarihler: tarihler, gunNo: gunNo, zincir: zincir, bugunYapildi: bugunYapildi, bugunKayit: bugunKayit, tekrarGunu: gunNo % 7 === 0 };
  }

  function sonTekrar(id) {
    var son = '';
    D.gunler.forEach(function (g) { if (g.tur === 'tekrar' && g.soru_id === id && g.tarih > son) son = g.tarih; });
    return son;
  }

  function bugununOnerisi(b) {
    if (b.tekrarGunu) {
      var adaylar = sorular.filter(function (s) { return zorlandimMi(s.id); });
      if (!adaylar.length) adaylar = sorular.filter(function (s) { return cozulduMu(s.id); });
      if (adaylar.length) {
        adaylar.sort(function (a, c) { var x = sonTekrar(a.id), y = sonTekrar(c.id); return x < y ? -1 : x > y ? 1 : 0; });
        return { soru: adaylar[0], tur: 'tekrar', zorlandimYok: !sorular.some(function (s) { return zorlandimMi(s.id); }) };
      }
    }
    for (var i = 0; i < sorular.length; i++) if (!cozulduMu(sorular[i].id)) return { soru: sorular[i], tur: 'yeni' };
    return null;
  }

  // ---------- Sorular ----------
  function sorulariTopla() {
    var kutular = document.querySelectorAll('.yapilacak input[type="checkbox"]');
    Array.prototype.forEach.call(kutular, function (kutu) {
      var m = /^k(\d+)-(\d+)$/.exec(kutu.id);
      if (!m) return;
      var b = kutu.parentNode.querySelector('b');
      var s = {
        id: kutu.id, kademe: +m[1], no: +m[2],
        ad: (b ? b.textContent : kutu.id).replace(/^\d+\.\s*/, '').trim(),
        baslik: b ? b.textContent.trim() : kutu.id,
        kutu: kutu, li: kutu.closest('li')
      };
      var span = b ? b.parentNode.cloneNode(true) : null;
      if (span) {
        var ornek = span.querySelector('span');
        s.ornek = ornek ? ornek.textContent.trim() : '';
        if (ornek) ornek.remove();
        var bb = span.querySelector('b'); if (bb) bb.remove();
        s.aciklama = span.textContent.replace(/^\s*·\s*/, '').trim();
      }
      s.yol = cozumYolu(s);
      sorular.push(s);
      soruHarita[s.id] = s;
    });
  }

  function soruyaGit(id) {
    var s = soruHarita[id];
    if (!s) return;
    s.li.scrollIntoView({ behavior: 'smooth', block: 'center' });
    s.li.classList.remove('hedef');
    void s.li.offsetWidth;
    s.li.classList.add('hedef');
  }
  function soruLinki(s) {
    return el('a', { href: '#' + s.id, onclick: function (e) { e.preventDefault(); soruyaGit(s.id); } }, ['K' + s.kademe + ' · ' + s.baslik]);
  }

  // ---------- Çözüm (GitHub) ----------
  function slug(t) {
    var harita = { 'ı': 'i', 'İ': 'i', 'ş': 's', 'Ş': 's', 'ğ': 'g', 'Ğ': 'g', 'ü': 'u', 'Ü': 'u', 'ö': 'o', 'Ö': 'o', 'ç': 'c', 'Ç': 'c' };
    var x = String(t).replace(/[ıİşŞğĞüÜöÖçÇ]/g, function (c) { return harita[c]; })
      .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (x.length > 50) x = x.slice(0, 50).replace(/-[^-]*$/, '');
    return x || 'soru';
  }
  function iki(n) { return (n < 10 ? '0' : '') + n; }
  function cozumYolu(s) { return 'solutions/kademe-' + iki(s.kademe) + '/' + iki(s.no) + '-' + slug(s.ad) + '.cs'; }
  function cozumSablonu(s) {
    return [
      '#:property PublishAot=false',
      '// K' + s.kademe + ' · ' + s.baslik,
      s.aciklama ? '// ' + s.aciklama : null,
      s.ornek ? '// Örnek: ' + s.ornek : null,
      '//',
      '// Çalıştır (repo kökünden): dotnet run --file ' + s.yol,
      '',
      'Console.OutputEncoding = System.Text.Encoding.UTF8;',
      '',
      '// ---- Testler ----',
      '// Console.WriteLine(Coz(...));   // beklenen: ...',
      '',
      '',
      '// ---- Çözüm ----',
      '// static ... Coz(...)',
      '// {',
      '// }',
      ''
    ].filter(function (x) { return x !== null; }).join('\n');
  }
  function tarihSaat(ms) {
    return new Date(ms + 3 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  }

  var cozumZaman = {}, cozumBekleyen = {};
  function cozumDegisti(id) {
    var s = soruHarita[id];
    cozumBekleyen[id] = true;
    s.cozumDurum.className = 'not-durum';
    s.cozumDurum.textContent = 'Taslak yazılıyor…';
    clearTimeout(cozumZaman[id]);
    cozumZaman[id] = setTimeout(function () { cozumTaslakKaydet(id); }, 1000);
  }
  function cozumTaslakKaydet(id, keepalive, sessiz) {
    var s = soruHarita[id];
    if (!cozumBekleyen[id]) return Promise.resolve();
    cozumBekleyen[id] = false;
    clearTimeout(cozumZaman[id]);
    var kod = s.cozumAlan.value;
    return api('PUT', '/api/cozum/' + id, { cozum: kod }, { keepalive: keepalive }).then(function () {
      D.notlar[id] = Object.assign({ soru_id: id }, D.notlar[id] || {}, { cozum: kod });
      if (!cozumBekleyen[id] && !sessiz) { s.cozumDurum.className = 'not-durum'; s.cozumDurum.textContent = 'Taslak kaydedildi (henüz GitHub\'a gitmedi)'; }
    }).catch(function (e) {
      cozumBekleyen[id] = true;
      s.cozumDurum.className = 'not-durum hata';
      s.cozumDurum.textContent = 'Taslak kaydedilemedi: ' + e.message;
    });
  }
  function cozumRozet(s) {
    var n = D.notlar[s.id] || {};
    s.cozumRozet.textContent = n.cozum_commit ? ' · GitHub ✓' : (n.cozum ? ' · taslak' : '');
    s.cozumBilgi.textContent = '';
    if (n.cozum_commit) {
      s.cozumBilgi.appendChild(document.createTextNode('Son commit: ' + tarihSaat(n.cozum_tarih) + ' · ' + n.cozum_commit.slice(0, 7) + ' · '));
      s.cozumBilgi.appendChild(el('a', { href: 'https://github.com/' + GH.repo + '/blob/' + n.cozum_commit + '/' + n.cozum_yol, target: '_blank', rel: 'noopener' }, ['GitHub\'da aç']));
    }
  }
  function cozumGithubDurum() {
    sorular.forEach(function (s) {
      s.cozumGonder.disabled = !GH.hazir;
      s.cozumCek.disabled = !GH.hazir;
      s.cozumUyari.hidden = GH.hazir;
    });
  }

  function cozumEditoru(s) {
    var alan = el('textarea', { class: 'mono cozum-alan', rows: '16', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off', 'aria-label': 'Çözüm kodu' });
    alan.addEventListener('input', function () { cozumDegisti(s.id); });
    alan.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      var a = alan.selectionStart, b = alan.selectionEnd;
      alan.setRangeText('    ', a, b, 'end');
      cozumDegisti(s.id);
    });
    var gonder = el('button', { type: 'button', class: 'btn ana' }, ['Onayla ve GitHub\'a gönder']);
    var cek = el('button', { type: 'button', class: 'btn' }, ['GitHub\'dan çek']);
    var durum = el('div', { class: 'not-durum', 'aria-live': 'polite' });
    var bilgi = el('div', { class: 'cozum-bilgi' });
    var uyari = el('p', { class: 'cozum-uyari', text: 'GitHub bağlantısı kurulmamış: Cloudflare\'de GITHUB_TOKEN Secret\'ı ve GITHUB_REPO ayarı gerekli (README → GitHub çözümleri). Taslaklar yine de kaydedilir.' });
    uyari.hidden = true;
    var rozet = el('span', { class: 'cozum-rozet' });

    gonder.addEventListener('click', function () {
      var kod = alan.value;
      if (!kod.trim()) { bildir('Boş çözüm gönderilemez.', true); return; }
      cozumBekleyen[s.id] = false; clearTimeout(cozumZaman[s.id]);
      gonder.disabled = cek.disabled = true;
      durum.className = 'not-durum'; durum.textContent = 'GitHub\'a gönderiliyor…';
      api('POST', '/api/cozum/' + s.id + '/github', { cozum: kod, yol: s.yol, baslik: 'K' + s.kademe + ' · ' + s.baslik }).then(function (j) {
        veriyiAl(j); ciz();
        durum.className = 'not-durum'; durum.textContent = (j.yeni ? 'Dosya oluşturuldu ve commit atıldı.' : 'Commit atıldı.');
        bildir('GitHub\'a gönderildi: ' + s.yol);
      }).catch(function (e) {
        durum.className = /aynı/.test(e.message) ? 'not-durum' : 'not-durum hata';
        durum.textContent = e.message;
        cozumBekleyen[s.id] = true; cozumTaslakKaydet(s.id, false, true);
      }).then(function () { gonder.disabled = cek.disabled = !GH.hazir; });
    });

    cek.addEventListener('click', function () {
      gonder.disabled = cek.disabled = true;
      durum.className = 'not-durum'; durum.textContent = 'GitHub\'dan alınıyor…';
      api('GET', '/api/cozum/' + s.id + '/github?yol=' + encodeURIComponent(s.yol)).then(function (j) {
        if (alan.value.trim() && alan.value !== j.cozum && alan.value !== cozumSablonu(s) &&
            !confirm('Editördeki metin GitHub\'daki hâliyle değiştirilsin mi?')) { durum.textContent = ''; return; }
        alan.value = j.cozum;
        cozumBekleyen[s.id] = true; cozumTaslakKaydet(s.id);
        durum.className = 'not-durum'; durum.textContent = 'GitHub\'daki güncel hâl alındı.';
      }).catch(function (e) { durum.className = 'not-durum hata'; durum.textContent = e.message; })
        .then(function () { gonder.disabled = cek.disabled = !GH.hazir; });
    });

    var kutu = el('details', { class: 'cozum' }, [
      el('summary', null, ['Çözüm (C#)', rozet]),
      el('div', { class: 'cozum-icerik' }, [
        el('div', { class: 'cozum-yol', text: s.yol }),
        alan,
        el('div', { class: 'ayar-eylem' }, [gonder, cek]),
        durum, bilgi, uyari
      ])
    ]);
    var ipucu = s.li.querySelector('details');
    s.li.insertBefore(kutu, ipucu ? ipucu.nextSibling : null);
    s.cozumAlan = alan; s.cozumDurum = durum; s.cozumBilgi = bilgi; s.cozumUyari = uyari;
    s.cozumRozet = rozet; s.cozumGonder = gonder; s.cozumCek = cek;
  }

  var notZaman = {}, notBekleyen = {};

  function soruAraclari(s) {
    // Checkbox: iyimser güncelleme
    s.kutu.addEventListener('change', function () {
      var yeni = s.kutu.checked;
      var eski = D.ilerleme[s.id] ? Object.assign({}, D.ilerleme[s.id]) : null;
      D.ilerleme[s.id] = Object.assign({ soru_id: s.id, zorlandim: 0 }, eski || {}, { cozuldu: yeni ? 1 : 0 });
      ciz();
      s.kutu.disabled = true;
      api('PUT', '/api/ilerleme/' + s.id, { cozuldu: yeni }).then(function (j) {
        veriyiAl(j); ciz();
      }).catch(function (e) {
        if (eski) D.ilerleme[s.id] = eski; else delete D.ilerleme[s.id];
        s.kutu.checked = !yeni;
        ciz();
        bildir('Kaydedilemedi, işaret geri alındı: ' + e.message, true);
      }).then(function () { s.kutu.disabled = false; });
    });

    var zBtn = el('button', { type: 'button', class: 'btn zorlandim', 'aria-pressed': 'false', title: 'Tekrar listesine ekle' }, ['Zorlandım']);
    zBtn.addEventListener('click', function () {
      var yeni = !zorlandimMi(s.id);
      var eski = D.ilerleme[s.id] ? Object.assign({}, D.ilerleme[s.id]) : null;
      D.ilerleme[s.id] = Object.assign({ soru_id: s.id, cozuldu: 0 }, eski || {}, { zorlandim: yeni ? 1 : 0 });
      ciz();
      api('PUT', '/api/ilerleme/' + s.id, { zorlandim: yeni }).then(function (j) {
        veriyiAl(j); ciz();
      }).catch(function (e) {
        if (eski) D.ilerleme[s.id] = eski; else delete D.ilerleme[s.id];
        ciz();
        bildir('Kaydedilemedi, geri alındı: ' + e.message, true);
      });
    });

    var gBtn = el('button', { type: 'button', class: 'btn gonder', title: 'Gönderme formatında panoya kopyala' }, ['Bana gönder']);
    gBtn.addEventListener('click', function () {
      notuHemenKaydet(s.id);
      kopyala(gonderMetni(s)).then(function () { bildir('Panoya kopyalandı.'); })
        .catch(function () { bildir('Kopyalanamadı. Tarayıcı panoya erişime izin vermedi.', true); });
    });

    var arac = el('div', { class: 'soru-arac' }, [zBtn, gBtn]);

    // Notlar
    var alanlar = {};
    function alan(ad, etiket, tip, mono) {
      var g = tip === 'input'
        ? el('input', { type: 'text', autocomplete: 'off', spellcheck: 'false' })
        : el('textarea', { rows: mono ? '6' : '3', spellcheck: mono ? 'false' : 'true', class: mono ? 'mono' : '' });
      if (mono) { g.setAttribute('autocapitalize', 'off'); g.setAttribute('autocorrect', 'off'); }
      g.addEventListener('input', function () { notDegisti(s.id); });
      alanlar[ad] = g;
      return el('label', null, [etiket, g]);
    }
    var durum = el('div', { class: 'not-durum', 'aria-live': 'polite' });
    var isaret = el('span', { class: 'isaret', 'aria-hidden': 'true' });
    var notlar = el('details', { class: 'notlar' }, [
      el('summary', null, ['Notlarım', isaret]),
      el('div', { class: 'not-alanlar' }, [
        alan('yaklasim', 'Yaklaşım', 'textarea'),
        alan('big_o', 'Big O', 'input'),
        alan('kod', 'Kod', 'textarea', true),
        alan('takildigim', 'Takıldığım yer', 'textarea'),
        durum
      ])
    ]);
    s.li.appendChild(arac);
    s.li.appendChild(notlar);
    cozumEditoru(s);
    s.zBtn = zBtn; s.alanlar = alanlar; s.notDurum = durum; s.notIsaret = isaret;
  }

  function notDegerleri(s) {
    return { yaklasim: s.alanlar.yaklasim.value, big_o: s.alanlar.big_o.value, kod: s.alanlar.kod.value, takildigim: s.alanlar.takildigim.value };
  }
  function notDegisti(id) {
    var s = soruHarita[id];
    notBekleyen[id] = true;
    s.notDurum.className = 'not-durum';
    s.notDurum.textContent = 'Yazılıyor…';
    clearTimeout(notZaman[id]);
    notZaman[id] = setTimeout(function () { notKaydet(id); }, 1000);
  }
  function notKaydet(id, keepalive) {
    var s = soruHarita[id];
    if (!notBekleyen[id]) return Promise.resolve();
    notBekleyen[id] = false;
    clearTimeout(notZaman[id]);
    var deger = notDegerleri(s);
    s.notDurum.textContent = 'Kaydediliyor…';
    return api('PUT', '/api/not/' + id, deger, { keepalive: keepalive }).then(function (j) {
      D.notlar[id] = Object.assign({ soru_id: id, guncelleme: j.guncelleme }, deger);
      if (!notBekleyen[id]) {
        s.notDurum.className = 'not-durum';
        s.notDurum.textContent = 'Kaydedildi';
      }
      notIsaretGuncelle(s);
    }).catch(function (e) {
      notBekleyen[id] = true;
      s.notDurum.className = 'not-durum hata';
      s.notDurum.textContent = 'Kaydedilemedi: ' + e.message + ' Yazmaya devam edince yeniden denenir.';
    });
  }
  function notuHemenKaydet(id) { if (notBekleyen[id]) notKaydet(id); }
  function notIsaretGuncelle(s) {
    var v = notDegerleri(s);
    var dolu = Object.keys(v).some(function (k) { return v[k].trim(); });
    s.notIsaret.textContent = dolu ? ' •' : '';
  }
  window.addEventListener('pagehide', function () {
    Object.keys(cozumBekleyen).forEach(function (id) { if (cozumBekleyen[id]) cozumTaslakKaydet(id, true); });
    Object.keys(notBekleyen).forEach(function (id) { if (notBekleyen[id]) notKaydet(id, true); });
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') Object.keys(cozumBekleyen).forEach(function (id) { if (cozumBekleyen[id]) cozumTaslakKaydet(id, true); });
    if (document.visibilityState === 'hidden') Object.keys(notBekleyen).forEach(function (id) { if (notBekleyen[id]) notKaydet(id, true); });
  });

  function notlariDoldur() {
    sorular.forEach(function (s) {
      if (notBekleyen[s.id]) return;   // yazılmakta olanı ezme
      var n = D.notlar[s.id] || {};
      s.alanlar.yaklasim.value = n.yaklasim || '';
      s.alanlar.big_o.value = n.big_o || '';
      s.alanlar.kod.value = n.kod || '';
      s.alanlar.takildigim.value = n.takildigim || '';
      notIsaretGuncelle(s);
    });
    sorular.forEach(function (s) {
      if (cozumBekleyen[s.id]) return;
      var n = D.notlar[s.id] || {};
      s.cozumAlan.value = n.cozum || cozumSablonu(s);
    });
  }

  function gonderMetni(s) {
    var b = gunBilgisi();
    var r = D.ilerleme[s.id];
    var n = b.gunNo;
    if (r && r.cozulme_tarihi) {
      var i = b.tarihler.indexOf(r.cozulme_tarihi);
      if (i > -1) n = i + 1;
    }
    var v = notDegerleri(s);
    if (!v.kod.trim() && s.cozumAlan && s.cozumAlan.value !== cozumSablonu(s)) v.kod = s.cozumAlan.value;
    var girinti = '          ';
    var yaklasim = (v.yaklasim.trim() || '').split('\n').join('\n' + girinti);
    return 'Gün ' + n + ' · K' + s.kademe + ' · ' + s.ad + '\n' +
      'Yaklaşım: ' + yaklasim + '\n' +
      'Big O: ' + v.big_o.trim() + '\n' +
      'Kod:\n' + (v.kod.replace(/\s+$/, '') || '...') + '\n' +
      'Takıldığım yer: ' + (v.takildigim.trim() || '(yok)');
  }

  function kopyala(metin) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(metin);
    return new Promise(function (coz, red) {
      var t = el('textarea', { readonly: '', style: 'position:fixed;top:0;left:0;opacity:0' });
      t.value = metin;
      document.body.appendChild(t);
      t.select();
      try { document.execCommand('copy') ? coz() : red(); } catch (e) { red(e); }
      t.remove();
    });
  }

  // ---------- Panel ----------
  var panel, bugunSatir, oneriKutu, ozetKutu, tekrarKutu, aktarKutu;

  function paneliKur() {
    bugunSatir = el('p', { class: 'bugun-satir' });
    oneriKutu = el('div', { class: 'oneri' });
    aktarKutu = el('div');
    ozetKutu = el('div', { class: 'ozet' });
    tekrarKutu = el('div');
    panel = el('section', { id: 'panel', 'aria-label': 'Bugün ve ilerleme' }, [
      bugunSatir, aktarKutu, oneriKutu,
      el('h3', { text: 'İlerleme özeti' }), ozetKutu,
      el('h3', { id: 'tekrar-listesi', text: 'Tekrar listesi' }), tekrarKutu
    ]);
    var rutin = document.getElementById('rutin');
    rutin.parentNode.insertBefore(panel, rutin);
  }

  function panelCiz() {
    var b = gunBilgisi();
    bugunSatir.textContent = '';
    bugunSatir.appendChild(document.createTextNode('Bugün: Gün '));
    bugunSatir.appendChild(el('span', { text: String(b.gunNo) }));
    bugunSatir.appendChild(document.createTextNode(' · Zincir: '));
    bugunSatir.appendChild(el('span', { text: String(b.zincir) }));
    bugunSatir.appendChild(document.createTextNode(' gün'));

    // Bugünün önerisi
    oneriKutu.textContent = '';
    var o = bugununOnerisi(b);
    var kayit = b.bugunKayit;
    if (kayit) {
      oneriKutu.className = 'oneri';
      var ks = soruHarita[kayit.soru_id];
      oneriKutu.appendChild(el('div', { class: 'etiket', text: kayit.tur === 'tekrar' ? 'BUGÜNÜN TEKRARI' : 'BUGÜNÜN SORUSU' }));
      oneriKutu.appendChild(el('p', null, [el('span', { class: 'tamam-yazi', text: 'Bugün tamam ✓ ' }), ks ? soruLinki(ks) : '']));
      oneriKutu.appendChild(el('p', { class: 'bos-yazi', text: 'Zincir sürüyor. Yarın yeni soruyla devam.' }));
    } else if (!o) {
      oneriKutu.className = 'oneri';
      oneriKutu.appendChild(el('div', { class: 'etiket', text: 'BUGÜNÜN SORUSU' }));
      oneriKutu.appendChild(el('p', { text: '120 sorunun hepsini çözdün. "Bitirdikten sonra" bölümüne göz at.' }));
    } else if (o.tur === 'tekrar') {
      oneriKutu.className = 'oneri tekrar';
      oneriKutu.appendChild(el('div', { class: 'etiket', text: 'TEKRAR GÜNÜ' }));
      oneriKutu.appendChild(el('p', null, ['Bugün yeni soru yok. Bu soruyu bakmadan baştan çöz: ', soruLinki(o.soru)]));
      if (o.zorlandimYok) oneriKutu.appendChild(el('p', { class: 'bos-yazi', text: 'Tekrar listen boş olduğu için çözdüğün sorulardan biri seçildi.' }));
      var tb = el('button', { type: 'button', class: 'btn ana' }, ['Tekrarı yaptım']);
      tb.addEventListener('click', function () {
        tb.disabled = true;
        api('POST', '/api/tekrar', { soru_id: o.soru.id }).then(function (j) { veriyiAl(j); ciz(); bildir('Tekrar kaydedildi. Zincir sürüyor.'); })
          .catch(function (e) { tb.disabled = false; bildir('Kaydedilemedi: ' + e.message, true); });
      });
      oneriKutu.appendChild(el('div', { class: 'eylem' }, [tb]));
    } else {
      oneriKutu.className = 'oneri';
      oneriKutu.appendChild(el('div', { class: 'etiket', text: 'BUGÜNÜN SORUSU' }));
      oneriKutu.appendChild(el('p', null, [soruLinki(o.soru)]));
      oneriKutu.appendChild(el('p', { class: 'bos-yazi', text: 'Çözünce kutucuğu işaretle; gün ve zincir kendiliğinden güncellenir.' }));
    }

    // Özet
    ozetKutu.textContent = '';
    var toplam = sorular.length, cozulen = sorular.filter(function (s) { return cozulduMu(s.id); }).length;
    var yuzde = toplam ? Math.round(cozulen * 100 / toplam) : 0;
    ozetKutu.appendChild(el('div', { class: 'ozet-genel' }, [el('span', { text: 'Genel: ' + cozulen + ' / ' + toplam }), el('span', { text: '%' + yuzde })]));
    var gc = el('div', { class: 'cubuk genel', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(toplam), 'aria-valuenow': String(cozulen), 'aria-label': 'Genel ilerleme' }, [el('i')]);
    gc.firstChild.style.width = yuzde + '%';
    ozetKutu.appendChild(gc);
    for (var k = 0; k <= 12; k++) {
      var ks2 = sorular.filter(function (s) { return s.kademe === k; });
      var c = ks2.filter(function (s) { return cozulduMu(s.id); }).length;
      var cb = el('div', { class: 'cubuk', 'aria-hidden': 'true' }, [el('i')]);
      cb.firstChild.style.width = (ks2.length ? (c * 100 / ks2.length) : 0) + '%';
      ozetKutu.appendChild(el('div', { class: 'ozet-satir' }, [
        el('a', { href: '#k' + k, text: 'K' + k }), cb, el('span', { class: 'sayi', text: c + '/' + ks2.length })
      ]));
    }

    // Tekrar listesi
    tekrarKutu.textContent = '';
    var zl = sorular.filter(function (s) { return zorlandimMi(s.id); });
    if (!zl.length) {
      tekrarKutu.appendChild(el('p', { class: 'bos-yazi', text: 'Henüz yok. Zorlandığın sorularda "Zorlandım" butonuna bas; tekrar günlerinde buradan seçilir.' }));
    } else {
      var ul = el('ul', { class: 'tekrar-listesi' });
      zl.forEach(function (s) {
        var son = sonTekrar(s.id);
        ul.appendChild(el('li', null, [soruLinki(s), son ? el('span', { class: 'bos-yazi', text: ' · son tekrar ' + son }) : null]));
      });
      tekrarKutu.appendChild(ul);
    }
  }

  // ---------- localStorage aktarma ----------
  function aktarmaKontrol() {
    aktarKutu.textContent = '';
    aktarKutu.className = '';
    if (Object.keys(D.ilerleme).length) return;
    var eski = {};
    try { eski = JSON.parse(localStorage.getItem(ESKI_ANAHTAR) || '{}') || {}; } catch (e) { eski = {}; }
    try { if (localStorage.getItem(AKTARMA_SORULDU)) return; } catch (e) {}
    var ids = Object.keys(eski).filter(function (id) { return eski[id] === true && soruHarita[id]; });
    if (!ids.length) return;
    aktarKutu.className = 'aktar-bant';
    var evet = el('button', { type: 'button', class: 'btn ana' }, ['Aktar']);
    var hayir = el('button', { type: 'button', class: 'btn' }, ['Hayır']);
    aktarKutu.appendChild(el('p', { text: 'Bu cihazdaki ' + ids.length + ' işaretli soru buluta aktarılsın mı?' }));
    aktarKutu.appendChild(el('div', { class: 'eylem' }, [evet, hayir]));
    evet.addEventListener('click', function () {
      evet.disabled = hayir.disabled = true;
      api('POST', '/api/aktar', { ids: ids }).then(function (j) {
        try { localStorage.setItem(AKTARMA_SORULDU, '1'); } catch (e) {}
        veriyiAl(j); ciz(); aktarKutu.textContent = ''; aktarKutu.className = '';
        bildir(j.aktarilan + ' soru buluta aktarıldı.');
      }).catch(function (e) { evet.disabled = hayir.disabled = false; bildir('Aktarılamadı: ' + e.message, true); });
    });
    hayir.addEventListener('click', function () {
      try { localStorage.setItem(AKTARMA_SORULDU, '1'); } catch (e) {}
      aktarKutu.textContent = ''; aktarKutu.className = '';
    });
  }

  // ---------- Menü ve ayarlar ----------
  var epostaEl;
  function menuKur() {
    epostaEl = el('div', { class: 'menu-eposta' });
    var cikisBtn = el('button', { type: 'button', role: 'menuitem' }, ['Çıkış']);
    cikisBtn.addEventListener('click', function () {
      notlarHepsiniKaydet().then(function () { return api('POST', '/api/oturum/cikis'); })
        .then(function () { location.href = '/giris.html'; })
        .catch(function (e) { bildir('Çıkış yapılamadı: ' + e.message, true); });
    });
    var menu = el('details', { class: 'menu' }, [
      el('summary', { 'aria-label': 'Menü' }, ['Menü ▾']),
      el('div', { class: 'menu-liste', role: 'menu' }, [
        epostaEl,
        el('a', { href: '#sifre', role: 'menuitem' }, ['Şifre değiştir']),
        el('a', { href: '#yedek', role: 'menuitem' }, ['Yedek']),
        cikisBtn
      ])
    ]);
    menu.querySelectorAll('a').forEach(function (a) { a.addEventListener('click', function () { menu.open = false; }); });
    document.addEventListener('click', function (e) { if (menu.open && !menu.contains(e.target)) menu.open = false; });
    document.querySelector('header').appendChild(menu);
  }

  function notlarHepsiniKaydet() {
    Object.keys(cozumBekleyen).forEach(function (id) { if (cozumBekleyen[id]) cozumTaslakKaydet(id); });
    return Promise.all(Object.keys(notBekleyen).filter(function (id) { return notBekleyen[id]; }).map(function (id) { return notKaydet(id); }));
  }

  function ayarlarKur() {
    // Şifre değiştir
    var mevcut = el('input', { type: 'password', autocomplete: 'current-password', required: '' });
    var yeni = el('input', { type: 'password', autocomplete: 'new-password', required: '', minlength: '8' });
    var yeni2 = el('input', { type: 'password', autocomplete: 'new-password', required: '', minlength: '8' });
    var sMesaj = el('p', { class: 'ayar-mesaj', role: 'alert' });
    var sBtn = el('button', { type: 'submit', class: 'btn ana' }, ['Şifreyi değiştir']);
    var sForm = el('form', { class: 'ayar-form', id: 'sifre-form' }, [
      el('label', null, ['Mevcut şifre', mevcut]),
      el('label', null, ['Yeni şifre (en az 8 karakter, harf + rakam)', yeni]),
      el('label', null, ['Yeni şifre (tekrar)', yeni2]),
      el('div', { class: 'ayar-eylem' }, [sBtn]), sMesaj
    ]);
    sForm.addEventListener('submit', function (e) {
      e.preventDefault();
      sMesaj.className = 'ayar-mesaj hata';
      if (yeni.value !== yeni2.value) { sMesaj.textContent = 'Yeni şifreler aynı değil.'; return; }
      if (yeni.value.length < 8 || !/\p{L}/u.test(yeni.value) || !/\d/.test(yeni.value)) { sMesaj.textContent = 'Yeni şifre en az 8 karakter olmalı ve harf + rakam içermeli.'; return; }
      sBtn.disabled = true;
      api('POST', '/api/oturum/sifre', { mevcut: mevcut.value, yeni: yeni.value }).then(function () {
        sForm.reset();
        sMesaj.className = 'ayar-mesaj iyi';
        sMesaj.textContent = 'Şifre değişti. Diğer cihazlardaki oturumlar kapatıldı.';
      }).catch(function (err) { sMesaj.textContent = err.message; }).then(function () { sBtn.disabled = false; });
    });

    // Yedek
    var yMesaj = el('p', { class: 'ayar-mesaj', role: 'alert' });
    var indir = el('button', { type: 'button', class: 'btn ana', id: 'yedek-indir' }, ['JSON indir']);
    var dosya = el('input', { type: 'file', accept: 'application/json,.json', id: 'yedek-dosya', style: 'display:none' });
    var yukle = el('button', { type: 'button', class: 'btn', id: 'yedek-yukle' }, ['Geri yükle…']);
    indir.addEventListener('click', function () {
      notlarHepsiniKaydet().then(function () { return api('GET', '/api/yedek'); }).then(function (j) {
        var blob = new Blob([JSON.stringify(j, null, 2)], { type: 'application/json' });
        var a = el('a', { href: URL.createObjectURL(blob), download: 'algoritma-yedek-' + D.bugun + '.json' });
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
        yMesaj.className = 'ayar-mesaj iyi'; yMesaj.textContent = 'Yedek indirildi.';
      }).catch(function (e) { yMesaj.className = 'ayar-mesaj hata'; yMesaj.textContent = e.message; });
    });
    yukle.addEventListener('click', function () { dosya.click(); });
    dosya.addEventListener('change', function () {
      var f = dosya.files && dosya.files[0];
      dosya.value = '';
      if (!f) return;
      f.text().then(function (metin) {
        var j;
        try { j = JSON.parse(metin); } catch (e) { throw new Error('Dosya okunamadı: geçerli bir JSON değil.'); }
        var n = (j.ilerleme || []).filter(function (r) { return r.cozuldu; }).length;
        if (!confirm('Yedek geri yüklensin mi? Sunucudaki tüm ilerleme, notlar ve günler bu dosyadakilerle değişir (' + n + ' çözülmüş soru).')) return null;
        return api('POST', '/api/yedek', j);
      }).then(function (j) {
        if (!j) return;
        notBekleyen = {}; cozumBekleyen = {};
        veriyiAl(j); notlariDoldur(); ciz();
        yMesaj.className = 'ayar-mesaj iyi'; yMesaj.textContent = 'Yedek geri yüklendi.';
      }).catch(function (e) { yMesaj.className = 'ayar-mesaj hata'; yMesaj.textContent = e.message; });
    });

    var bolum = el('section', { id: 'ayarlar' }, [
      el('h2', { text: 'Ayarlar' }),
      el('h3', { id: 'sifre', text: 'Şifre değiştir' }), sForm,
      el('h3', { id: 'yedek', text: 'Yedek' }),
      el('p', { class: 'lead', text: 'Tüm ilerlemeni, notlarını ve gün kayıtlarını tek bir JSON dosyası olarak indir ya da daha önce indirdiğin bir yedeği geri yükle.' }),
      el('div', { class: 'ayar-eylem' }, [indir, yukle, dosya]), yMesaj
    ]);
    var son = document.getElementById('son');
    son.parentNode.insertBefore(bolum, son.nextSibling);
  }

  // ---------- Çizim ----------
  function ciz() {
    sorular.forEach(function (s) {
      s.kutu.checked = cozulduMu(s.id);
      var z = zorlandimMi(s.id);
      s.zBtn.setAttribute('aria-pressed', z ? 'true' : 'false');
      s.zBtn.textContent = z ? 'Zorlandım ✓' : 'Zorlandım';
      cozumRozet(s);
    });
    var cozulen = sorular.filter(function (s) { return cozulduMu(s.id); }).length;
    var il = document.getElementById('ilerleme');
    if (il) il.textContent = 'İlerleme: ' + cozulen + ' / ' + sorular.length + ' soru çözüldü.';
    if (epostaEl) epostaEl.textContent = D.eposta;
    panelCiz();
  }

  // ---------- Başlat ----------
  function baslat() {
    sorulariTopla();
    sorular.forEach(function (s) { s.kutu.disabled = true; soruAraclari(s); });
    paneliKur();
    menuKur();
    ayarlarKur();
    ciz();
    bugunSatir.textContent = 'Yükleniyor…';
    cozumGithubDurum();
    api('GET', '/api/github').then(function (j) { GH = j; cozumGithubDurum(); ciz(); }).catch(function () {});
    api('GET', '/api/veri').then(function (j) {
      veriyiAl(j);
      notlariDoldur();
      sorular.forEach(function (s) { s.kutu.disabled = false; });
      ciz();
      aktarmaKontrol();
      if (location.hash && soruHarita[location.hash.slice(1)]) soruyaGit(location.hash.slice(1));
    }).catch(function (e) {
      bugunSatir.textContent = 'Veriler yüklenemedi.';
      bildir('Veriler yüklenemedi: ' + e.message + ' Sayfayı yenile.', true);
    });
  }

  // Sayfa uzun süre açık kalınca (ör. ertesi gün) verileri tazele
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || !sorular.length) return;
    if (Object.keys(notBekleyen).some(function (id) { return notBekleyen[id]; })) return;
    if (Object.keys(cozumBekleyen).some(function (id) { return cozumBekleyen[id]; })) return;
    api('GET', '/api/veri').then(function (j) { veriyiAl(j); notlariDoldur(); ciz(); }).catch(function () {});
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', baslat);
  else baslat();
})();
