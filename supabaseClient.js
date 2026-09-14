// Shared Supabase client. Loaded after the supabase-js CDN script on every page.
const SUPABASE_URL = 'https://qepjeigzkzzvipgisvza.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFlcGplaWd6a3p6dmlwZ2lzdnphIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgxMTY4NDYsImV4cCI6MjEwMzY5Mjg0Nn0.twe88yxByRxWPwFjoLsk1t0S6oYzh646zHyka63Amfo';
const supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
