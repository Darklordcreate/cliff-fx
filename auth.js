let authMode = 'signin';

document.addEventListener('DOMContentLoaded', initAuthPage);

async function initAuthPage() {
  // If there's already a valid session, don't even show the sign-in form.
  const { data } = await supa.auth.getSession();
  if (data.session) {
    window.location.replace('app.html');
    return;
  }
  wireAuthForm();
}

function wireAuthForm() {
  const form = document.getElementById('auth-form');
  const toggle = document.getElementById('auth-toggle');
  const submitBtn = document.getElementById('auth-submit');

  toggle.addEventListener('click', () => {
    authMode = authMode === 'signin' ? 'signup' : 'signin';
    submitBtn.textContent = authMode === 'signin' ? 'Sign in' : 'Create account';
    toggle.textContent = authMode === 'signin' ? 'Need an account? Sign up' : 'Have an account? Sign in';
    hideAuthError();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAuthError();
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;

    submitBtn.disabled = true;
    try {
      const { data, error } = authMode === 'signin'
        ? await supa.auth.signInWithPassword({ email, password })
        : await supa.auth.signUp({ email, password });

      if (error) throw error;

      if (authMode === 'signup' && !data.session) {
        showAuthError('Check your email to confirm your account, then sign in.');
        submitBtn.disabled = false;
        return;
      }

      // Only the auth page itself knows the app lives at app.html — nothing
      // about the app's structure is present here until this redirect fires.
      window.location.replace('app.html');
    } catch (err) {
      showAuthError(err.message || 'Something went wrong.');
      submitBtn.disabled = false;
    }
  });
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideAuthError() {
  document.getElementById('auth-error').classList.add('hidden');
}
