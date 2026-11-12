# مهام الفريق · Team Tasks

تطبيق ويب بسيط ومفتوح المصدر لمتابعة مهام فريق صغير:

- **كل موظف** يسجّل مهامه ويتابعها بثلاث مراحل: بالانتظار ← جاري العمل عليه ← منتهي.
- **التحدي:** إذا واجه الموظف تحدي ما يقدر يحله، يكتبه ويرسله للمدير. إذا حلّه المدير، يظهر للموظف "تم حل التحدي" مع رد المدير.
- **المدير** يشوف الكل:
  - "يحتاج تدخلك": التحديات المرسلة له والمهام المتأخرة.
  - جدول الفريق.
  - لوحة المهام لكل موظف.
- **العزل حقيقي:** الموظف ما يقدر يشوف مهام غيره، والقاعدة نفسها هي اللي تمنعه، مو مجرد إخفاء في الواجهة.
- **الدخول** بحساب Google حق الشركة، والتحديث مباشر بدون إعادة تحميل.

> A small, open-source task tracker for a team lead and their staff. Employees log their own tasks and escalate blockers; the manager sees everyone. Static front end + Supabase (Postgres row-level security, Google sign-in, realtime). Arabic, RTL. English setup notes are at the end.

---

## من وش يتكوّن

| الجزء | وين يشتغل | التكلفة |
|---|---|---|
| الواجهة (`index.html`, `assets/`, `config.js`) | GitHub Pages أو أي استضافة ملفات ثابتة | مجاني |
| قاعدة البيانات والدخول والتحديث المباشر | [Supabase](https://supabase.com) | الخطة المجانية تكفي فريق صغير |
| تسجيل الدخول | حساب Google (Google Workspace حق الشركة) | مجاني |

الصلاحيات كلها مكتوبة في `supabase/schema.sql` (Row Level Security).

---

## الإعداد خطوة بخطوة (مرة وحدة، تقريبًا ٣٠ دقيقة)

### ١. المستودع على GitHub
1. سوّ حساب على [github.com](https://github.com) إذا ما عندك.
2. أنشئ مستودع جديد (مثلًا `team-tasks`) وارفع عليه ملفات هذا المشروع.
3. من **Settings → Pages**، خلّ **Source** على **GitHub Actions**.
4. كل تعديل ينرفع على فرع `main` ينشر الموقع تلقائيًا، ويكون الرابط بالشكل `https://<اسم-الحساب>.github.io/team-tasks/`.

### ٢. مشروع Supabase
1. سوّ حساب على [supabase.com](https://supabase.com) وأنشئ مشروع جديد.
2. افتح **SQL Editor → New query**، والصق محتوى `supabase/schema.sql` كامل، وشغّله.
3. في استعلام جديد، أضف نفسك كمدير بإيميلك في الشركة:
   ```sql
   insert into public.members (name, email, role)
   values ('اسمك', 'your.name@company.com', 'manager');
   ```
4. من **Settings → API Keys** انسخ:
   - **Project URL**
   - **Publishable key**
   - ⚠️ لا تنسخ الـ secret key أبدًا.

### ٣. تسجيل الدخول بـ Google
1. في [Google Cloud Console](https://console.cloud.google.com) أنشئ مشروع، وافتح **Google Auth Platform**:
   - **Audience:** اختر **Internal** إذا شركتكم على Google Workspace. كذا ما يقدر يدخل إلا أصحاب إيميلات الشركة.
   - **Clients → Create client → Web application**:
     - **Authorized JavaScript origins:** رابط موقعك، مثل `https://<اسم-الحساب>.github.io`.
     - **Authorized redirect URIs:** رابط الـ callback اللي يعطيك إياه Supabase في الخطوة الجاية، وشكله `https://<project>.supabase.co/auth/v1/callback`.
2. في Supabase، من **Authentication → Providers → Google**: فعّله، والصق Client ID وClient Secret.
3. ⚠️ **مهم للأمان:** من نفس صفحة Providers، **عطّل Email** (الدخول بالإيميل وكلمة المرور). التطبيق يعتمد على إن الإيميل موثّق من Google.
4. من **Authentication → URL Configuration**:
   - خلّ **Site URL** هو رابط موقعك.
   - أضفه في **Redirect URLs**.

### ٤. ربط الواجهة
عدّل `config.js`:
```js
supabaseUrl: 'https://<project>.supabase.co',
supabaseKey: 'sb_publishable_...',
appTitle: 'مهام فريق الإسناد',
googleHostedDomain: 'company.com'   // اختياري
```
ارفع التعديل على `main`، وبعد دقيقة الموقع يشتغل.

### ٥. إضافة الفريق
1. ادخل للتطبيق بحسابك.
2. من زر **"أسماء الفريق"** أضف اسم كل موظف وإيميله في الشركة.
3. أرسل لهم الرابط. كل واحد يدخل بحساب Google على نفس الإيميل، ويشوف مهامه بس.

### على الجوال
افتح الرابط من الجوال، ومن قائمة المتصفح اختر **"إضافة إلى الشاشة الرئيسية"**. يطلع للتطبيق أيقونة وينفتح كأنه تطبيق.

---

## تجربة بدون إعداد
افتح الموقع وأضف `?demo` للرابط، أو اضغط **"شاهد مثال تجريبي"**. يعرض بيانات وهمية لشاشة المدير وشاشة الموظف، وما ينحفظ فيه شي.

## الخصوصية
- الكود عام، أما البيانات (الأسماء والإيميلات والمهام) فتبقى في قاعدة بياناتكم على Supabase، وما توصل لها إلا الحسابات المضافة.
- لا ترفع على المستودع أي ملف فيه أسماء أو إيميلات حقيقية. ملف `.gitignore` يستبعد ملفات `seed*.sql`.
- المفتاح اللي في `config.js` عام بطبيعته، والحماية تجي من قواعد قاعدة البيانات.

## تحديث قاعدة البيانات لاحقًا
إذا تغيّر `supabase/schema.sql` في تحديث، شغّله مرة ثانية في SQL Editor. الملف آمن للتكرار، وما يحذف أي بيانات.

---

## English quick start

1. **Supabase:** create a project, run `supabase/schema.sql` in the SQL editor, then insert yourself as manager (`insert into public.members (name,email,role) values ('You','you@company.com','manager');`).
2. **Google sign-in:**
   - Create a Web OAuth client in Google Cloud. Set Audience to *Internal* for Workspace-only.
   - Add the Supabase callback URL as a redirect URI.
   - Enable the Google provider in Supabase.
   - **Disable the Email provider**: access control relies on Google-verified e-mails.
   - Set the Site URL and redirect URLs.
3. **Front end:** put the project URL and publishable key in `config.js`. Enable GitHub Pages with *GitHub Actions* as the source; `.github/workflows/pages.yml` deploys on every push to `main`.
4. **Team:** sign in, open "أسماء الفريق" and add each employee's name and company e-mail.

**How access works:**
- `members` maps company e-mails to roles.
- `my_member_id()` and `is_manager()` read the signed-in e-mail from the JWT.
- RLS policies give employees only their own `tasks`, `comments` and `task_log` rows, and give the manager everything.
- A trigger stops employees from marking a challenge as solved by the manager.

License: MIT.
