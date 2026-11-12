// Settings for your deployment. The publishable key is public by design:
// what each person can read or change is enforced by the database rules
// in supabase/schema.sql, not by keeping this key secret.
window.TEAM_TASKS_CONFIG = {
  // Supabase Dashboard → Settings → API Keys
  // Use the "publishable" key (sb_publishable_...) — or the legacy "anon" key.
  // Never put the secret / service_role key here.
  supabaseUrl: 'https://wbwwzbqsoqhqkrgipjiw.supabase.co',
  supabaseKey: 'sb_publishable_VW70EXKaBchzOowFlPVk9A_Yc8iTMOK',

  // Shown in the header and browser tab
  appTitle: 'مهام فريق الإسناد',

  // Optional: your company's Google Workspace domain (e.g. 'example.com').
  // Google then offers company accounts first on the sign-in screen.
  googleHostedDomain: 'one1.sa'
};
