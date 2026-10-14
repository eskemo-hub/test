// Client-side glue for the auth demo. Loaded by every page.
//
// Responsibilities:
//   - Submit register/login forms via fetch, render server messages inline,
//     redirect to /dashboard.html on success.
//   - On protected pages (dashboard.html), call /api/me on load and redirect
//     to /login.html if not signed in.
//   - Render the dashboard layout (profile + notes + optional admin stats).
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

  // Minimal HTML escape — used only for user-controlled values we render.
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---------- API helpers ----------

  async function getJSON(url) {
    var res = await fetch(url, { credentials: 'same-origin' });
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { status: res.status, data: data };
  }

  async function postJSON(url, body) {
    var res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { status: res.status, data: data };
  }

  async function patchJSON(url, body) {
    var res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { status: res.status, data: data };
  }

  async function deleteJSON(url) {
    var res = await fetch(url, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    return { status: res.status };
  }

  // Global 401 → redirect to login. Returns true when it redirected.
  function maybeRedirectOn401(status) {
    if (status === 401) {
      window.location.href = './login.html';
      return true;
    }
    return false;
  }

  // ---------- Formatters ----------

  function initialsFor(email) {
    if (typeof email !== 'string' || email.length === 0) return '?';
    var local = email.split('@')[0] || email;
    var cleaned = local.replace(/[^A-Za-z0-9]/g, '');
    if (cleaned.length === 0) return (local[0] || '?').toUpperCase();
    return cleaned.slice(0, 2).toUpperCase();
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function formatDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function formatRelative(iso) {
    if (!iso) return 'never';
    var then = new Date(iso).getTime();
    if (isNaN(then)) return '';
    var diff = Date.now() - then;
    if (diff < 0) return 'just now';
    var sec = Math.floor(diff / 1000);
    if (sec < 45) return 'just now';
    var min = Math.floor(sec / 60);
    if (min < 60) return min + ' min ago';
    var hr = Math.floor(min / 60);
    if (hr < 24) return hr + ' hr ago';
    var day = Math.floor(hr / 24);
    if (day < 7) return day + ' day' + (day === 1 ? '' : 's') + ' ago';
    return formatDate(iso);
  }

  function absoluteForTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString();
  }

  // ---------- Auth flows ----------

  async function logout() {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
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

  // ---------- Forgot / reset / verify pages ----------

  function paramFromUrl(name) {
    var qs = window.location.search.replace(/^\?/, '');
    if (!qs) return '';
    var parts = qs.split('&');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split('=');
      if (decodeURIComponent(kv[0]) === name) {
        return decodeURIComponent((kv[1] || '').replace(/\+/g, '%20'));
      }
    }
    return '';
  }

  function wireForgotForm() {
    var form = $('forgot-form');
    if (!form) return;
    var msg = $('form-message');
    var btn = $('submit-btn');

    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      setMessage(msg, '', null);
      btn.disabled = true;
      try {
        var out = await postJSON('/api/password/reset/request', {
          email: form.email.value.trim(),
        });
        // Always succeed from the user's perspective — same response whether
        // the email is registered or not.
        if (out.status === 200) {
          var text = "If an account exists for that email, we've sent a reset link.";
          var link = out.data && out.data.link;
          if (link) {
            // Dev mode: surface the link so the demo flow is testable
            // without an SMTP relay.
            text += ' Dev link: ' + link;
          }
          setMessage(msg, text, 'success');
          form.reset();
        } else {
          setMessage(msg, (out.data && out.data.error) || 'Could not request reset.', 'error');
        }
      } catch (err) {
        setMessage(msg, 'Network error — please try again.', 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }

  function wireResetForm() {
    var form = $('reset-form');
    if (!form) return;
    var msg = $('form-message');
    var btn = $('submit-btn');
    var errBlock = $('reset-error');

    var token = paramFromUrl('token');
    if (!token) {
      // No token in the URL — show the "request a new link" path instead of
      // letting the user fill in a form that will 400 anyway.
      if (form) form.setAttribute('hidden', '');
      if (errBlock) errBlock.removeAttribute('hidden');
      var errMsg = $('reset-error-msg');
      if (errMsg) errMsg.textContent = 'This reset link is invalid or has expired.';
      return;
    }

    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      setMessage(msg, '', null);
      var newPwd = form.newPassword.value;
      var confirm = form.confirmPassword.value;
      if (newPwd.length < 8) {
        setMessage(msg, 'New password must be at least 8 characters.', 'error');
        return;
      }
      if (newPwd !== confirm) {
        setMessage(msg, 'New password and confirmation do not match.', 'error');
        return;
      }
      btn.disabled = true;
      try {
        var out = await postJSON('/api/password/reset/confirm', {
          token: token,
          newPassword: newPwd,
        });
        if (out.status === 200) {
          // Drop any cached state; the new password invalidates old sessions.
          try { window.localStorage.clear(); } catch (e) { /* ignore */ }
          window.location.href = './login.html?reset=ok';
          return;
        }
        setMessage(msg, (out.data && out.data.error) || 'Could not update password.', 'error');
        btn.disabled = false;
      } catch (err) {
        setMessage(msg, 'Network error — please try again.', 'error');
        btn.disabled = false;
      }
    });
  }

  function wireVerifyPage() {
    var title = $('title');
    var sub = $('sub');
    var foot = $('auth-foot');
    var msg = $('form-message');
    if (!title || !sub) return;

    var token = paramFromUrl('token');
    if (!token) {
      title.textContent = 'Verification link';
      sub.textContent = 'This link is missing a token. Request a new one from your dashboard.';
      if (foot) foot.removeAttribute('hidden');
      return;
    }

    setMessage(msg, 'Verifying…', null);
    postJSON('/api/email/verify/confirm', { token: token }).then(function (out) {
      if (out.status === 200) {
        title.textContent = 'Email verified';
        sub.textContent = 'Your email is now verified. Redirecting to your dashboard…';
        setMessage(msg, '', null);
        if (foot) foot.removeAttribute('hidden');
        // Redirect with a flash flag the dashboard can pick up.
        setTimeout(function () {
          window.location.href = './dashboard.html?verified=ok';
        }, 600);
      } else {
        title.textContent = 'Verification failed';
        sub.textContent = 'This link has expired or was already used. You can resend a new one from your dashboard.';
        setMessage(msg, (out.data && out.data.error) || 'Verification failed.', 'error');
        if (foot) foot.removeAttribute('hidden');
      }
    }).catch(function () {
      title.textContent = 'Verification failed';
      sub.textContent = 'Network error. Please try again from your dashboard.';
      setMessage(msg, 'Network error — please try again.', 'error');
      if (foot) foot.removeAttribute('hidden');
    });
  }

  function wireLoginFlash() {
    // /login.html?reset=ok is set by reset.html after a successful change.
    // Surface a one-time success line above the form.
    var form = $('login-form');
    if (!form) return;
    if (paramFromUrl('reset') !== 'ok') return;
    var msg = $('form-message');
    if (msg) {
      setMessage(msg, 'Password updated. Please sign in with your new password.', 'success');
    }
  }

  function wireVerifyFlash() {
    // /dashboard.html?verified=ok is set by verify.html after a successful
    // confirmation. The verify-banner hides itself because email_verified is
    // now true, so we surface a one-time success line in #profile-message
    // (the form-message slot the dashboard already uses).
    var msg = $('profile-message');
    if (!msg) return;
    if (paramFromUrl('verified') !== 'ok') return;
    setMessage(msg, 'Email verified.', 'success');
    try {
      var cleanUrl = window.location.pathname + window.location.hash;
      window.history.replaceState(null, '', cleanUrl);
    } catch (e) { /* ignore */ }
  }

  // ---------- Verify banner + security panel ----------

  function renderVerifyBanner(user) {
    var banner = $('verify-banner');
    if (!banner) return;
    if (user && user.email_verified === false) {
      banner.removeAttribute('hidden');
      wireVerifyBanner();
    } else {
      banner.setAttribute('hidden', '');
    }
  }

  function wireVerifyBanner() {
    var btn = $('verify-banner-btn');
    if (!btn) return;
    btn.addEventListener('click', async function () {
      btn.disabled = true;
      try {
        var out = await postJSON('/api/email/verify/request', {});
        if (maybeRedirectOn401(out.status)) return;
        if (out.status === 200) {
          var link = out.data && out.data.link;
          var linkEl = $('verify-banner-link');
          if (link && linkEl) {
            linkEl.innerHTML = '';
            linkEl.appendChild(document.createTextNode('Dev link: '));
            var a = document.createElement('a');
            a.href = link;
            a.textContent = link;
            a.target = '_blank';
            a.rel = 'noopener';
            linkEl.appendChild(a);
            linkEl.removeAttribute('hidden');
          }
        } else if (out.status === 429) {
          // Quiet — the user can try again in a minute.
        }
      } catch (e) {
        // Banner is informational; do not flash an error here.
      } finally {
        btn.disabled = false;
      }
    });
  }

  // Human-readable label for a security event type. Falls back to the raw
  // snake_case token when a type slips in that we haven't named yet.
  function eventTypeLabel(type) {
    var map = {
      register: 'Account created',
      login: 'Signed in',
      login_failed: 'Sign-in failed',
      logout: 'Signed out',
      sign_out_everywhere: 'Signed out everywhere',
      change_password: 'Password changed',
      password_reset_request: 'Password reset requested',
      password_reset_confirm: 'Password reset confirmed',
      email_verify_request: 'Verification email requested',
      email_verify_confirm: 'Email verified',
    };
    return map[type] || type;
  }

  function renderSecuritySection(events) {
    var wrap = el('section', { class: 'security-section' });
    wrap.appendChild(el('p', { class: 'panel-eyebrow', text: 'Account' }));
    wrap.appendChild(el('h2', { class: 'section-heading', text: 'Security' }));

    var list = el('div', { class: 'events-list', id: 'events-list' });
    if (!events || events.length === 0) {
      list.appendChild(el('p', { class: 'events-empty muted', text: 'No security events yet.' }));
    } else {
      events.forEach(function (ev) {
        var row = el('article', { class: 'event-row' });
        var left = el('div', { class: 'event-row-left' }, [
          el('p', { class: 'event-row-type', text: eventTypeLabel(ev.type) }),
          el('p', { class: 'event-row-meta muted' }, [
            document.createTextNode(formatRelative(ev.created_at) + ' '),
            el('time', {
              datetime: ev.created_at,
              title: absoluteForTime(ev.created_at),
              text: '(' + absoluteForTime(ev.created_at) + ')',
            }),
          ]),
        ]);
        var right = el('div', { class: 'event-row-meta muted' });
        if (ev.ip) right.appendChild(document.createTextNode(ev.ip));
        if (ev.ip && ev.user_agent) right.appendChild(document.createTextNode(' · '));
        if (ev.user_agent) right.appendChild(document.createTextNode(ev.user_agent));
        row.appendChild(left);
        row.appendChild(right);
        list.appendChild(row);
      });
    }
    wrap.appendChild(list);
    return wrap;
  }

  // ---------- Dashboard render ----------

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k === 'hidden' && attrs[k]) node.setAttribute('hidden', '');
        else if (k.indexOf('on') === 0) node[k] = attrs[k];
        else node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      if (typeof c === 'string') node.appendChild(document.createTextNode(c));
      else node.appendChild(c);
    });
    return node;
  }

  function renderProfile(user) {
    var card = el('section', { class: 'profile-card' });
    var subBadge;
    if (user.subscription && user.subscription.active) {
      subBadge = el('span', {
        class: 'subscription-badge is-pro',
        text: 'Pro · active',
      });
    } else {
      subBadge = el('span', { class: 'subscription-badge', text: 'Free' });
    }
    var tierRow = el('p', { class: 'profile-meta-row muted profile-meta-tier' }, [
      el('span', { class: 'profile-meta-key', text: 'Plan: ' }),
      subBadge,
    ]);

    var top = el('div', { class: 'profile-top' }, [
      el('div', { class: 'avatar', 'aria-hidden': 'true' }, [initialsFor(user.email)]),
      el('div', { class: 'profile-id' }, [
        el('p', { class: 'profile-label', text: 'Signed in as' }),
        el('p', {
          class: 'profile-email',
          html: user.email
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/([@.\-_])/g, '<wbr>$1'),
        }),
        el('p', { class: 'profile-meta-row muted' }, [
          el('span', { class: 'profile-meta-key', text: 'Member since ' }),
          el('span', { class: 'profile-meta-val', text: formatDate(user.created_at) }),
        ]),
        el('p', { class: 'profile-meta-row muted' }, [
          el('span', { class: 'profile-meta-key', text: 'Last sign-in: ' }),
          el('span', { class: 'profile-meta-val' }, [
            document.createTextNode(formatRelative(user.last_sign_in_at) + ' '),
            el('time', {
              datetime: user.last_sign_in_at || '',
              title: absoluteForTime(user.last_sign_in_at),
              text: '(' + absoluteForTime(user.last_sign_in_at) + ')',
            }),
          ]),
        ]),
        tierRow,
      ]),
    ]);

    var msg = el('p', { class: 'form-message profile-message', id: 'profile-message' });

    var cpForm = el('form', { class: 'change-pw-form', id: 'change-pw-form', hidden: true }, [
      el('div', { class: 'field' }, [
        el('label', { for: 'cp-current', text: 'Current password' }),
        el('input', {
          type: 'password', id: 'cp-current', name: 'currentPassword',
          autocomplete: 'current-password', required: 'required',
        }),
      ]),
      el('div', { class: 'field' }, [
        el('label', { for: 'cp-new', text: 'New password' }),
        el('input', {
          type: 'password', id: 'cp-new', name: 'newPassword',
          autocomplete: 'new-password', minlength: '8', required: 'required',
        }),
      ]),
      el('div', { class: 'field' }, [
        el('label', { for: 'cp-confirm', text: 'Confirm new password' }),
        el('input', {
          type: 'password', id: 'cp-confirm', name: 'confirmNewPassword',
          autocomplete: 'new-password', minlength: '8', required: 'required',
        }),
      ]),
      el('div', { class: 'change-pw-actions' }, [
        el('button', { type: 'button', class: 'btn btn-ghost', id: 'cp-cancel', text: 'Cancel' }),
        el('button', { type: 'submit', class: 'btn btn-primary', id: 'cp-submit', text: 'Update password' }),
      ]),
    ]);

    var actions = el('div', { class: 'profile-actions' }, [
      el('button', { type: 'button', class: 'btn btn-ghost', id: 'change-pw-btn', text: 'Change password' }),
      el('button', { type: 'button', class: 'btn btn-ghost', id: 'signout-btn', text: 'Sign out' }),
      el('button', { type: 'button', class: 'btn btn-danger', id: 'signout-everywhere-btn', text: 'Sign out everywhere' }),
    ]);

    card.appendChild(top);
    card.appendChild(msg);
    card.appendChild(actions);
    card.appendChild(cpForm);
    return card;
  }

  function renderNotesSection(initialNotes) {
    var wrap = el('section', { class: 'notes-section' });
    wrap.appendChild(el('p', { class: 'panel-eyebrow', text: 'Personal' }));
    wrap.appendChild(el('h2', { class: 'section-heading', text: 'Notes' }));

    var createMsg = el('p', { class: 'form-message', id: 'note-create-message' });
    var textarea = el('textarea', {
      class: 'note-input', id: 'note-input', name: 'body',
      rows: '3', maxlength: '5000', placeholder: 'Write a note (max 5000 characters)…',
    });
    var createBtn = el('button', { type: 'button', class: 'btn btn-primary', id: 'note-add-btn', text: 'Add note' });

    var createForm = el('form', { class: 'note-create', id: 'note-create' }, [
      el('div', { class: 'field' }, [el('label', { for: 'note-input', text: 'New note' }), textarea]),
      createMsg,
      createBtn,
    ]);

    var list = el('div', { class: 'notes-list', id: 'notes-list' });

    wrap.appendChild(createForm);
    wrap.appendChild(list);

    if (!initialNotes || initialNotes.length === 0) {
      list.appendChild(el('p', { class: 'notes-empty muted', text: 'You have no notes yet — start one above.' }));
    } else {
      initialNotes.forEach(function (n) { list.appendChild(renderNoteCard(n)); });
    }
    return wrap;
  }

  function renderNoteCard(note) {
    var card = el('article', { class: 'note-card', 'data-id': String(note.id) });
    var body = el('p', { class: 'note-body', text: note.body });
    var ts = el('p', { class: 'note-ts muted' }, [
      document.createTextNode('Created ' + formatRelative(note.created_at) + ' '),
      el('time', {
        datetime: note.created_at, title: absoluteForTime(note.created_at),
        text: '(' + absoluteForTime(note.created_at) + ')',
      }),
    ]);
    var editBtn = el('button', { type: 'button', class: 'note-action', 'data-action': 'edit', 'aria-label': 'Edit note', text: 'Edit' });
    var delBtn = el('button', { type: 'button', class: 'note-action note-action-danger', 'data-action': 'delete', 'aria-label': 'Delete note', text: 'Delete' });
    var actions = el('div', { class: 'note-actions' }, [editBtn, delBtn]);
    card.appendChild(body);
    card.appendChild(ts);
    card.appendChild(actions);
    return card;
  }

  function enterEditMode(card, note) {
    card.classList.add('is-editing');
    var body = card.querySelector('.note-body');
    var ta = el('textarea', {
      class: 'note-edit-input', rows: '4', maxlength: '5000',
    });
    ta.value = note.body;
    body.replaceWith(ta);

    var actions = card.querySelector('.note-actions');
    actions.innerHTML = '';
    var saveBtn = el('button', { type: 'button', class: 'note-action', text: 'Save' });
    var cancelBtn = el('button', { type: 'button', class: 'note-action', text: 'Cancel' });
    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);

    var msg = el('p', { class: 'form-message note-edit-message' });
    actions.parentNode.insertBefore(msg, actions.nextSibling);

    saveBtn.addEventListener('click', async function () {
      saveBtn.disabled = true;
      cancelBtn.disabled = true;
      setMessage(msg, '', null);
      try {
        var out = await patchJSON('/api/notes/' + note.id, { body: ta.value });
        if (maybeRedirectOn401(out.status)) return;
        if (out.status === 200) {
          exitEditMode(card, out.data);
          return;
        }
        setMessage(msg, (out.data && out.data.error) || 'Could not save note.', 'error');
        saveBtn.disabled = false;
        cancelBtn.disabled = false;
      } catch (e) {
        setMessage(msg, 'Network error — please try again.', 'error');
        saveBtn.disabled = false;
        cancelBtn.disabled = false;
      }
    });

    cancelBtn.addEventListener('click', function () {
      exitEditMode(card, note);
    });
  }

  function exitEditMode(card, note) {
    card.classList.remove('is-editing');
    var ta = card.querySelector('.note-edit-input');
    if (ta) {
      var fresh = el('p', { class: 'note-body', text: note.body });
      ta.replaceWith(fresh);
    }
    var msg = card.querySelector('.note-edit-message');
    if (msg) msg.remove();
    var actions = card.querySelector('.note-actions');
    actions.innerHTML = '';
    var editBtn = el('button', { type: 'button', class: 'note-action', 'data-action': 'edit', 'aria-label': 'Edit note', text: 'Edit' });
    var delBtn = el('button', { type: 'button', class: 'note-action note-action-danger', 'data-action': 'delete', 'aria-label': 'Delete note', text: 'Delete' });
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
  }

  function renderAdminSection(stats) {
    var wrap = el('section', { class: 'admin-section' });
    wrap.appendChild(el('p', { class: 'panel-eyebrow', text: 'Workspace' }));
    wrap.appendChild(el('h2', { class: 'section-heading', text: 'Stats' }));

    var signupsWeek = stats.signupsByDay.slice(-7).reduce(function (s, d) { return s + d.count; }, 0);
    var notesWeek = stats.notesByDay.slice(-7).reduce(function (s, d) { return s + d.count; }, 0);

    var tiles = el('div', { class: 'stat-tile-row' }, [
      el('div', { class: 'stat-tile' }, [
        el('p', { class: 'stat-tile-label', text: 'Total users' }),
        el('p', { class: 'stat-tile-value', text: String(stats.totalUsers) }),
      ]),
      el('div', { class: 'stat-tile' }, [
        el('p', { class: 'stat-tile-label', text: 'Total notes' }),
        el('p', { class: 'stat-tile-value', text: String(stats.totalNotes) }),
      ]),
      el('div', { class: 'stat-tile' }, [
        el('p', { class: 'stat-tile-label', text: 'Signups this week' }),
        el('p', { class: 'stat-tile-value', text: String(signupsWeek) }),
      ]),
      el('div', { class: 'stat-tile' }, [
        el('p', { class: 'stat-tile-label', text: 'Notes this week' }),
        el('p', { class: 'stat-tile-value', text: String(notesWeek) }),
      ]),
    ]);
    wrap.appendChild(tiles);

    wrap.appendChild(renderLineChart({
      title: 'Signups — last 14 days',
      series: stats.signupsByDay,
    }));
    wrap.appendChild(renderLineChart({
      title: 'Notes created — last 14 days',
      series: stats.notesByDay,
    }));
    return wrap;
  }

  // Inline SVG line chart. Single series → no legend box (title names it).
  // Mark specs: 2px line, >=8px dots with 2px surface ring, hairline grid,
  // recessive axis. Text uses --text-muted, line uses --accent.
  function renderLineChart(opts) {
    var series = opts.series || [];
    var maxCount = 0;
    for (var i = 0; i < series.length; i++) {
      if (series[i].count > maxCount) maxCount = series[i].count;
    }
    var yMax = Math.max(maxCount, 1);
    // Round the y-axis up to a clean integer to keep tick labels simple.
    var yMaxRounded = maxCount < 4 ? 4 : Math.ceil(maxCount / 5) * 5 || 5;

    var w = 640, h = 220;
    var padL = 40, padR = 12, padT = 12, padB = 30;
    var plotW = w - padL - padR;
    var plotH = h - padT - padB;
    var n = series.length;
    var stepX = n > 1 ? plotW / (n - 1) : 0;

    var yToPx = function (count) { return padT + plotH - (count / yMaxRounded) * plotH; };
    var xToPx = function (i) { return padL + i * stepX; };

    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('class', 'chart');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', opts.title);

    var titleEl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    titleEl.textContent = opts.title;
    svg.appendChild(titleEl);

    // Y-axis: hairline + 3 tick labels (0, mid, max).
    var yAxis = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    yAxis.setAttribute('x1', String(padL));
    yAxis.setAttribute('y1', String(padT));
    yAxis.setAttribute('x2', String(padL));
    yAxis.setAttribute('y2', String(padT + plotH));
    yAxis.setAttribute('class', 'chart-axis');
    svg.appendChild(yAxis);

    var xAxis = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    xAxis.setAttribute('x1', String(padL));
    xAxis.setAttribute('y1', String(padT + plotH));
    xAxis.setAttribute('x2', String(padL + plotW));
    xAxis.setAttribute('y2', String(padT + plotH));
    xAxis.setAttribute('class', 'chart-axis');
    svg.appendChild(xAxis);

    var yTicks = [0, yMaxRounded / 2, yMaxRounded];
    yTicks.forEach(function (v) {
      var y = yToPx(v);
      var grid = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      grid.setAttribute('x1', String(padL));
      grid.setAttribute('y1', String(y));
      grid.setAttribute('x2', String(padL + plotW));
      grid.setAttribute('y2', String(y));
      grid.setAttribute('class', 'chart-grid');
      svg.appendChild(grid);

      var label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', String(padL - 6));
      label.setAttribute('y', String(y + 4));
      label.setAttribute('text-anchor', 'end');
      label.setAttribute('class', 'chart-label');
      label.textContent = String(v);
      svg.appendChild(label);
    });

    if (n === 0) {
      var empty = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      empty.setAttribute('x', String(padL + plotW / 2));
      empty.setAttribute('y', String(padT + plotH / 2));
      empty.setAttribute('text-anchor', 'middle');
      empty.setAttribute('class', 'chart-label');
      empty.textContent = 'No data yet.';
      svg.appendChild(empty);
    } else {
      // Line path. n=1: just a dot, no line.
      if (n > 1) {
        var d = '';
        for (var k = 0; k < n; k++) {
          var px = xToPx(k);
          var py = yToPx(series[k].count);
          d += (k === 0 ? 'M' : 'L') + px + ' ' + py + ' ';
        }
        var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d.trim());
        path.setAttribute('class', 'chart-line');
        svg.appendChild(path);
      }

      // Dots with a 2px surface ring.
      for (var j = 0; j < n; j++) {
        var cxp = xToPx(j);
        var cyp = yToPx(series[j].count);
        var ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        ring.setAttribute('cx', String(cxp));
        ring.setAttribute('cy', String(cyp));
        ring.setAttribute('r', '5');
        ring.setAttribute('class', 'chart-dot-ring');
        svg.appendChild(ring);
        var dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', String(cxp));
        dot.setAttribute('cy', String(cyp));
        dot.setAttribute('r', '3');
        dot.setAttribute('class', 'chart-dot');
        svg.appendChild(dot);
      }

      // X-axis end labels.
      if (n > 0) {
        var firstLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        firstLabel.setAttribute('x', String(xToPx(0)));
        firstLabel.setAttribute('y', String(padT + plotH + 18));
        firstLabel.setAttribute('text-anchor', 'start');
        firstLabel.setAttribute('class', 'chart-label');
        firstLabel.textContent = series[0].date.slice(5); // MM-DD
        svg.appendChild(firstLabel);

        var lastLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        lastLabel.setAttribute('x', String(xToPx(n - 1)));
        lastLabel.setAttribute('y', String(padT + plotH + 18));
        lastLabel.setAttribute('text-anchor', 'end');
        lastLabel.setAttribute('class', 'chart-label');
        lastLabel.textContent = series[n - 1].date.slice(5);
        svg.appendChild(lastLabel);
      }
    }

    var fig = el('figure', { class: 'chart-figure' }, [
      el('figcaption', { class: 'chart-title', text: opts.title }),
      svg,
    ]);
    return fig;
  }

  function wireProfile(root, user) {
    var msg = $('profile-message');
    var cpBtn = $('change-pw-btn');
    var cpForm = $('change-pw-form');
    var cpCancel = $('cp-cancel');
    var signoutEverywhereBtn = $('signout-everywhere-btn');
    var signoutBtn = $('signout-btn');

    if (signoutBtn) {
      signoutBtn.addEventListener('click', function () { logout(); });
    }

    if (cpBtn && cpForm) {
      cpBtn.addEventListener('click', function () {
        var isHidden = cpForm.hasAttribute('hidden');
        if (isHidden) {
          cpForm.removeAttribute('hidden');
          cpBtn.textContent = 'Hide change password';
        } else {
          cpForm.setAttribute('hidden', '');
          cpBtn.textContent = 'Change password';
          cpForm.reset();
          setMessage(msg, '', null);
        }
      });
    }
    if (cpCancel && cpForm && cpBtn) {
      cpCancel.addEventListener('click', function () {
        cpForm.setAttribute('hidden', '');
        cpBtn.textContent = 'Change password';
        cpForm.reset();
        setMessage(msg, '', null);
      });
    }
    if (cpForm) {
      cpForm.addEventListener('submit', async function (ev) {
        ev.preventDefault();
        var currentPassword = cpForm.currentPassword.value;
        var newPassword = cpForm.newPassword.value;
        var confirmNew = cpForm.confirmNewPassword.value;
        if (newPassword !== confirmNew) {
          setMessage(msg, 'New password and confirmation do not match.', 'error');
          return;
        }
        if (newPassword.length < 8) {
          setMessage(msg, 'New password must be at least 8 characters.', 'error');
          return;
        }
        var submit = $('cp-submit');
        submit.disabled = true;
        setMessage(msg, 'Updating password…', null);
        try {
          var out = await postJSON('/api/change-password', {
            currentPassword: currentPassword,
            newPassword: newPassword,
          });
          if (maybeRedirectOn401(out.status)) return;
          if (out.status === 200) {
            // Password changed → existing cookie's password_hash is now stale
            // for any future admin change. Force re-login everywhere.
            window.location.href = './login.html?reset=1';
            return;
          }
          setMessage(msg, (out.data && out.data.error) || 'Could not update password.', 'error');
        } catch (e) {
          setMessage(msg, 'Network error — please try again.', 'error');
        } finally {
          if (submit) submit.disabled = false;
        }
      });
    }
    if (signoutEverywhereBtn) {
      signoutEverywhereBtn.addEventListener('click', async function () {
        if (!window.confirm('Sign out of every device? You will need to sign in again.')) return;
        try {
          var out = await postJSON('/api/sign-out-everywhere', {});
          if (maybeRedirectOn401(out.status)) return;
          if (out.status === 204) {
            window.location.href = './login.html';
          } else {
            setMessage(msg, 'Could not sign out everywhere.', 'error');
          }
        } catch (e) {
          setMessage(msg, 'Network error — please try again.', 'error');
        }
      });
    }
  }

  function wireNotes(root) {
    var createForm = $('note-create');
    var msg = $('note-create-message');

    if (createForm) {
      createForm.addEventListener('submit', async function (ev) {
        ev.preventDefault();
        var body = $('note-input').value;
        var trimmed = body.trim();
        if (trimmed.length === 0) {
          setMessage(msg, 'Note cannot be empty.', 'error');
          return;
        }
        if (trimmed.length > 5000) {
          setMessage(msg, 'Note is too long (max 5000 characters).', 'error');
          return;
        }
        var btn = $('note-add-btn');
        btn.disabled = true;
        setMessage(msg, 'Adding note…', null);
        try {
          var out = await postJSON('/api/notes', { body: body });
          if (maybeRedirectOn401(out.status)) return;
          if (out.status === 200) {
            var list = $('notes-list');
            var empty = list.querySelector('.notes-empty');
            if (empty) empty.remove();
            list.insertBefore(renderNoteCard(out.data), list.firstChild);
            $('note-input').value = '';
            setMessage(msg, 'Note added.', 'success');
          } else {
            setMessage(msg, (out.data && out.data.error) || 'Could not add note.', 'error');
          }
        } catch (e) {
          setMessage(msg, 'Network error — please try again.', 'error');
        } finally {
          if (btn) btn.disabled = false;
        }
      });
    }

    var list = $('notes-list');
    if (list) {
      list.addEventListener('click', async function (ev) {
        var t = ev.target;
        if (!(t instanceof Element)) return;
        var card = t.closest('.note-card');
        if (!card) return;
        var id = card.getAttribute('data-id');
        if (!id) return;
        var action = t.getAttribute('data-action');
        if (action === 'edit') {
          // Read the current rendered body for the edit seed.
          var currentBodyEl = card.querySelector('.note-body');
          var currentBody = currentBodyEl ? currentBodyEl.textContent : '';
          var tsEl = card.querySelector('time');
          enterEditMode(card, {
            id: Number(id),
            body: currentBody,
            created_at: tsEl ? tsEl.getAttribute('datetime') : '',
            updated_at: tsEl ? tsEl.getAttribute('datetime') : '',
          });
        } else if (action === 'delete') {
          if (!window.confirm('Delete this note?')) return;
          try {
            var out = await deleteJSON('/api/notes/' + id);
            if (maybeRedirectOn401(out.status)) return;
            if (out.status === 204) {
              card.remove();
              var remaining = document.querySelectorAll('.note-card').length;
              if (remaining === 0) {
                var listEl = $('notes-list');
                if (listEl) {
                  listEl.appendChild(el('p', { class: 'notes-empty muted', text: 'You have no notes yet — start one above.' }));
                }
              }
            } else {
              alert('Could not delete note.');
            }
          } catch (e) {
            alert('Network error — please try again.');
          }
        }
      });
    }
  }

  async function loadDashboard() {
    var root = $('dashboard-root');
    if (!root) return;

    root.innerHTML = '<p class="dashboard-loading">Loading your dashboard&hellip;</p>';

    try {
      var meRes = await fetch('/api/me', { credentials: 'same-origin' });
      if (meRes.status === 401) {
        window.location.href = './login.html';
        return;
      }
      var user = await meRes.json();

      var notesRes = await getJSON('/api/notes');
      if (maybeRedirectOn401(notesRes.status)) return;
      var notes = (notesRes.data && notesRes.data.notes) || [];

      // Security events are best-effort: a 5xx is non-fatal and we render
      // the section with an empty list. /api/security/events requires auth
      // so a 401 here would have already redirected above.
      var events = [];
      try {
        var evRes = await getJSON('/api/security/events');
        if (evRes.status === 200) {
          events = (evRes.data && evRes.data.events) || [];
        }
      } catch (e) {
        // Swallow — Security section is still rendered, just empty.
      }

      // Admin stats is best-effort. 403 → not an admin, render without the
      // admin section. Any other error is also non-fatal.
      var stats = null;
      if (user.is_admin) {
        try {
          var sRes = await fetch('/api/admin/stats', { credentials: 'same-origin' });
          if (sRes.status === 200) {
            stats = await sRes.json();
          } else if (sRes.status === 401) {
            window.location.href = './login.html';
            return;
          }
        } catch (e) {
          // Swallow — admin section is optional.
        }
      }

      renderVerifyBanner(user);
      root.innerHTML = '';
      root.appendChild(renderProfile(user));
      wireProfile(root, user);
      wireVerifyFlash();
      wireUpgradeFlash();
      root.appendChild(renderNotesSection(notes));
      wireNotes(root);
      root.appendChild(renderSecuritySection(events));
      if (stats) {
        root.appendChild(renderAdminSection(stats));
        // Admin posts CRUD lives inside the admin section so the panel
        // can sit just below the chart row. /api/admin/posts returns
        // drafts and body_md so the editor can round-trip.
        var posts = [];
        try {
          var pRes = await fetch('/api/admin/posts', { credentials: 'same-origin' });
          if (pRes.status === 200) {
            var pj = await pRes.json();
            posts = (pj && pj.posts) || [];
          }
        } catch (e) { /* non-fatal */ }
        root.appendChild(renderPostsAdmin(posts));
        wirePostsAdmin();
      }
    } catch (err) {
      root.innerHTML = '<p class="form-message is-error">Could not load your dashboard. Please try refreshing.</p>';
    }
  }

  // ---------- Posts admin section ----------
  //
  // Mirrors the notes CRUD shape but lives inside the admin section. Posts
  // can be created / edited / published (toggle) / deleted. The markdown
  // body is sent through the server, which sanitises it before rendering;
  // we don't try to preview it client-side.

  function renderPostsAdmin(initialPosts) {
    var wrap = el('section', { class: 'admin-section posts-section' });
    wrap.appendChild(el('p', { class: 'panel-eyebrow', text: 'Newsletter' }));
    wrap.appendChild(el('h2', { class: 'section-heading', text: 'Posts' }));

    var msg = el('p', { class: 'form-message', id: 'posts-message' });

    // Editor form. Hidden by default; clicking "New post" reveals it.
    var editor = el('form', { class: 'post-editor', id: 'post-editor', hidden: true });
    var slugInput = el('input', { type: 'text', id: 'post-slug', name: 'slug', placeholder: 'my-post-slug', required: 'required', pattern: '[a-z0-9][a-z0-9-]*' });
    var titleInput = el('input', { type: 'text', id: 'post-title', name: 'title', placeholder: 'Title', required: 'required', maxlength: '200' });
    var excerptInput = el('input', { type: 'text', id: 'post-excerpt', name: 'excerpt', placeholder: 'One-paragraph excerpt', required: 'required', maxlength: '500' });
    var bodyInput = el('textarea', { id: 'post-body', name: 'body_md', placeholder: 'Write the post in Markdown…', required: 'required' });
    var tierSelect = el('select', { id: 'post-tier', name: 'tier' }, [
      el('option', { value: 'free', text: 'Free' }),
      el('option', { value: 'paid', text: 'Paid (Pro)' }),
    ]);
    var saveBtn = el('button', { type: 'submit', class: 'btn btn-primary', id: 'post-save-btn', text: 'Save post' });
    var cancelBtn = el('button', { type: 'button', class: 'btn btn-ghost', id: 'post-cancel-btn', text: 'Cancel' });

    editor.appendChild(el('div', { class: 'post-editor-row' }, [
      el('div', { class: 'field' }, [el('label', { for: 'post-slug', text: 'Slug' }), slugInput]),
      el('div', { class: 'field' }, [el('label', { for: 'post-tier', text: 'Tier' }), tierSelect]),
    ]));
    editor.appendChild(el('div', { class: 'field' }, [el('label', { for: 'post-title', text: 'Title' }), titleInput]));
    editor.appendChild(el('div', { class: 'field' }, [el('label', { for: 'post-excerpt', text: 'Excerpt' }), excerptInput]));
    editor.appendChild(el('div', { class: 'field' }, [el('label', { for: 'post-body', text: 'Body (Markdown)' }), bodyInput]));
    editor.appendChild(el('div', { class: 'post-editor-actions' }, [cancelBtn, saveBtn]));

    wrap.appendChild(editor);
    wrap.appendChild(msg);

    var toolbar = el('div', { class: 'post-editor-actions' }, [
      el('button', { type: 'button', class: 'btn btn-primary', id: 'post-new-btn', text: 'New post' }),
    ]);
    wrap.appendChild(toolbar);

    var table = el('div', { class: 'posts-table', id: 'posts-table' });
    wrap.appendChild(table);

    if (!initialPosts || initialPosts.length === 0) {
      table.appendChild(el('p', { class: 'posts-empty muted', text: 'No posts yet. Click "New post" to add the first one.' }));
    } else {
      initialPosts.forEach(function (p) { table.appendChild(renderPostRow(p, editor, fields, table)); });
    }
    return wrap;
  }

  function fields() {
    return {
      slugInput: $('post-slug'),
      titleInput: $('post-title'),
      excerptInput: $('post-excerpt'),
      bodyInput: $('post-body'),
      tierSelect: $('post-tier'),
    };
  }

  function renderPostRow(post, editor, fields, table) {
    var row = el('article', { class: 'post-row', 'data-id': String(post.id), 'data-slug': post.slug });
    var badge = el('span', {
      class: 'subscription-badge' + (post.tier === 'paid' ? ' is-pro' : ''),
      text: post.tier === 'paid' ? 'Pro' : 'Free',
    });
    var titleLink = el('span', { class: 'post-row-title', text: post.title });
    var slugInfo = el('span', { class: 'post-row-slug', text: '/' + post.slug });
    var status = el('span', {
      class: 'post-row-meta',
      text: post.published ? 'Published' + (post.published_at ? ' · ' + formatDate(post.published_at) : '') : 'Draft',
    });
    var editBtn = el('button', { type: 'button', class: 'note-action', 'data-action': 'edit', text: 'Edit' });
    var publishBtn = el('button', { type: 'button', class: 'note-action', 'data-action': 'publish', text: post.published ? 'Unpublish' : 'Publish' });
    var delBtn = el('button', { type: 'button', class: 'note-action note-action-danger', 'data-action': 'delete', text: 'Delete' });
    var viewLink = el('a', { href: './post.html?slug=' + encodeURIComponent(post.slug), class: 'note-action', text: 'View' });

    var left = el('div', { class: 'profile-id' }, [
      el('div', null, [badge, ' ', titleLink, ' ', slugLink(slugInfo)]),
      status,
    ]);
    var actions = el('div', { class: 'post-row-actions' }, [viewLink, editBtn, publishBtn, delBtn]);
    row.appendChild(left);
    row.appendChild(actions);
    return row;
  }

  function slugLink(slugEl) {
    // Tiny wrapper so we keep one shape — only used to put the slug next to
    // the title in the row. Returns the input element untouched.
    return slugEl;
  }

  function wirePostsAdmin() {
    var newBtn = $('post-new-btn');
    var editor = $('post-editor');
    var cancelBtn = $('post-cancel-btn');
    var msg = $('posts-message');
    var table = $('posts-table');

    if (newBtn && editor) {
      newBtn.addEventListener('click', function () {
        var f = fields();
        if (f.slugInput) f.slugInput.value = '';
        if (f.titleInput) f.titleInput.value = '';
        if (f.excerptInput) f.excerptInput.value = '';
        if (f.bodyInput) f.bodyInput.value = '';
        if (f.tierSelect) f.tierSelect.value = 'free';
        editor.removeAttribute('hidden');
        editor.dataset.editingId = '';
        setMessage(msg, '', null);
        if (f.slugInput) f.slugInput.focus();
      });
    }
    if (cancelBtn && editor) {
      cancelBtn.addEventListener('click', function () {
        editor.setAttribute('hidden', '');
        editor.dataset.editingId = '';
        setMessage(msg, '', null);
      });
    }
    if (editor) {
      editor.addEventListener('submit', async function (ev) {
        ev.preventDefault();
        var f = fields();
        var payload = {
          slug: (f.slugInput && f.slugInput.value || '').trim().toLowerCase(),
          title: (f.titleInput && f.titleInput.value || '').trim(),
          excerpt: (f.excerptInput && f.excerptInput.value || '').trim(),
          body_md: f.bodyInput ? f.bodyInput.value : '',
          tier: (f.tierSelect && f.tierSelect.value) || 'free',
        };
        if (!payload.slug || !payload.title || !payload.excerpt || !payload.body_md) {
          setMessage(msg, 'Slug, title, excerpt, and body are all required.', 'error');
          return;
        }
        var saveBtn = $('post-save-btn');
        if (saveBtn) saveBtn.disabled = true;
        setMessage(msg, 'Saving…', null);
        try {
          var editingId = editor.dataset.editingId || '';
          var out;
          if (editingId) {
            out = await patchJSON('/api/admin/posts/' + editingId, payload);
          } else {
            out = await postJSON('/api/admin/posts', payload);
          }
          if (maybeRedirectOn401(out.status)) return;
          if (out.status === 200) {
            setMessage(msg, editingId ? 'Post updated.' : 'Post created.', 'success');
            // Replace / insert row at the top of the table.
            if (table) {
              var existing = table.querySelector('.post-row[data-id="' + out.data.id + '"]');
              var newRow = renderPostRow(out.data, editor, fields, table);
              if (existing) existing.replaceWith(newRow);
              else {
                var empty = table.querySelector('.posts-empty');
                if (empty) empty.remove();
                table.insertBefore(newRow, table.firstChild);
              }
            }
            editor.setAttribute('hidden', '');
            editor.dataset.editingId = '';
          } else if (out.status === 409) {
            setMessage(msg, (out.data && out.data.error) || 'Slug already exists.', 'error');
          } else {
            setMessage(msg, (out.data && out.data.error) || 'Could not save post.', 'error');
          }
        } catch (err) {
          setMessage(msg, 'Network error — please try again.', 'error');
        } finally {
          var sb = $('post-save-btn');
          if (sb) sb.disabled = false;
        }
      });
    }

    if (table) {
      table.addEventListener('click', async function (ev) {
        var t = ev.target;
        if (!(t instanceof Element)) return;
        var row = t.closest('.post-row');
        if (!row) return;
        var id = row.getAttribute('data-id');
        var action = t.getAttribute('data-action');
        if (!action) return;
        if (action === 'edit') {
          // Use the admin list endpoint which returns body_md as written,
          // so edits round-trip losslessly (vs. round-tripping HTML).
          try {
            var r = await fetch('/api/admin/posts', { credentials: 'same-origin' });
            if (r.status !== 200) {
              setMessage(msg, 'Could not load post body for editing.', 'error');
              return;
            }
            var pj = await r.json();
            var data = (pj.posts || []).find(function (p) { return String(p.id) === String(id); });
            if (!data) {
              setMessage(msg, 'Post not found in admin list.', 'error');
              return;
            }
            var f = fields();
            if (f.slugInput) f.slugInput.value = data.slug;
            if (f.titleInput) f.titleInput.value = data.title;
            if (f.excerptInput) f.excerptInput.value = data.excerpt;
            if (f.bodyInput) f.bodyInput.value = data.body_md || '';
            if (f.tierSelect) f.tierSelect.value = data.tier;
            var editorEl = $('post-editor');
            if (editorEl) {
              editorEl.removeAttribute('hidden');
              editorEl.dataset.editingId = id;
            }
            setMessage(msg, 'Editing post ' + data.slug + '.', null);
          } catch (e) {
            setMessage(msg, 'Network error — please try again.', 'error');
          }
        } else if (action === 'publish') {
          var want = (t.textContent || '').trim() === 'Publish';
          try {
            var out = await patchJSON('/api/admin/posts/' + id + '/publish', { published: want });
            if (maybeRedirectOn401(out.status)) return;
            if (out.status === 200) {
              var fresh = out.data;
              var newRow = renderPostRow(fresh, $('post-editor'), fields, table);
              row.replaceWith(newRow);
              setMessage(msg, fresh.published ? 'Published.' : 'Unpublished.', 'success');
            } else {
              setMessage(msg, (out.data && out.data.error) || 'Could not toggle publish.', 'error');
            }
          } catch (e) {
            setMessage(msg, 'Network error — please try again.', 'error');
          }
        } else if (action === 'delete') {
          if (!window.confirm('Delete this post?')) return;
          try {
            var out2 = await deleteJSON('/api/admin/posts/' + id);
            if (maybeRedirectOn401(out2.status)) return;
            if (out2.status === 204) {
              row.remove();
              var remaining = document.querySelectorAll('.post-row').length;
              if (remaining === 0 && table) {
                table.appendChild(el('p', { class: 'posts-empty muted', text: 'No posts yet. Click "New post" to add the first one.' }));
              }
            } else {
              alert('Could not delete post.');
            }
          } catch (e) {
            alert('Network error — please try again.');
          }
        }
      });
    }
  }

  // Best-effort round-trip from sanitised HTML back to markdown for the
  // "Edit" button. Real product would store and return body_md alongside;
  // for the demo this is enough to make edits workable.
  function stripHtml(html) {
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    return tmp.textContent || '';
  }

  // ---------- Newsletter capture (landing) ----------
  //
  // Used by /index.html and any future footer form. Always-idempotent
  // server-side (UNIQUE on lower(email)), so re-submitting just returns
  // the same success message.
  function wireNewsletterCapture() {
    var forms = document.querySelectorAll('.newsletter-form');
    forms.forEach(function (form) {
      var msg = form.querySelector('.newsletter-form-msg');
      var btn = form.querySelector('button[type="submit"]');
      var input = form.querySelector('input[type="email"]');
      if (!msg || !btn || !input) return;
      form.addEventListener('submit', async function (ev) {
        ev.preventDefault();
        var email = input.value.trim();
        if (!email) {
          msg.className = 'form-message is-error';
          msg.textContent = 'Please enter your email.';
          return;
        }
        btn.disabled = true;
        msg.className = 'form-message';
        msg.textContent = 'Adding you to the list…';
        try {
          var out = await postJSON('/api/email-capture', { email: email });
          if (out.status === 200) {
            msg.className = 'form-message is-success';
            msg.textContent = 'Thanks — you are on the list.';
            form.reset();
          } else if (out.status === 429) {
            msg.className = 'form-message is-error';
            msg.textContent = (out.data && out.data.error) || 'Too many requests.';
          } else {
            msg.className = 'form-message is-error';
            msg.textContent = (out.data && out.data.error) || 'Could not subscribe.';
          }
        } catch (err) {
          msg.className = 'form-message is-error';
          msg.textContent = 'Network error — please try again.';
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  // ---------- Dashboard : flash messages ----------
  //
  // /dashboard.html?upgrade=ok is set by the dev-grant page (and by Stripe
  // Checkout on real upgrades). Surface a one-time success line the same
  // way /login.html?reset=ok does for password reset.
  function wireUpgradeFlash() {
    var msg = $('profile-message');
    if (!msg) return;
    if (paramFromUrl('upgrade') !== 'ok') return;
    setMessage(msg, 'You are now on Pro. Welcome.', 'success');
    try {
      var cleanUrl = window.location.pathname + window.location.hash;
      window.history.replaceState(null, '', cleanUrl);
    } catch (e) { /* ignore */ }
  }

  // ---------- Boot ----------
  document.addEventListener('DOMContentLoaded', function () {
    refreshAuthNav();
    wireLoginForm();
    wireLoginFlash();
    wireRegisterForm();
    wireForgotForm();
    wireResetForm();
    wireVerifyPage();
    wireSignOutButtons();
    wireNewsletterCapture();
    loadDashboard();
  });
})();
