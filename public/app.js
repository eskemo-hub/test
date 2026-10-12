// Client-side glue for the auth demo. Loaded by every page.
//
// Responsibilities:
//   - Submit register/login forms via fetch, render server messages inline,
//     redirect to /dashboard.html on success.
//   - On protected pages (dashboard.html), call /api/me on load and redirect
//     to /login.html if not signed in.
//   - Wire the "Sign out" buttons in navs and the dashboard.

(function () {
  'use strict';

  function $(id) {
    return document.getElementById(id);
  }

  function setMessage(el, text, kind) {
    if (!el) return;
    el.textContent = text || '';
    el.classList.remove('is-success', 'is-error');
    if (kind === 'success') el.classList.add('is-success');
    if (kind === 'error') el.classList.add('is-error');
  }

  // ---------- Auth API helpers ----------

  async function postJSON(url, body) {
    var res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    var data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    return { status: res.status, data: data };
  }

  async function logout() {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = './login.html';
  }

  async function refreshAuthNav() {
    // Swap the nav items based on whether the user is signed in. Quietly
    // tolerates 401s — if /api/me fails, treat as signed out.
    try {
      var res = await fetch('/api/me', { credentials: 'same-origin' });
      var signedIn = res.ok;
    } catch (e) {
      var signedIn = false;
    }

    var nodes = document.querySelectorAll('[data-auth]');
    for (var i = 0; i < nodes.length; i++) {
      var want = nodes[i].getAttribute('data-auth');
      var show = want === 'signed-in' ? signedIn : !signedIn;
      if (show) {
        nodes[i].removeAttribute('hidden');
      } else {
        nodes[i].setAttribute('hidden', '');
      }
    }
  }

  // ---------- Page handlers ----------

  function wireLoginForm() {
    var form = $('login-form');
    if (!form) return;
    var msg = $('form-message');
    var btn = $('submit-btn');

    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      setMessage(msg, '', null);
      btn.disabled = true;
      try {
        var payload = {
          email: form.email.value.trim(),
          password: form.password.value,
        };
        var out = await postJSON('/api/login', payload);
        if (out.status === 200) {
          window.location.href = './dashboard.html';
          return;
        }
        setMessage(msg, (out.data && out.data.error) || 'Sign in failed.', 'error');
      } catch (err) {
        setMessage(msg, 'Network error — please try again.', 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }

  function wireRegisterForm() {
    var form = $('register-form');
    if (!form) return;
    var msg = $('form-message');
    var btn = $('submit-btn');

    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      setMessage(msg, '', null);

      var email = form.email.value.trim();
      var password = form.password.value;

      if (password.length < 8) {
        setMessage(msg, 'Password must be at least 8 characters.', 'error');
        return;
      }

      btn.disabled = true;
      try {
        var out = await postJSON('/api/register', { email: email, password: password });
        if (out.status === 200) {
          window.location.href = './dashboard.html';
          return;
        }
        setMessage(msg, (out.data && out.data.error) || 'Could not create account.', 'error');
      } catch (err) {
        setMessage(msg, 'Network error — please try again.', 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }

  function wireSignOutButtons() {
    var btns = document.querySelectorAll('#nav-signout, #signout-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function (ev) {
        ev.preventDefault();
        logout();
      });
    }
  }

  async function loadDashboard() {
    var info = $('user-info');
    if (!info) return;

    try {
      var res = await fetch('/api/me', { credentials: 'same-origin' });
      if (res.status === 401) {
        window.location.href = './login.html';
        return;
      }
      var data = await res.json();
      info.innerHTML =
        '<p class="user-label">Signed in as</p>' +
        '<p class="user-email">' + escapeHtml(data.email) + '</p>' +
        '<p class="user-id muted">User #' + escapeHtml(String(data.id)) + '</p>';
    } catch (err) {
      window.location.href = './login.html';
    }
  }

  // Minimal HTML escape — used only for user-controlled values we render.
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---------- Boot ----------
  document.addEventListener('DOMContentLoaded', function () {
    refreshAuthNav();
    wireLoginForm();
    wireRegisterForm();
    wireSignOutButtons();
    loadDashboard();
  });
})();