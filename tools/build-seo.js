#!/usr/bin/env node
/*
 * Генератор SEO-файлов сайта. Запуск из корня репозитория:
 *
 *   node tools/build-seo.js
 *
 * Берёт данные из assets/js/services-info.js и assets/js/config.js и пересоздаёт:
 *   uslugi/<slug>/index.html — статичные страницы услуг (текст и цены сразу в HTML, видны поисковикам);
 *   usluga.html              — старый адрес услуги: пересылает на новую страницу (для GitHub Pages / старых ссылок);
 *   sitemap.xml              — карта сайта;
 *   vercel.json              — 301-редиректы (vercel.app → домен, старые адреса услуг → новые) и заголовки.
 *
 * После правки текстов или цен в services-info.js — запустите скрипт и закоммитьте результат.
 * Зависимостей нет, нужен только Node.js.
 */
"use strict";

var fs = require("fs");
var path = require("path");
var vm = require("vm");

/* ---------- Настройки ---------- */
var SITE_URL = "https://fizitera.online";              // основной домен (без слеша на конце)
var OLD_HOSTS = ["clinic-alpha-one.vercel.app"];       // технические адреса → 301 на основной домен
var BRAND = "Физиотера";
var CITY = "Уфа";

var ROOT = path.resolve(__dirname, "..");
function read(p) { return fs.readFileSync(path.join(ROOT, p), "utf8"); }
function write(p, s) {
  var full = path.join(ROOT, p);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, s);
}

/* ---------- Данные ---------- */
var sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(read("assets/js/config.js"), sandbox);
vm.runInContext(read("assets/js/services-info.js"), sandbox);
var W = sandbox.window;
var INFO = W.SERVICES_INFO, METHODS = W.SERVICE_METHODS, C = W.SITE_CONTACTS;
var ids = Object.keys(INFO);

var seen = {};
ids.forEach(function (id) {
  var s = INFO[id].slug;
  if (!s || !/^[a-z0-9-]+$/.test(s)) throw new Error("Нет корректного slug у услуги " + id);
  if (seen[s]) throw new Error("Повторяющийся slug: " + s);
  seen[s] = 1;
});

/* ---------- Утилиты ---------- */
function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function url(slug) { return SITE_URL + "/uslugi/" + slug + "/"; }
function priceNum(s) { var n = String(s || "").replace(/[^\d]/g, ""); return n ? Number(n) : null; }
function clip(s, max) {
  s = String(s).trim();
  if (s.length <= max) return s;
  var cut = s.slice(0, max);
  cut = cut.slice(0, cut.lastIndexOf(" ")).replace(/[,:;—–-]+$/, "");
  return cut + "…";
}
function jsonLd(obj) { return JSON.stringify(obj, null, 2).replace(/</g, "\\u003c"); }

// Размеры JPEG/PNG (нужны width/height у картинок — защита от сдвигов вёрстки, CLS)
function imgSize(rel) {
  var b = fs.readFileSync(path.join(ROOT, rel));
  if (b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  var i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    var m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

var LEGAL = W.SITE_LEGAL || {};
var phoneHref = "tel:" + String(C.phone || "").replace(/[^\d+]/g, "");
var address = C.address || "";
var street = address.replace(/^Уфа,\s*/, "");

var CLINIC_REF = {
  "@type": "MedicalClinic",
  "@id": SITE_URL + "/#clinic",
  name: BRAND,
  url: SITE_URL + "/",
  telephone: C.phone,
  address: {
    "@type": "PostalAddress",
    streetAddress: street,
    addressLocality: CITY,
    addressRegion: "Республика Башкортостан",
    addressCountry: "RU"
  }
};

/* ---------- Страница услуги ---------- */
function servicePage(id) {
  var d = INFO[id];
  var pageUrl = url(d.slug);
  var hasPrices = d.prices && d.prices.length;
  var first = hasPrices ? priceNum(d.prices[0][1]) : null;

  var title = d.title + " в Уфе" + (hasPrices ? " — цены" : "") + " | " + BRAND;
  var priceText = hasPrices ? " Цена — от " + d.prices[0][1] + "." : "";
  var tail = priceText + " " + BRAND + ", " + address + ".";
  var firstSentence = String(d.lead).split(/(?<=[.!?])\s+/)[0];
  var description = clip(firstSentence, Math.max(80, 190 - tail.length)) + tail;

  var img = d.img || "";
  var size = img ? imgSize(img) : null;
  var ogImage = SITE_URL + "/" + (img || "assets/img/og.jpg");

  var prices = (d.prices || []).map(function (p) {
    return '            <div class="svc-modal__price"><span>' + esc(p[0]) + '</span><span class="svc-modal__price-val"><b>' + esc(p[1]) + "</b>" +
      (p[2] ? '<small class="time">' + esc(p[2]) + "</small>" : "") + "</span></div>";
  }).join("\n");
  if (!hasPrices) prices = '            <p class="svc-modal__note">Стоимость уточняйте у&nbsp;администратора — методику назначает врач после осмотра.</p>';

  function abon(t, rows) {
    if (!rows) return "";
    return '            <h3 class="svc-abon__title">' + esc(t || "Абонементы") + "</h3>\n" +
      '            <div class="svc-modal__prices">\n' + rows.map(function (a) {
        return '              <div class="svc-modal__price"><span>' + esc(a[0]) + '</span><span class="svc-modal__price-val">' +
          (a[2] ? '<s class="svc-old">' + esc(a[2]) + "</s>" : "") + "<b>" + esc(a[1]) + "</b></span></div>";
      }).join("\n") + "\n            </div>\n";
  }

  var methods = "";
  if (d.methods) {
    methods = '        <section>\n          <h2>Состав</h2>\n' +
      (d.methodsNote ? '          <p class="svc-modal__note">' + esc(d.methodsNote) + "</p>\n" : "") +
      '          <ul class="svc-modal__methods">\n' + d.methods.filter(function (k) { return METHODS[k]; }).map(function (k) {
        return "            <li><b>" + esc(METHODS[k][0]) + "</b><span>" + esc(METHODS[k][1]) + "</span></li>";
      }).join("\n") + "\n          </ul>\n        </section>\n";
  }

  var more = ids.filter(function (k) { return k !== id; }).map(function (k) {
    return '        <a class="svc-more__item" href="../' + INFO[k].slug + '/">' + esc(INFO[k].title) + "</a>";
  }).join("\n");

  var media = img
    ? '<img src="../../' + esc(img) + '" alt="' + esc(d.title + " — клиника " + BRAND + ", " + CITY) + '"' +
      (size ? ' width="' + size.w + '" height="' + size.h + '"' : "") + ' fetchpriority="high" />'
    : '<img src="../../assets/img/logo-mark.svg" alt="" width="320" height="320" />';

  var service = {
    "@type": "Service",
    "@id": pageUrl + "#service",
    name: d.title,
    serviceType: d.kind,
    description: d.lead,
    url: pageUrl,
    areaServed: { "@type": "City", name: CITY },
    provider: CLINIC_REF
  };
  if (img) service.image = ogImage;
  if (first) service.offers = { "@type": "Offer", price: first, priceCurrency: "RUB", url: pageUrl };

  var ld = {
    "@context": "https://schema.org",
    "@graph": [
      service,
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: BRAND, item: SITE_URL + "/" },
          { "@type": "ListItem", position: 2, name: d.title, item: pageUrl }
        ]
      }
    ]
  };

  return '<!doctype html>\n<html lang="ru">\n<head>\n' +
'  <meta charset="utf-8" />\n' +
'  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />\n' +
'  <title>' + esc(title) + '</title>\n' +
'  <meta name="description" content="' + esc(description) + '" />\n' +
'  <link rel="canonical" href="' + pageUrl + '" />\n' +
'  <meta name="theme-color" content="#0b1742" />\n' +
'  <meta property="og:type" content="website" />\n' +
'  <meta property="og:locale" content="ru_RU" />\n' +
'  <meta property="og:site_name" content="' + BRAND + '" />\n' +
'  <meta property="og:url" content="' + pageUrl + '" />\n' +
'  <meta property="og:title" content="' + esc(d.title + " — " + BRAND + ", " + CITY) + '" />\n' +
'  <meta property="og:description" content="' + esc(description) + '" />\n' +
'  <meta property="og:image" content="' + ogImage + '" />\n' +
'  <meta name="twitter:card" content="summary_large_image" />\n' +
'  <meta name="twitter:title" content="' + esc(d.title + " — " + BRAND + ", " + CITY) + '" />\n' +
'  <meta name="twitter:description" content="' + esc(description) + '" />\n' +
'  <meta name="twitter:image" content="' + ogImage + '" />\n' +
'  <link rel="icon" href="/favicon.ico" sizes="48x48" />\n' +
'  <link rel="icon" href="../../assets/img/favicon.png" type="image/png" sizes="96x96" />\n' +
'  <link rel="apple-touch-icon" href="../../assets/img/apple-touch-icon.png" />\n' +
'  <link rel="preconnect" href="https://fonts.googleapis.com" />\n' +
'  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />\n' +
'  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet" />\n' +
'  <link rel="stylesheet" href="../../assets/css/style.css" />\n' +
'  <script type="application/ld+json">\n' + jsonLd(ld) + '\n  </script>\n' +
'</head>\n<body class="svc-page">\n' +
'  <!-- Страница сгенерирована tools/build-seo.js из assets/js/services-info.js — правьте данные там. -->\n' +
'  <header class="svc-top">\n' +
'    <div class="container svc-top__bar">\n' +
'      <a href="../../?to=services" class="svc-back" id="svcBack">\n' +
'        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5 8 12l7 7"/></svg>\n' +
'        <span>Все услуги</span>\n' +
'      </a>\n' +
'      <a href="../../" class="logo" aria-label="' + BRAND + ' — на главную">\n' +
'        <img class="logo__mark" src="../../assets/img/logo-mark.svg" alt="" width="44" height="44" />\n' +
'        <span class="logo__text">' + BRAND + '<small>Клиника лечения и&nbsp;реабилитации</small></span>\n' +
'      </a>\n' +
'    </div>\n' +
'  </header>\n\n' +
'  <main class="svc-main" id="svcMain">\n' +
'    <div class="svc-hero">\n' +
'      <div class="container svc-hero__inner">\n' +
'        <div class="svc-hero__text">\n' +
'          <span class="price-card__badge svc-hero__kind">' + esc(d.kind) + '</span>\n' +
'          <h1>' + esc(d.title) + '</h1>\n' +
'          <p class="svc-hero__lead">' + esc(d.lead) + '</p>\n' +
'        </div>\n' +
'        <div class="svc-hero__media' + (img ? "" : " svc-hero__media--plain") + '">' + media + '</div>\n' +
'      </div>\n' +
'    </div>\n\n' +
'    <div class="container svc-grid">\n' +
'      <div class="svc-content">\n' +
'        <section>\n          <h2>Кому подходит</h2>\n          <ul class="svc-modal__list">\n' +
(d.forWhat || []).map(function (t) { return "            <li>" + esc(t) + "</li>"; }).join("\n") +
'\n          </ul>\n        </section>\n' +
'        <section>\n          <h2>Как проходит</h2>\n          <p>' + esc(d.how) + '</p>\n        </section>\n' +
methods +
'        <p class="svc-modal__warn">Имеются противопоказания. Необходима консультация специалиста.</p>\n' +
'      </div>\n\n' +
'      <aside class="svc-side">\n' +
'        <div class="svc-price-card">\n' +
'          <h2>Стоимость</h2>\n' +
'          <div class="svc-modal__prices">\n' + prices + '\n          </div>\n' +
'          <div>\n' + abon(d.abonTitle, d.abon) + abon(d.abonTitle2, d.abon2) + '          </div>\n' +
(d.gift ? '          <p class="price-card__gift">' + esc(d.gift) + '</p>\n' : "") +
'          <a class="btn btn--accent btn--lg svc-cta" href="../../?book=' + encodeURIComponent(d.service || "promo") + '" rel="nofollow">Записаться <span class="btn__arrow" aria-hidden="true">→</span></a>\n' +
'          <a class="btn btn--outline btn--lg svc-cta" href="' + phoneHref + '">Позвонить</a>\n' +
'        </div>\n' +
'      </aside>\n' +
'    </div>\n\n' +
'    <nav class="container svc-more" aria-label="Другие услуги">\n' +
'      <h2>Другие услуги</h2>\n' +
'      <div class="svc-more__list">\n' + more + '\n      </div>\n' +
'    </nav>\n' +
'  </main>\n\n' +
'  <footer class="footer footer--slim">\n' +
'    <div class="container footer__bottom">\n' +
'      <p class="footer__warn">Имеются противопоказания. Необходима консультация специалиста.</p>\n' +
(LEGAL.license ? '      <p>' + esc(LEGAL.license) + '</p>\n' : "") +
'      <p>© <span id="year">2026</span> ООО «ТАБИБ» · ' + BRAND + ', ' + esc(address) + ' · <a href="' + phoneHref + '">' + esc(C.phoneLabel) + '</a> · <a href="../../politika.html">Политика конфиденциальности</a></p>\n' +
'    </div>\n' +
'  </footer>\n\n' +
'  <script>\n' +
'    // «Все услуги» — назад, если пришли с сайта (сохраняется позиция прокрутки)\n' +
'    document.getElementById("svcBack").addEventListener("click", function (e) {\n' +
'      if (document.referrer && document.referrer.indexOf(location.origin) === 0 && history.length > 1) { e.preventDefault(); history.back(); }\n' +
'    });\n' +
'    document.getElementById("year").textContent = new Date().getFullYear();\n' +
'  </script>\n' +
'</body>\n</html>\n';
}

/* ---------- Старый адрес usluga.html?s=id ---------- */
function legacyPage() {
  var map = {};
  ids.forEach(function (id) { map[id] = INFO[id].slug; });
  return '<!doctype html>\n<html lang="ru">\n<head>\n' +
'  <meta charset="utf-8" />\n' +
'  <meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
'  <title>Услуги — ' + BRAND + ', ' + CITY + '</title>\n' +
'  <meta name="robots" content="noindex, follow" />\n' +
'  <link rel="canonical" href="' + SITE_URL + '/" />\n' +
'  <script>\n' +
'    // Старый адрес страницы услуги. На Vercel сюда не попадают (301 в vercel.json), это запасной вариант.\n' +
'    (function () {\n' +
'      var map = ' + JSON.stringify(map) + ';\n' +
'      var s = map[new URLSearchParams(location.search).get("s")];\n' +
'      location.replace(s ? "uslugi/" + s + "/" : "./?to=services");\n' +
'    })();\n' +
'  </script>\n' +
'</head>\n<body>\n' +
'  <p><a href="./">Перейти на сайт ' + BRAND + '</a></p>\n' +
'</body>\n</html>\n';
}

/* ---------- sitemap.xml ---------- */
function sitemap() {
  var today = new Date().toISOString().slice(0, 10);
  var urls = [SITE_URL + "/"].concat(ids.map(function (id) { return url(INFO[id].slug); }));
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(function (u) { return "  <url><loc>" + u + "</loc><lastmod>" + today + "</lastmod></url>"; }).join("\n") +
    "\n</urlset>\n";
}

/* ---------- vercel.json ---------- */
function vercelConfig() {
  var redirects = [];
  OLD_HOSTS.forEach(function (h) {
    redirects.push({ source: "/:path*", has: [{ type: "host", value: h }], destination: SITE_URL + "/:path*", permanent: true });
  });
  ids.forEach(function (id) {
    redirects.push({ source: "/usluga.html", has: [{ type: "query", key: "s", value: id }], destination: "/uslugi/" + INFO[id].slug + "/", permanent: true });
  });
  redirects.push({ source: "/index.html", destination: "/", permanent: true });
  return JSON.stringify({
    redirects: redirects,
    headers: [
      { source: "/api/(.*)", headers: [{ key: "X-Robots-Tag", value: "noindex" }] },
      { source: "/assets/(img|video)/(.*)", headers: [{ key: "Cache-Control", value: "public, max-age=604800, stale-while-revalidate=86400" }] }
    ]
  }, null, 2) + "\n";
}

/* ---------- Запись ---------- */
var keep = {};
ids.forEach(function (id) {
  var slug = INFO[id].slug;
  keep[slug] = 1;
  write("uslugi/" + slug + "/index.html", servicePage(id));
});
// Удаляем страницы услуг, которых больше нет в services-info.js
if (fs.existsSync(path.join(ROOT, "uslugi"))) {
  fs.readdirSync(path.join(ROOT, "uslugi")).forEach(function (dir) {
    if (!keep[dir]) fs.rmSync(path.join(ROOT, "uslugi", dir), { recursive: true, force: true });
  });
}
write("usluga.html", legacyPage());
write("sitemap.xml", sitemap());
write("vercel.json", vercelConfig());
console.log("Готово: " + ids.length + " страниц услуг, sitemap.xml (" + (ids.length + 1) + " URL), usluga.html, vercel.json");
