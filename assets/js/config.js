/*
 * Контакты сайта (Физиотера, Уфа). Чтобы поменять телефон или ссылку — правьте только этот файл.
 * Пустая строка = кнопка показывает подсказку «контакт скоро появится»
 * и никуда не ведёт (чтобы не отправлять пациентов на чужие страницы).
 *
 * Формат:
 *   telegram:  "https://t.me/username"
 *   max:       ссылка на профиль/канал в MAX
 *   map:       ссылка на Яндекс Карты или 2ГИС
 */
window.SITE_CONTACTS = {
  phone: "+79876000037",            // номер для записи — на всех кнопках «Позвонить»
  phoneLabel: "+7 (987) 600-00-37",
  whatsapp: "https://api.whatsapp.com/send?phone=79876000037",
  telegram: "https://t.me/DrGorshechnikov",
  vk: "https://vk.ru/fiziotera",
  instagram: "https://www.instagram.com/fiziotera.ufa/",          // Instagram клиники
  instagramDoctor: "https://www.instagram.com/dr.gorshechnikov/", // Instagram врача
  max: "https://max.ru/u/f9LHodD0cOJ5qM7mAcu-cj0ZwwqdU4QYS6IZzzRQHWl3sGrnLaILVVGCSmU",
  address: "Уфа, ул. Энтузиастов, 16",
  map: "https://yandex.ru/maps/?text=%D0%A3%D1%84%D0%B0%2C%20%D1%83%D0%BB%D0%B8%D1%86%D0%B0%20%D0%AD%D0%BD%D1%82%D1%83%D0%B7%D0%B8%D0%B0%D1%81%D1%82%D0%BE%D0%B2%2C%2016"
};

/*
 * Реквизиты для страницы «Политика конфиденциальности» (politika.html).
 * Заполните, когда клиника пришлёт данные. Пустые строки на странице не показываются.
 */
window.SITE_LEGAL = {
  name: "ООО «ТАБИБ»",
  inn: "0263021410",
  kpp: "026301001",
  ogrn: "1160280072523",
  legalAddress: "Республика Башкортостан, Мелеузовский р-н, г. Мелеуз, ул. Полевая, д. 44",
  email: "subkhankulov.ruslan89@yandex.ru"
};

/*
 * Заявки с формы.
 *   endpoint  — серверная функция, которая сама отправляет заявку в WhatsApp/Telegram
 *               (api/lead.js, работает на Vercel). Ключи задаются в настройках Vercel, см. README.
 *   whatsapp  — номер, на который уйдёт заявка, если автоотправка не настроена или не сработала:
 *               тогда у пациента откроется WhatsApp с готовым текстом заявки.
 */
window.SITE_LEADS = {
  endpoint: "/api/lead",
  whatsapp: "79876000037"
};
