# SpaceZero Workspace — foydalanish va boshqaruv qo‘llanmasi

Assalomu alaykum, Ali!

Quyida SpaceZero Workspace platformasidan foydalanish, xodimlarni ishga tayyorlash va trening jarayonini boshqarish bo‘yicha batafsil qo‘llanma keltirilgan. Qo‘llanma loyihadagi 2026-yil 29-sentabr holatidagi interfeys va kod asosida yozildi. Menyular foydalanuvchi roli, berilgan huquqlar va unga biriktirilgan ma’lumotlarga qarab farq qiladi.

Platforma manzili: https://workspace.spacezero.uz

## 1. SpaceZero nima uchun kerak?

SpaceZero — Above9 Travel xodimlarining bilimini amaliy ko‘nikmaga aylantirish, natijani tekshirish va rivojlanishni kuzatish uchun ichki platforma.

Asosiy jarayon: TRAIN → PRACTICE → VERIFY → IDENTIFY WEAKNESSES → RETRAIN → IMPROVE.

Maqsad faqat materialni ko‘rib chiqish yoki kursni tugatish emas. Xodim nimani bilishi, qaysi vazifani bajara olishi va yana nimani mashq qilishi kerakligi muhim. Setup, trening natijasi va Skill Graph uch xil ko‘rsatkich: biri ishga tayyorlikni, biri topshiriq holatini, yana biri ko‘nikma dalillarini ko‘rsatadi.

## 2. Kirish va akkaunt aktivatsiyasi

- Yangi xodimni Admin Employees & Teams → Add employee orqali yaratadi. Ism, username, email, rol, ish boshlagan sana va kerakli jamoa/rahbar ma’lumotlari kiritiladi.
- Xodim invitation emailidagi bir martalik havolani ochib, o‘z parolini yaratadi. Taklif havolasi 24 soat amal qiladi.
- Kirish sahifasida username yoki email, parol va kompaniya kodi ishlatiladi. Kompaniya kodini tashkilot administratori beradi.
- Parol kamida 6 belgidan iborat bo‘lishi kerak. Username va email xodimni aniqlash uchun ishlatiladi.
- Parol unutilsa, Forgot your password? orqali tiklash so‘raladi. Reset havolasi bir martalik bo‘lib, 1 soat amal qiladi.
- Taklif muddati o‘tgan bo‘lsa, Admin xodim profilidan yangi taklif yuboradi. Invite all pending hali aktivatsiya qilinmagan xodimlar uchun yangi takliflarni tayyorlaydi/yuboradi; SMTP yoki Resend sozlamasiga qarab oqim farqlanadi.
- Akkauntning faol, taklif yuborilgan, o‘chirilgan yoki arxivlangan holati kirishga ta’sir qiladi.

## 3. To‘rtta asosiy rol

- Administrator: o‘z tashkilotidagi xodimlar, jamoalar, trening, AI Practice, kutubxona va umumiy sozlamalarni boshqaradi.
- Supervisor: biriktirilgan xodimlari va jamoasi bilan ishlaydi. Boshqa rahbarning xodimlari uchun ruxsat avtomatik berilmaydi. Setup uchun Admin beradigan qo‘shimcha huquqlar mavjud.
- Travel Agent: o‘z treninglari, mashqlari, natijalari, Setup’i va ko‘nikmalari bilan ishlaydi.
- Flight Expert: o‘ziga mos texnik va aviatsiya bilimlari yo‘nalishidagi treninglar, Setup va ko‘nikmalar bilan ishlaydi.

Admin va Supervisorning o‘ziga ham trening biriktirish mumkin. Rol almashgani barcha materiallar yoki maxfiy ma’lumotlarga cheksiz kirish degani emas.

## 4. Dashboard va asosiy navigatsiya

Dashboard ish holatining boshlang‘ich ko‘rinishini beradi: biriktirilgan, bajarilayotgan, tugallangan va qayta topshirish kerak bo‘lgan treninglar hamda e’tibor talab qiladigan ma’lumotlar.

Asosiy menyu: Dashboard, My Training, Library. Admin uchun AI Practice ham mavjud. Boshqaruv menyusida Employees & Teams, Training va Settings & Security joylashadi. Company Standards & Workflow va SpaceZero AI alohida bo‘limlar sifatida ochiladi.

Yuqoridagi akkaunt menyusidan profil, shaxsiy Setup, ta’til va akkauntga oid sahifalarga o‘tiladi. Qorong‘i/yorug‘ mavzuni almashtirish mumkin. Yangilash paytida logotip, 0–100% progress va Crafted by UZLEEDER yozuvi bilan intro chiqadi; bu trening bajarilish foizi emas.

## 5. Employees & Teams

Admin shu bo‘limda xodim qidiradi, rol, employment status, jamoa, rahbar, Setup holati va yetishmayotgan band bo‘yicha filtrlaydi. Filtrlar va ustun sarlavhalari scroll vaqtida tepada saqlanadi.

Xodimni ochganda Overview, Setup, Training, Skills, Vacation / Leave, Activity va ruxsatga qarab Credentials bo‘limlari mavjud. Xodim ma’lumotini tahrirlash, rol yoki rahbarini o‘zgartirish, akkauntni disable/reactivate/archive qilish kabi amallar shu boshqaruv oqimida bajariladi.

Teams jamoalarni tashkil qilish uchun ishlatiladi. Supervisorning ko‘rish chegarasi haqiqiy biriktirishlarga bog‘liq; faqat profilga rol yozish jamoa biriktirish o‘rnini bosmaydi.

Download Excel joriy filtrdan qat’i nazar, ko‘rishga ruxsat etilgan xodimlarni yuklaydi. Employees va Admins varaqlari alohida; ism, username, rol va alohida berilgan eksport paroli ustunlari bor. Admins varag‘iga kelishilgan admin/test profillari ham kiritilgan. Eksportda parol bo‘lishi uning amaldagi kirish paroli ekanini tekshirmaydi: asl akkaunt parollari xesh ko‘rinishida saqlanadi, faqat alohida taqdim qilingan eksport qiymatlari chiqariladi. Qiymati berilmagan qatorlar bo‘sh qoladi. Ushbu xatga parollar yoki xodimlar jadvali ilova qilinmagan.

## 6. Employee Setup — ishga tayyorlik

Setup bir xil ma’lumot manbasiga ega. Xodim o‘z roliga tegishli talablarni ko‘radi: masalan, ish qurilmasi, zarur tizimlar yoki aloqa vositalari. Talablar Admin tomonidan sozlanadi; nomlar qat’iy cheklanmagan.

Xodim uchun odatiy oqim:
- Kerakli bandlarda I Have yoki I Don’t Have tanlanadi.
- I Don’t Have uchun nima yetishmayotgani haqida qisqa izoh yoziladi.
- Bir nechta o‘zgarish bitta Save Changes orqali saqlanadi.

I Have har doim management verification degani emas. Employee confirmation yetarli bo‘lgan talab tugallanishi mumkin; management verification talab qilingan band esa rahbar tasdig‘ini kutadi. Management-only va haqiqiy ma’lumotlardan hisoblanadigan talablar oddiy self-confirmation orqali tugatilmaydi.

Admin odatiy checklistda bir nechta bandni tanlab, bir marta saqlaydi. Qo‘shimcha status va izohlar ••• orqali ochiladi. Company-controlled raqamlar, hisoblanadigan bandlar va maxsus holatlar uchun qo‘shimcha tafsilotlar kerak bo‘lishi mumkin. Mavjud izohlar, tasdiqlash tarixi va istisnolar oddiy checkbox bilan yo‘qotilmasligi kerak.

Setup requirements orqali Admin yangi talab yaratadi, tahrirlaydi, arxivlaydi, kategoriya, majburiy/ixtiyoriy holat, tegishli rollar va verification qoidasini belgilaydi. Bir nechta turli GDS yoki system access talablari alohida yaratilishi mumkin. Archived talab bilan mavjud tarixni o‘chirish bir xil amal emas.

## 7. Supervisor permissions

Yo‘l: Settings & Security → Supervisor permissions → kerakli Supervisor.

Hozirgi alohida boshqaruv huquqlari:
- View Team Setup — o‘z jamoasining Setup’ini ko‘rish.
- Manage Team Setup — checklist va tafsilotlarni boshqarish.
- Verify Team Setup — management verification talab qiladigan bandni tasdiqlash.

Supervisor ish oqimi uchun kerakli kombinatsiyani Admin belgilab, Save Permissions bosadi. To‘liq Setup boshqaruvi uchun uchala huquq ham kerak bo‘lishi mumkin. Huquqni bekor qilish keyingi so‘rovlarga ta’sir qiladi; sahifani ochish huquqni qayta yaratmaydi.

Bu huquqlar jamoa chegarasini kengaytirmaydi. Supervisor o‘ziga huquq bera olmaydi va global Setup talablarini o‘zgartira olmaydi. Muhim aniqlik: ushbu ekran hozir Setup huquqlarini boshqaradi; Training, Skills va Leave uchun umumiy yangi permission builder tugallangan deb hisoblamang — ularning mavjud rol, jamoa va policy tekshiruvlari alohida ishlaydi.

## 8. My Training — xodimning o‘qish jarayoni

Xodim o‘ziga biriktirilgan treninglarni ochadi, materiallar bilan tanishadi, kerakli mashq va assessmentlarni bajaradi. Holatlar orqali ish boshlanmaganini, davom etayotganini, tugallanganini yoki retake talab qilinishini kuzatadi.

Majburiy video/audio uchun materialni kerakli tartibda ko‘rish/tinglash sharti mavjud bo‘lishi mumkin. Faqat sahifani ochish barcha talablarni tugatmaydi. Natija kursdagi passing score, kerakli urinishlar va tegishli assessment shartlariga bog‘liq.

Training boshqaruv bo‘limi Admin/Supervisor uchun tasdiqlangan katalog va assignments oqimidir. Kursning ruxsatlari va foydalanuvchi vakolatiga qarab trening alohida xodimga, jamoaga yoki tegishli guruhga biriktiriladi. My Training esa o‘sha topshiriqlarni bajarish joyi.

## 9. AI Practice — materialdan mashqqacha

AI Practice hozir Admin uchun yaratilgan ish maydoni. Bu xodimning tayyor topshiriqlar ro‘yxati bilan bir xil sahifa emas.

Amaliy ketma-ketlik:
1. Upload Material orqali qo‘ng‘iroq, video, audio yoki qo‘llab-quvvatlanadigan hujjat/material qo‘shiladi.
2. Material ochilib, tahlil ishga tushiriladi. Faylni yuklash bilan barcha keyingi ishlar avtomatik tugallangan hisoblanmaydi.
3. Tahlil natijalari, manbalar, asosiy bilimlar va ko‘nikmalar ko‘rib chiqiladi.
4. Tegishli practice yaratiladi. Materialga qarab savollar, vaziyatli mashqlar, role-play yoki amaliy jarayonlar qo‘llanadi.
5. Admin matn, savollar va kutilgan natijani tekshiradi; zarur joyni tahrirlaydi yoki qayta yaratadi.
6. Tasdiqlangan paket Send to Training orqali trening oqimiga o‘tkaziladi.
7. Shundan keyin tegishli xodimlarga biriktiriladi va natijalar kuzatiladi.

AI xulosasi management tasdig‘ini almashtirmaydi. Xato yoki yetarli asos bo‘lmasa, avval manba va natija tekshiriladi. Ishlash tezligi material hajmi, AI xizmati va serverdagi ishchi jarayonlarga bog‘liq. Xom qo‘ng‘iroqlar avtomatik ravishda umumiy Library materiali bo‘lib qolmaydi.

## 10. Skill Graph / Skill DNA

Skill Graph kurslar sonidan ko‘ra xodimning ko‘nikmalariga e’tibor beradi. Baholash dalillari, ishonchlilik, tarix va mavjud natijalar asosida kuchli/zaif yo‘nalishlar ko‘rsatiladi. Dalil yetarli bo‘lmasa, yuqori foizni qat’iy tasdiqlangan mahorat deb qabul qilmang.

Travel Agent va Flight Expert uchun mos ko‘nikmalar farqlanadi. Masalan, savdo muloqoti va objection handling bir yo‘nalish, fare rules yoki routing esa boshqa yo‘nalish bo‘lishi mumkin.

Rahbar uchun to‘g‘ri foydalanish: zaif ko‘nikmani aniqlash → tegishli practice/treningni tanlash → natijani tekshirish → keyingi dalillar va o‘zgarishni kuzatish. Mavjud Intelligence, Development va Certifications sahifalari shu ma’lumotlar bilan bog‘liq boshqaruv ko‘rinishlarini beradi; natijalar tegishli ma’lumotlar va sozlamalar bo‘lgandagina mazmunli bo‘ladi.

## 11. Library, Notes va Company Standards

Library — ma’lumotnoma va qayta murojaat qilish uchun bilimlar kutubxonasi. Qidiruv, kategoriyalar va tanlangan materiallar orqali kerakli bilim topiladi. Library’ni ochish majburiy treningni tugatish bilan teng emas. Materialni ko‘rish/yuklash huquqi rol va tegishli ruxsatlarga bog‘liq.

Notes — tegishli learner rollari uchun shaxsiy qaydlar. Uni umumiy kompaniya siyosatlari yoki boshqalarning maxfiy ma’lumotlarini tarqatish joyi deb ishlatmang.

Company Standards & Workflow — kompaniya tamoyillari, mas’uliyatlar va ish jarayonlari. Qidiruv va Quick Reference kundalik qoidalarni topishga yordam beradi. Admin Manage orqali kontentni boshqaradi. Acknowledgement talab qilingan materiallarda tanishganlikni tasdiqlash va bu holatni kuzatish oqimi mavjud.

## 12. SpaceZero AI yordamchisi

SpaceZero AI platformadagi mavjud ma’lumotlar bo‘yicha savollarga javob berishga mo‘ljallangan. Misollar: “Who isn’t fully set up?”, “Who has overdue training?”, “Who needs a retake?” yoki “What requires my attention today?”.

Yordamchi read-only: savol berish xodim rolini, treningni yoki Setup holatini avtomatik o‘zgartirish degani emas. Javob ko‘rishga ruxsat etilgan ma’lumotlar doirasi bilan cheklanishi kerak. Yetarli ma’lumot bo‘lmasa, tizim ishonchli javob topilmaganini bildiradi. AI Practice esa boshqa vazifa — materialdan amaliy mashq yaratish uchun ishlatiladi.

## 13. Leave, Credentials, Notifications va Audit

- Vacation / Leave: xodim ta’til so‘rovini yuboradi; rahbar/Admin mavjud ruxsat va policy asosida ko‘rib chiqadi. Yakuniy tasdiqlash vakolati tegishli sozlamalarga bog‘liq.
- Credentials: ish tizimlari uchun alohida maxfiy ma’lumotlar ombori. Bu akkauntning login parolini ko‘rsatish sahifasi emas. Ko‘rish huquqi va maxfiy qiymatni ochish tekshiruvi alohida.
- Notifications: tegishli topshiriq va voqealarni kuzatish uchun.
- Security & Audit: muhim boshqaruv va ruxsat amallarini tekshirish uchun. Audit yozuvlari parollarni oshkor qilish uchun ishlatilmaydi.
- View as: Admin uchun mavjud sinov/ko‘rinish almashtirish oqimi. Boshqa rol ko‘rinishida bo‘lish barcha xavfsizlik cheklovlarini bekor qilmaydi.

## 14. Admin uchun tavsiya etilgan ish tartibi

Boshlang‘ich tayyorlash: xodimlar va rollarni tekshirish → jamoa/rahbarlarni biriktirish → Setup talablarini sozlash → kerakli Supervisor Setup huquqlarini berish → takliflarni yuborish → aktivatsiya va Setup’ni kuzatish.

Trening sikli: materialni tayyorlash → AI Practice’da tahlil va mashq yaratish → Admin tekshiruvi → Send to Training → assignment → natija va retake → Skill Graph orqali rivojlanishni kuzatish.

Kundalik nazorat: bajarilmagan Setup, ochiq muammolar, muddati o‘tgan trening, retake, ta’til so‘rovlari va tasdiqlanmagan majburiy standartlarni ko‘rib chiqish.

## 15. Email va ishga tushirish holati

Email jo‘natuvchi Resend orqali SpaceZero Workspace <noreply@spacezero.uz> qilib sozlangan. Aktivatsiya va reset email havolalari https://workspace.spacezero.uz manziliga yo‘naltiriladi. Yuborish xizmatining xatni qabul qilishi bilan Inbox’ga yetib kelishi alohida bosqichlar; zarur bo‘lsa Spam va Resend delivery holati tekshiriladi.

Ushbu qo‘llanma ommaviy domenning barcha server, database va AI jarayonlari yakuniy production tekshiruvidan o‘tganini tasdiqlamaydi. Lokal localhost faqat shu kompyuterdagi serverga ishora qiladi. Xodimlarga ommaviy havola berishdan oldin workspace.spacezero.uz’da kirish, aktivatsiya, materiallar va background AI ishlari amalda tekshirilishi kerak. Alohida HTML demo esa dizaynni ko‘rsatish uchun; unda haqiqiy akkauntlar va backend yo‘q.

Hurmat bilan,
SpaceZero Workspace
Crafted by UZLEEDER
