/* Реквизиты и контакты из config.js на страницах документов (без встроенных скриптов). */
(function () {
  "use strict";
  var C = window.SITE_CONTACTS || {}, L = window.SITE_LEGAL || {};
  function each(sel, fn) { Array.prototype.forEach.call(document.querySelectorAll(sel), fn); }
  each("[data-legal]", function (el) { var v = String(L[el.getAttribute("data-legal")] || "").trim(); if (v) el.textContent = v; });
  each("[data-legal-row]", function (el) { if (!String(L[el.getAttribute("data-legal-row")] || "").trim()) el.hidden = true; });
  each("[data-legal-mail]", function (a) { if (L.email) a.href = "mailto:" + L.email; });
  each("[data-c]", function (el) { var v = C[el.getAttribute("data-c")]; if (v) el.textContent = v; });
  each("[data-c-tel]", function (a) { if (C.phone) a.href = "tel:" + C.phone; });
})();
