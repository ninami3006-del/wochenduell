(function () {
  'use strict';

  const cfg = window.WD_CONFIG;
  const T = window.WD_I18N;
  const sb = window.supabase.createClient(cfg.url, cfg.anonKey);

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- language ---------- */
  const LANGS = ['de', 'en'];
  let lang = initialLang();

  function initialLang() {
    try { const s = localStorage.getItem('wd-lang'); if (LANGS.includes(s)) return s; } catch (e) {}
    return (navigator.language || 'de').toLowerCase().startsWith('de') ? 'de' : 'en';
  }
  function t(key, ...args) {
    const table = T[lang] || T.de;
    const v = key in table ? table[key] : T.de[key];
    if (v === undefined) return key;
    return typeof v === 'function' ? v(...args) : v;
  }
  const locale = () => (lang === 'de' ? 'de-DE' : 'en-GB');
  const fmt = (n) => Number(n).toLocaleString(locale());

  function useLang(l) {
    lang = LANGS.includes(l) ? l : 'de';
    document.documentElement.lang = lang;
    try { localStorage.setItem('wd-lang', lang); } catch (e) {}
    applyStatic();
  }
  function applyStatic() {
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
    document.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
    renderSportOpts();
  }

  /* ---------- points ---------- */
  const CAP = { steps: 25, burn: 20, train: 30, food: 10 };
  const CATS = ['steps', 'burn', 'train', 'food'];
  const SPORTS = ['run', 'strength', 'bike', 'yoga', 'football', 'swim', 'hiit', 'other'];
  const stepPts = (s) => Math.min(CAP.steps, Math.floor((s || 0) / 1000));
  const burnPts = (k) => Math.min(CAP.burn, Math.floor((k || 0) / 50));
  const oneWorkout = (m) => (m >= 45 ? 15 : m >= 20 ? 10 : 0);
  const trainPts = (ws) => ws.map((w) => oneWorkout(w.minutes)).sort((a, b) => b - a).slice(0, 2).reduce((a, b) => a + b, 0);
  const foodPts = (e, g) => {
    if (e == null || !g) return 0;
    const dev = Math.abs(e - g) / g;
    return dev <= 0.1 ? 10 : dev <= 0.2 ? 5 : 0;
  };

  /* ---------- dates (local time, weeks start on Monday) ---------- */
  const pad = (n) => String(n).padStart(2, '0');
  const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const weekStartOf = (d) => addDays(d, -((d.getDay() + 6) % 7));
  const weekDays = (start) => Array.from({ length: 7 }, (_, i) => keyOf(addDays(start, i)));
  const parseKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  function isoWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d - y0) / 86400000 + 1) / 7);
  }
  function ctx() {
    const today = new Date();
    const start = weekStartOf(today);
    const all = weekDays(start);
    const todayKey = keyOf(today);
    return { today, todayKey, start, all, past: all.filter((d) => d <= todayKey), week: isoWeek(today) };
  }
  const weekdayLong = (key) => new Intl.DateTimeFormat(locale(), { weekday: 'long' }).format(parseKey(key));
  const timeOf = (iso) => (iso ? new Date(iso).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) : '');

  /* ---------- state ---------- */
  const S = {
    user: null, me: null, group: null, members: [],
    stats: new Map(), workouts: [], kudos: new Map(),
    tab: 'heute', open: null, view: 'loading', authMode: 'login', sync: null
  };
  try { const tb = localStorage.getItem('wd-tab'); if (['heute', 'rangliste', 'feed', 'profil'].includes(tb)) S.tab = tb; } catch (e) {}

  const isMe = (id) => !!S.user && id === S.user.id;
  const member = (id) => S.members.find((m) => m.id === id);
  const nameOf = (id) => (isMe(id) ? t('you') : (member(id) || {}).display_name || '?');
  function initials(id) {
    if (isMe(id)) return t('you_short');
    const n = ((member(id) || {}).display_name || '?').trim();
    const parts = n.split(/\s+/);
    return (parts.length > 1 ? parts[0][0] + parts[1][0] : n.slice(0, 2)).toUpperCase();
  }
  const av = (id) => `<span class="avatar${isMe(id) ? ' me' : ''}">${esc(initials(id))}</span>`;
  const sportName = (k) => { const v = t('sport_' + k); return v === 'sport_' + k ? k : v; };
  const srcName = (s) => (!s || s === 'manual' ? t('src_manual') : s === 'apple_health' ? 'Apple Health' : s === 'whoop' ? 'Whoop' : s);

  const statOf = (uid, day) => S.stats.get(uid + '|' + day) || null;
  const workoutsOf = (uid, day) => S.workouts.filter((w) => w.user_id === uid && w.day === day);
  function score(uid, day) {
    const s = statOf(uid, day) || {};
    const m = member(uid);
    const r = {
      steps: stepPts(s.steps),
      burn: burnPts(s.active_kcal),
      train: trainPts(workoutsOf(uid, day)),
      food: foodPts(s.eaten_kcal == null ? null : s.eaten_kcal, m ? m.calorie_goal : 0)
    };
    r.total = r.steps + r.burn + r.train + r.food;
    return r;
  }
  function sumScore(uid, days) {
    const sum = { steps: 0, burn: 0, train: 0, food: 0, total: 0 };
    days.forEach((d) => { const s = score(uid, d); for (const k in sum) sum[k] += s[k]; });
    return sum;
  }
  const ranking = (days) => S.members
    .map((m) => Object.assign({ id: m.id }, sumScore(m.id, days)))
    .sort((a, b) => b.total - a.total || nameOf(a.id).localeCompare(nameOf(b.id)));

  /* ---------- data ---------- */
  function check(res) { if (res.error) throw res.error; return res.data; }

  async function load() {
    const uid = S.user.id;
    const [me, mem, sync] = await Promise.all([
      sb.from('profiles').select('id,display_name,calorie_goal,language').eq('id', uid).maybeSingle().then(check),
      sb.from('group_members').select('group_id,joined_at,groups(id,name,invite_code,created_by)').eq('user_id', uid).order('joined_at', { ascending: true }).limit(1).then(check),
      sb.rpc('get_sync_key').then(check)
    ]);
    S.me = me || { id: uid, display_name: (S.user.email || '').split('@')[0], calorie_goal: 2000, language: lang };
    S.sync = sync && sync.length ? sync[0] : null;
    if (me && me.language && me.language !== lang) useLang(me.language);
    S.group = mem && mem.length ? mem[0].groups : null;
    if (!S.group) { S.members = []; S.stats = new Map(); S.workouts = []; S.kudos = new Map(); return; }

    const ids = check(await sb.from('group_members').select('user_id').eq('group_id', S.group.id)).map((r) => r.user_id);
    const from = keyOf(addDays(weekStartOf(new Date()), -28));
    const [profiles, stats, workouts] = await Promise.all([
      sb.from('profiles').select('id,display_name,calorie_goal').in('id', ids).then(check),
      sb.from('daily_stats').select('user_id,day,steps,active_kcal,eaten_kcal,source,updated_at').in('user_id', ids).gte('day', from).then(check),
      sb.from('workouts').select('id,user_id,day,started_at,sport,minutes,source').in('user_id', ids).gte('day', from).order('started_at', { ascending: false }).limit(1000).then(check)
    ]);
    S.members = profiles;
    S.stats = new Map(stats.map((r) => [r.user_id + '|' + r.day, r]));
    S.workouts = workouts;

    S.kudos = new Map();
    const since = keyOf(addDays(new Date(), -6));
    const recent = S.workouts.filter((w) => w.day >= since).map((w) => w.id);
    if (recent.length) {
      check(await sb.from('kudos').select('workout_id,user_id').in('workout_id', recent)).forEach((k) => {
        const e = S.kudos.get(k.workout_id) || { n: 0, mine: false };
        e.n += 1;
        if (k.user_id === uid) e.mine = true;
        S.kudos.set(k.workout_id, e);
      });
    }
  }

  /* ---------- icons ---------- */
  const I = {
    heart: '<svg class="ico" viewBox="0 0 24 24"><path d="M12 20s-7.5-4.6-7.5-10.2A4.2 4.2 0 0 1 12 7.3a4.2 4.2 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z"/></svg>',
    band: '<svg class="ico" viewBox="0 0 24 24"><path d="M9 3h6l1 6M9 3 8 9M8 15l1 6h6l1-6"/><rect x="6.5" y="9" width="11" height="6" rx="2"/></svg>',
    food: '<svg class="ico" viewBox="0 0 24 24"><path d="M7 3v7a2 2 0 0 0 2 2v9M5 3v5M9 3v5M18 21V3c-2 0-3.5 2.5-3.5 6s1.5 4 3.5 4"/></svg>',
    flame: '<svg class="ico" viewBox="0 0 24 24"><path d="M12 3s5.5 4.2 5.5 9.5a5.5 5.5 0 0 1-11 0c0-2.3 1.2-3.8 2.3-4.8 0 2.1.9 3.3 2.2 3.3 0-3.4 1-6 1-8z"/></svg>'
  };

  /* ---------- views: sign-in and onboarding ---------- */
  function langSwitch() {
    return `<div class="lang-switch" role="group" aria-label="${esc(t('language'))}">${LANGS.map((l) =>
      `<button type="button" class="seg-btn" aria-pressed="${l === lang}" data-action="lang" data-lang="${l}">${l === 'de' ? 'Deutsch' : 'English'}</button>`).join('')}</div>`;
  }

  function renderAuth() {
    const keep = {};
    ['auth-name', 'auth-email', 'auth-pass'].forEach((id) => { const i = $(id); if (i) keep[id] = i.value; });
    const reg = S.authMode === 'register';
    $('view-auth').innerHTML = `
      <div class="auth-hero">
        <h1 class="display">${t('auth_title')}</h1>
        <p class="lede">${t('auth_lede')}</p>
      </div>
      ${langSwitch()}
      <section class="card">
        <div class="seg" role="tablist">
          <button type="button" role="tab" class="seg-btn" aria-selected="${!reg}" data-action="auth-mode" data-mode="login">${t('login')}</button>
          <button type="button" role="tab" class="seg-btn" aria-selected="${reg}" data-action="auth-mode" data-mode="register">${t('register')}</button>
        </div>
        <form id="auth-form" class="form" novalidate>
          ${reg ? `<div class="field"><label for="auth-name">${t('your_name')}</label><input class="input" id="auth-name" autocomplete="nickname" maxlength="30"></div>` : ''}
          <div class="field"><label for="auth-email">${t('email')}</label><input class="input" id="auth-email" type="email" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false"></div>
          <div class="field"><label for="auth-pass">${t('password')}</label><input class="input" id="auth-pass" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}">${reg ? `<p class="hint">${t('password_hint')}</p>` : ''}</div>
          <p class="form-error" id="auth-error" role="alert" hidden></p>
          <button class="btn block" type="submit">${reg ? t('register_cta') : t('login_cta')}</button>
        </form>
        <p class="hint">${t('auth_note')}</p>
      </section>`;
    Object.keys(keep).forEach((id) => { const i = $(id); if (i) i.value = keep[id]; });
  }

  function renderOnboard() {
    $('view-onboard').innerHTML = `
      <div><p class="eyebrow">${t('onboard_eyebrow')}</p><h1 class="display">${t('hello', esc(S.me.display_name))}</h1><p class="lede">${t('onboard_lede')}</p></div>
      <section class="card">
        <h2 class="card-title">${t('create_group')}</h2>
        <form id="create-form" class="form" novalidate>
          <div class="field"><label for="group-name">${t('group_name')}</label><input class="input" id="group-name" maxlength="40" value="Wochenduell"></div>
          <button class="btn block" type="submit">${t('create_group_cta')}</button>
        </form>
      </section>
      <section class="card">
        <h2 class="card-title">${t('join_group')}</h2>
        <form id="join-form" class="form" novalidate>
          <div class="field"><label for="join-code">${t('invite_code')}</label><input class="input code-input" id="join-code" placeholder="WD-XXXXXX" autocapitalize="characters" autocomplete="off" spellcheck="false" maxlength="9"></div>
          <p class="form-error" id="join-error" role="alert" hidden></p>
          <button class="btn block ghost" type="submit">${t('join_cta')}</button>
        </form>
      </section>
      ${langSwitch()}
      <button class="link-btn" data-action="logout">${t('logout')}</button>`;
  }

  /* ---------- views: app ---------- */
  function inviteCard() {
    return `<section class="card">
      <h2 class="card-title">${t('invite_friends')}</h2>
      <div class="invite"><span class="code" id="invite-code">${esc(S.group.invite_code)}</span><button class="btn ghost" data-action="copy-code">${t('copy_code')}</button></div>
      <p class="hint">${t('invite_hint')}</p>
    </section>`;
  }

  function renderHeute() {
    const c = ctx();
    const uid = S.user.id;
    const solo = S.members.length < 2;
    const r = ranking(c.past);
    const i = Math.max(0, r.findIndex((e) => e.id === uid));
    const me = r[i] || { total: 0 };

    let line;
    if (solo) line = t('solo_line');
    else if (i === 0) {
      const lead = me.total - r[1].total;
      line = lead === 0 ? t('tie', esc(nameOf(r[1].id))) : t('leading', lead, esc(nameOf(r[1].id)));
    } else {
      const a = r[i - 1];
      const gap = a.total - me.total;
      line = gap === 0 ? t('tie', esc(nameOf(a.id))) : t('behind', gap, esc(nameOf(a.id)), i === 1);
    }

    const s = statOf(uid, c.todayKey) || {};
    const ws = workoutsOf(uid, c.todayKey);
    const tp = score(uid, c.todayKey);
    const mins = ws.reduce((a, w) => a + w.minutes, 0);
    const src = srcName(s.source);
    const rows = [
      { k: 'steps', val: s.steps != null ? fmt(s.steps) : '–', sub: s.steps != null ? src : t('no_value') },
      { k: 'burn', val: s.active_kcal != null ? `${fmt(s.active_kcal)} kcal` : '–', sub: s.active_kcal != null ? src : t('no_value') },
      { k: 'train', val: ws.length ? `${t('workouts_n', ws.length)} · ${mins} ${t('min')}` : t('none_yet'), sub: ws.length ? ws.map((w) => esc(sportName(w.sport))).join(', ') : t('train_hint') },
      { k: 'food', val: s.eaten_kcal != null ? `${fmt(s.eaten_kcal)} / ${fmt(S.me.calorie_goal)} kcal` : '–', sub: s.eaten_kcal != null ? t('food_sub') : t('food_hint', fmt(S.me.calorie_goal)) }
    ];
    const left = { train: CAP.train - tp.train, steps: CAP.steps - tp.steps, burn: CAP.burn - tp.burn };
    const leftTotal = left.train + left.steps + left.burn;

    const rival = solo ? null : (i === 0 ? r[1] : r[0]);
    const mine = c.all.map((d) => (d <= c.todayKey ? score(uid, d).total : null));
    const theirs = c.all.map((d) => (rival && d <= c.todayKey ? score(rival.id, d).total : null));
    const scale = Math.ceil(Math.max(40, ...mine.concat(theirs).filter((v) => v != null)) / 10) * 10;
    const pct = (v) => ((v / scale) * 100).toFixed(1) + '%';
    const names = t('days_short');
    const dateLine = new Intl.DateTimeFormat(locale(), { weekday: 'long', day: 'numeric', month: 'short' }).format(c.today);

    return `
      <div>
        <p class="eyebrow">${esc(dateLine)} · ${t('kw')} ${c.week}</p>
        <h1 class="display">${solo ? t('your_week') : t('place', i + 1)}</h1>
        <p class="lede">${line}</p>
      </div>
      <section class="card">
        <div class="card-head"><h2 class="card-title">${t('card_today')}</h2><button class="link-btn" data-action="open-rules">${t('rules_link')}</button></div>
        <div class="today-total"><span class="bignum">${tp.total}</span><span class="bignum-label">${t('points_today')}</span></div>
        <div class="metrics">
          ${rows.map((m) => `<div class="metric cat-${m.k}">
            <span class="metric-label"><i class="dot"></i>${t('cat_' + m.k)}</span><span class="metric-val">${m.val}</span>
            <span class="metric-sub">${m.sub}</span><span class="metric-pts">${tp[m.k]} / ${CAP[m.k]} ${t('pts')}</span>
            <span class="bar"><i style="width:${(tp[m.k] / CAP[m.k]) * 100}%"></i></span>
          </div>`).join('')}
        </div>
        ${syncButton('block')}
        <div class="actions">
          <button class="btn ghost" data-action="open-values">${t('enter_values')}</button>
          <button class="btn ghost" data-action="open-workout">${t('add_workout')}</button>
        </div>
      </section>
      ${leftTotal > 0 ? `<section class="card">
        <div class="card-head"><h2 class="card-title">${t('still_possible')}</h2><span class="muted" style="font-weight:700">+${leftTotal} ${t('pts')}</span></div>
        <div class="chips">
          ${left.train ? `<span class="chip cat-train"><i class="dot"></i>+${left.train} ${t('cat_train')}</span>` : ''}
          ${left.steps ? `<span class="chip cat-steps"><i class="dot"></i>+${left.steps} ${t('cat_steps')}</span>` : ''}
          ${left.burn ? `<span class="chip cat-burn"><i class="dot"></i>+${left.burn} ${t('cat_burn')}</span>` : ''}
        </div>
      </section>` : ''}
      <section class="card">
        <div class="card-head"><h2 class="card-title">${t('week_card')}</h2><span class="muted" style="font-weight:700">${me.total} ${t('pts')}</span></div>
        <div class="week" role="img" aria-label="${esc(c.past.map((d, j) => `${names[j]} ${mine[j]}`).join(', '))}">
          ${c.all.map((d, j) => `<div class="wk-col${d === c.todayKey ? ' today' : ''}">
            <div class="wk-plot">${mine[j] == null ? '<div class="wk-bar future"></div>'
              : `<div class="wk-bar me" style="height:${pct(mine[j])}"><span class="wk-val">${mine[j]}</span></div>${rival ? `<div class="wk-bar rv" style="height:${pct(theirs[j])}"></div>` : ''}`}</div>
            <span class="wk-day">${names[j]}</span></div>`).join('')}
        </div>
        <div class="legend"><span><i class="sw me"></i>${t('you')}</span>${rival ? `<span><i class="sw rv"></i>${esc(nameOf(rival.id))} (${t('rank_label', i === 0 ? 2 : 1)})</span>` : ''}</div>
      </section>
      ${solo ? inviteCard() : ''}`;
  }

  /* ---------- the weekly race on a tartan track ---------- */
  // Stadium seen from above. Runners go anticlockwise from the finish line (end of the
  // bottom straight). The leader sits just before the finish, everyone else as far back
  // as their points are behind. Each person runs in their own lane; outer lanes get a
  // staggered start like on a real track so nobody hides behind anyone else.
  const TRACK = { cx: 180, cy: 112, half: 70, rOut: 100, width: 62 };
  const STAGGER = 0.025;
  const RUNNER_R = 10;
  function lanePoint(radius, f) {
    const { cx, cy, half } = TRACK;
    const arc = Math.PI * radius;
    let d = (((f % 1) + 1) % 1) * (4 * half + 2 * arc);
    if (d < arc) { const a = Math.PI / 2 - d / radius; return [cx + half + radius * Math.cos(a), cy + radius * Math.sin(a)]; }
    d -= arc;
    if (d < 2 * half) return [cx + half - d, cy - radius];
    d -= 2 * half;
    if (d < arc) { const a = -Math.PI / 2 - d / radius; return [cx - half + radius * Math.cos(a), cy + radius * Math.sin(a)]; }
    d -= arc;
    return [cx - half + d, cy + radius];
  }
  const stadium = (r, attrs) => {
    const { cx, cy, half } = TRACK;
    return `<rect x="${cx - half - r}" y="${cy - r}" width="${2 * half + 2 * r}" height="${2 * r}" rx="${r}" ${attrs}/>`;
  };
  function raceTrack(r, c) {
    const { cx, cy, half, rOut, width } = TRACK;
    const rIn = rOut - width;
    const lanes = Math.min(8, Math.max(4, r.length));
    const laneW = width / lanes;
    const lead = r.length && r[0].total > 0 ? r[0].total : 0;
    const lines = Array.from({ length: lanes - 1 }, (_, k) => stadium(rIn + (k + 1) * laneW, 'class="lane-line"')).join('');
    // Place in ranking order; anyone who would cover someone already placed steps back a little.
    const placed = [];
    r.forEach((e, idx) => {
      const lane = idx % lanes;
      const radius = rIn + (lane + 0.5) * laneW;
      let f = (lead ? 0.06 + 0.86 * (e.total / lead) : 0) + lane * STAGGER;
      let [x, y] = lanePoint(radius, f);
      for (let n = 0; n < 40 && placed.some((p) => Math.hypot(p.x - x, p.y - y) < 2 * RUNNER_R + 2); n++) {
        f -= 0.006;
        [x, y] = lanePoint(radius, f);
      }
      placed.push({ e, idx, radius, f, x, y });
    });
    // draw the leader last so they sit on top
    const runners = placed.slice().reverse().map(({ e, idx, radius, f, x, y }) => {
      const label = initials(e.id);
      return `<g class="runner${isMe(e.id) ? ' me' : ''}${idx === 0 && lead ? ' lead' : ''}" data-radius="${radius.toFixed(2)}" data-f="${f.toFixed(4)}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">
        <circle r="${RUNNER_R}"/><text dy="3" font-size="${label.length > 2 ? 7 : 8.5}">${esc(label)}</text></g>`;
    }).join('');
    const aria = r.map((e, i) => `${i + 1}. ${nameOf(e.id)} ${e.total} ${t('points')}`).join(', ');
    return `<svg class="track" viewBox="0 0 360 224" role="img" aria-label="${esc(t('race_aria', aria))}">
      ${stadium(rOut, 'class="track-surface"')}
      ${lines}
      ${stadium(rIn, 'class="track-infield"')}
      <text class="track-week" x="${cx}" y="${cy + 9}">${t('kw')} ${c.week}</text>
      <rect class="track-finish" x="${cx + half - 1.5}" y="${cy + rIn}" width="3" height="${width}"/>
      <text class="track-finish-label" x="${cx + half - 5}" y="${cy + rIn - 6}">${t('finish')}</text>
      ${runners}
    </svg>`;
  }
  function animateTrack() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const runners = [...document.querySelectorAll('#view-rangliste .runner')].map((g) => ({
      g, radius: +g.dataset.radius, f: +g.dataset.f
    }));
    if (!runners.length) return;
    const t0 = performance.now();
    const dur = 1100;
    const ease = (x) => 1 - Math.pow(1 - x, 3);
    function frame(now) {
      const p = Math.min(1, (now - t0) / dur);
      runners.forEach((r) => {
        const [x, y] = lanePoint(r.radius, r.f * ease(p));
        r.g.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
      });
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function renderRangliste() {
    const c = ctx();
    const r = ranking(c.past);
    const top = r[0];
    const second = r[1];
    const max = (top && top.total) || 1;

    const line = top && top.total > 0
      ? t('race_line', isMe(top.id), esc(nameOf(top.id)), top.total, second ? top.total - second.total : 0,
          second ? (isMe(second.id) ? t('you_dative') : esc(nameOf(second.id))) : '')
      : t('race_start');
    const hero = `<section class="card race">${raceTrack(r, c)}<p class="race-line">${line}</p></section>`;

    const past = [1, 2, 3, 4].map((w) => {
      const st = addDays(c.start, -7 * w);
      const rr = ranking(weekDays(st));
      return rr[0] && rr[0].total > 0 ? { kw: isoWeek(st), id: rr[0].id, pts: rr[0].total } : null;
    }).filter(Boolean);

    return `
      <div class="head-row">
        <div><p class="eyebrow">${t('ranking_eyebrow', c.week)}</p><h1 class="display">${t('ranking')}</h1></div>
        <button class="link-btn" data-action="open-rules" style="padding-bottom:12px">${t('rules_link')}</button>
      </div>
      ${hero}
      <section class="card">
        <div class="lb">
          ${r.map((e, idx) => `<div class="lb-item">
            <button class="lb-row${isMe(e.id) ? ' is-me' : ''}" data-action="toggle-row" data-id="${e.id}" aria-expanded="${S.open === e.id}">
              <span class="lb-rank">${idx + 1}</span>${av(e.id)}
              <span class="lb-main"><span class="lb-name">${esc(nameOf(e.id))}${idx === 0 && e.total > 0 ? `<span class="crown">${t('leads')}</span>` : ''}</span>
                <span class="stack">${CATS.map((k) => `<i class="cat-${k}" style="width:${((e[k] / max) * 100).toFixed(1)}%"></i>`).join('')}</span></span>
              <span class="lb-total">${e.total}<small>${t('pts')}</small></span>
            </button>
            <div class="lb-detail"${S.open === e.id ? '' : ' hidden'}>${CATS.map((k) => `<div class="cat-${k}"><i class="dot"></i>${t('cat_' + k)}<b>${e[k]}</b></div>`).join('')}</div>
          </div>`).join('')}
        </div>
        <div class="legend">${CATS.map((k) => `<span class="cat-${k}"><i class="dot"></i>${t('cat_' + k)}</span>`).join('')}</div>
      </section>
      ${past.length ? `<section class="card">
        <h2 class="card-title">${t('past_winners')}</h2>
        <div class="past">${past.map((w) => `<div class="past-row"><span class="past-kw">${t('kw')} ${w.kw}</span>${av(w.id)}<span>${esc(nameOf(w.id))}</span><span class="past-pts">${w.pts} ${t('pts')}</span></div>`).join('')}</div>
      </section>` : ''}
      ${inviteCard()}`;
  }

  function feedItems() {
    const c = ctx();
    const since = keyOf(addDays(c.today, -6));
    const items = [];
    S.workouts.filter((w) => w.day >= since).forEach((w) => items.push({
      kind: 'workout', id: w.id, uid: w.user_id, day: w.day, at: w.started_at,
      title: `${esc(sportName(w.sport))} · ${w.minutes} ${t('min')}`, pts: oneWorkout(w.minutes), src: srcName(w.source)
    }));
    S.stats.forEach((s) => {
      if (s.day >= since && s.steps >= 12000) items.push({
        kind: 'steps', id: 's-' + s.user_id + s.day, uid: s.user_id, day: s.day, at: s.updated_at,
        title: t('steps_day', fmt(s.steps)), pts: stepPts(s.steps), src: srcName(s.source)
      });
    });
    c.past.filter((d) => d < c.todayKey && d >= since).forEach((d) => {
      const best = S.members.map((m) => ({ id: m.id, p: score(m.id, d).total })).sort((a, b) => b.p - a.p)[0];
      if (best && best.p > 0 && S.members.length > 1) items.push({
        kind: 'winner', id: 'd-' + d, uid: best.id, day: d, at: d + 'T23:59:00',
        title: t('day_win', esc(weekdayLong(d)), best.p)
      });
    });
    return items.sort((a, b) => b.day.localeCompare(a.day) || String(b.at).localeCompare(String(a.at)));
  }

  function renderFeed() {
    const c = ctx();
    const yesterday = keyOf(addDays(c.today, -1));
    const items = feedItems();
    let html = `<div><p class="eyebrow">${t('feed_eyebrow', S.members.length)}</p><h1 class="display">Feed</h1><p class="lede">${t('feed_lede')}</p></div>`;
    if (!items.length) return html + `<section class="card"><p class="empty">${t('feed_empty')}</p><button class="btn" data-action="open-workout">${t('add_workout')}</button></section>`;
    const days = [...new Set(items.map((it) => it.day))];
    days.forEach((day) => {
      const label = day === c.todayKey ? t('today') : day === yesterday ? t('yesterday') : weekdayLong(day);
      html += `<p class="day-head">${esc(label)}</p><div class="posts">` + items.filter((it) => it.day === day).map((it) => {
        let foot = '';
        if (it.kind === 'winner') foot = `<span class="src">${t('day_rating')}</span>`;
        else foot = `<span class="src">${esc(it.src)}</span>` + (it.pts ? `<span class="pts">+${it.pts} ${t('pts')}</span>` : it.kind === 'workout' ? `<span class="src">${t('under_20')}</span>` : '');
        if (it.kind === 'workout') {
          const k = S.kudos.get(it.id) || { n: 0, mine: false };
          if (isMe(it.uid)) {
            foot += `<span class="kudos-count">${I.flame}${k.n}</span><button class="post-del" data-action="delete-workout" data-id="${it.id}">${t('delete')}</button>`;
          } else {
            foot += `<button class="kudos" data-action="kudos" data-id="${it.id}" aria-pressed="${k.mine}" aria-label="${esc(t('kudos_aria', k.n))}">${I.flame}${k.n}</button>`;
          }
        }
        const time = it.kind === 'winner' ? '' : timeOf(it.at);
        return `<article class="post${it.kind === 'winner' ? ' winner' : ''}">
          ${av(it.uid)}
          <div>
            <div class="post-top"><span class="post-who">${esc(nameOf(it.uid))}</span><span class="post-time">${esc(time)}</span></div>
            <p class="post-title">${it.title}</p>
            <div class="post-foot">${foot}</div>
          </div>
        </article>`;
      }).join('') + '</div>';
    });
    return html;
  }

  function renderProfil() {
    const g = S.group;
    return `
      <div><p class="eyebrow">${t('profile_eyebrow')}</p><h1 class="display">${esc(S.me.display_name)}</h1></div>
      <section class="card">
        <h2 class="card-title">${t('profile')}</h2>
        <form id="profile-form" class="form" novalidate>
          <div class="field"><label for="p-name">${t('your_name')}</label><input class="input" id="p-name" maxlength="30" value="${esc(S.me.display_name)}"></div>
          <div class="field"><label for="p-goal">${t('calorie_goal')}</label>
            <div class="goal-row"><input class="input" id="p-goal" type="number" inputmode="numeric" min="1000" max="5000" step="50" value="${S.me.calorie_goal}"><span class="muted">kcal</span></div>
            <p class="hint">${t('goal_hint')}</p></div>
          <p class="form-error" id="profile-error" role="alert" hidden></p>
          <button class="btn" type="submit">${t('save')}</button>
        </form>
      </section>
      <section class="card"><h2 class="card-title">${t('language')}</h2>${langSwitch()}</section>
      <section class="card">
        <h2 class="card-title">${t('your_group')}</h2>
        <p><strong>${esc(g.name)}</strong></p>
        <div class="invite"><span class="code" id="invite-code">${esc(g.invite_code)}</span><button class="btn ghost" data-action="copy-code">${t('copy_code')}</button></div>
        <p class="hint">${t('invite_hint')}</p>
        <div class="members">${S.members.map((m) => `<div class="member">${av(m.id)}<span>${esc(m.display_name)}${isMe(m.id) ? ` (${t('you')})` : ''}</span></div>`).join('')}</div>
      </section>
      ${healthCard()}
      <section class="card">
        <div class="conn-head"><span class="conn-icon">${I.food}</span><div class="conn-name"><b>${t('food_title')}</b><span class="muted">${t('food_desc')}</span></div><span class="status ${healthConnected() ? 'on' : 'off'}">${t('via_health')}</span></div>
        <p class="hint">${t('food_how')}</p>
      </section>
      <section class="card">
        <div class="conn-head"><span class="conn-icon">${I.band}</span><div class="conn-name"><b>Whoop</b><span class="muted">${t('whoop_desc')}</span></div><span class="status ${healthConnected() ? 'on' : 'off'}">${t('via_health')}</span></div>
        <p class="hint">${t('whoop_how')}</p>
      </section>
      <button class="btn ghost block" data-action="logout">${t('logout')}</button>`;
  }

  /* ---------- Apple Health (iPhone Shortcut) ---------- */
  const syncUrl = () => (S.sync ? `${cfg.url}/functions/v1/health-sync?key=${S.sync.key}` : '');
  const healthConnected = () => !!(S.sync && S.sync.last_used_at);
  function whenText(iso) {
    const d = new Date(iso);
    const time = d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
    if (keyOf(d) === keyOf(new Date())) return t('today_at', time);
    return d.toLocaleDateString(locale(), { day: 'numeric', month: 'short' }) + ' ' + time;
  }
  // The ready-made Shortcut is the same for everyone; the button hands it the personal key.
  const SHORTCUT_NAME = 'Wochenduell Sync';
  const SHORTCUT_FILE = 'shortcut/Wochenduell%20Sync.shortcut?v=2';
  const runShortcutUrl = () => `shortcuts://run-shortcut?name=${encodeURIComponent(SHORTCUT_NAME)}&input=text&text=${encodeURIComponent(S.sync ? S.sync.key : '')}`;
  const syncButton = (cls) => (S.sync ? `<a class="btn ${cls || ''}" href="${esc(runShortcutUrl())}" data-action="run-sync">${t('sync_now')}</a>` : '');
  function healthCard() {
    const on = healthConnected();
    return `<section class="card">
      <div class="conn-head"><span class="conn-icon">${I.heart}</span><div class="conn-name"><b>Apple Health</b><span class="muted">${t('health_desc')}</span></div>
        <span class="status ${on ? 'on' : 'off'}">${on ? t('connected') : t('not_set_up')}</span></div>
      ${on ? `<p class="hint">${t('last_sync', esc(whenText(S.sync.last_used_at)))}</p>` : ''}
      ${syncButton('block')}
      <div class="actions">
        <a class="btn ghost" href="${SHORTCUT_FILE}">${t('add_shortcut')}</a>
        <button class="btn ghost" data-action="open-health">${t('guide')}</button>
      </div>
      <button class="link-btn" data-action="reset-sync">${t('new_link')}</button>
    </section>`;
  }
  function renderHealthGuide() {
    $('health-body').innerHTML = `
      <div class="grip"></div>
      <div><h2 id="ht">${t('guide_title')}</h2><p class="hint" style="margin-top:6px">${t('guide_lede')}</p></div>
      <ol class="guide">${t('guide_steps').map(([title, text]) => `<li><b>${title}</b><span>${text}</span></li>`).join('')}</ol>
      <p class="hint">${t('guide_note')}</p>
      <div class="actions">
        <a class="btn ghost" href="${SHORTCUT_FILE}">${t('add_shortcut')}</a>
        <button type="button" class="btn" data-action="close-sheet">${t('got_it')}</button>
      </div>`;
  }
  // Coming back from the Shortcut: reload and say whether new values arrived.
  async function afterSync() {
    const before = S.syncBefore;
    const arrived = () => !!(S.sync && S.sync.last_used_at && S.sync.last_used_at !== before);
    await refresh();
    if (!arrived()) { await new Promise((r) => setTimeout(r, 3000)); await refresh(); }
    S.syncStarted = 0;
    toast(arrived() ? t('synced_ok') : t('synced_none'));
  }
  async function copySync() {
    const url = syncUrl();
    if (!url) return;
    try { await navigator.clipboard.writeText(url); toast(t('link_copied')); } catch (e) {
      const el = $('sync-link');
      if (!el) return;
      const r = document.createRange();
      r.selectNodeContents(el);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
      toast(t('link_selected'));
    }
  }
  async function resetSync() {
    if (!window.confirm(t('confirm_new_link'))) return;
    const { data, error } = await sb.rpc('reset_sync_key');
    if (error) { console.error(error); toast(t('err_generic')); return; }
    S.sync = { key: data, last_used_at: null };
    render();
    toast(t('new_link_done'));
  }

  function renderRules() {
    $('rules-body').innerHTML = `
      <div class="grip"></div>
      <div><h2 id="rt">${t('rules_title')}</h2><p class="hint" style="margin-top:6px">${t('rules_lede')}</p></div>
      <div class="rules">
        ${[['steps', 25], ['burn', 20], ['train', 30], ['food', 10]].map(([k, m]) => `<div class="rule cat-${k}"><span class="rule-name"><i class="dot"></i>${t('cat_' + k)}</span><span class="rule-max">${m}<small>${t('max_day')}</small></span><p>${t('rule_' + k)}</p></div>`).join('')}
      </div>
      <p class="hint">${t('rules_fair')}</p>
      <button type="button" class="btn" data-action="close-sheet">${t('got_it')}</button>`;
  }

  function renderSportOpts() {
    const box = $('sport-opts');
    const cur = (box.querySelector('input:checked') || {}).value || 'strength';
    box.innerHTML = SPORTS.map((s) => `<label class="opt"><input type="radio" name="sport" value="${s}"${s === cur ? ' checked' : ''}><span>${esc(sportName(s))}</span></label>`).join('');
  }

  /* ---------- screen switching ---------- */
  const MAIN = ['heute', 'rangliste', 'feed', 'profil'];
  function show(view) {
    S.view = view;
    $('view-loading').hidden = view !== 'loading';
    $('view-auth').hidden = view !== 'auth';
    $('view-onboard').hidden = view !== 'onboard';
    MAIN.forEach((v) => { $('view-' + v).hidden = !(view === 'main' && S.tab === v); });
    $('tabbar').hidden = view !== 'main';
    document.querySelectorAll('[data-tab]').forEach((b) => {
      if (b.dataset.tab === S.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    const pill = $('group-pill');
    pill.hidden = !(view === 'main' && S.group);
    if (S.group) pill.textContent = S.group.name;
    render();
  }
  function render() {
    if (S.view === 'auth') renderAuth();
    else if (S.view === 'onboard') renderOnboard();
    else if (S.view === 'main') {
      $('view-heute').innerHTML = renderHeute();
      $('view-rangliste').innerHTML = renderRangliste();
      $('view-feed').innerHTML = renderFeed();
      $('view-profil').innerHTML = renderProfil();
    }
  }
  function setTab(tab) {
    S.tab = tab;
    try { localStorage.setItem('wd-tab', tab); } catch (e) {}
    show('main');
    window.scrollTo(0, 0);
    if (tab === 'rangliste') animateTrack();
  }

  async function enter() {
    show('loading');
    try {
      await load();
      show(S.group ? 'main' : 'onboard');
    } catch (e) {
      console.error(e);
      toast(t('err_generic'));
      show('auth');
    }
  }
  async function refresh() {
    try {
      await load();
      if (S.view === 'onboard' && S.group) show('main'); else render();
    } catch (e) { console.error(e); }
  }

  /* ---------- feedback ---------- */
  let toastTimer;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
  }
  function formError(id, msg) {
    const el = $(id);
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
  }
  async function busy(form, fn) {
    const btn = form.querySelector('[type="submit"]');
    if (btn) btn.disabled = true;
    try { await fn(); } finally { if (btn && document.body.contains(btn)) btn.disabled = false; }
  }
  function authMessage(e) {
    const m = String((e && (e.code || '')) + ' ' + (e && e.message || '')).toLowerCase();
    if (m.includes('invalid_credentials') || m.includes('invalid login')) return t('err_login');
    if (m.includes('user_already_exists') || m.includes('already registered')) return t('err_exists');
    if (m.includes('weak_password') || m.includes('password')) return t('err_password');
    if (m.includes('email_address_invalid') || m.includes('validation_failed') || m.includes('email')) return t('err_email');
    if (m.includes('rate') || m.includes('over_')) return t('err_rate');
    return t('err_generic');
  }

  /* ---------- sheets ---------- */
  let opener = null;
  function openSheet(id, from) {
    opener = from || null;
    if (id === 'sheet-workout') updatePreview();
    if (id === 'sheet-rules') renderRules();
    if (id === 'sheet-health') renderHealthGuide();
    if (id === 'sheet-values') {
      const s = statOf(S.user.id, ctx().todayKey) || {};
      $('v-steps').value = s.steps == null ? '' : s.steps;
      $('v-burn').value = s.active_kcal == null ? '' : s.active_kcal;
      $('v-food').value = s.eaten_kcal == null ? '' : s.eaten_kcal;
      formError('values-error', '');
    }
    $(id).hidden = false;
    document.body.style.overflow = 'hidden';
    const f = $(id).querySelector('input:checked, input, button');
    if (f) f.focus({ preventScroll: true });
  }
  function closeSheets() {
    document.querySelectorAll('.backdrop').forEach((b) => { b.hidden = true; });
    document.body.style.overflow = '';
    if (opener && document.body.contains(opener)) opener.focus();
    opener = null;
  }
  function workoutDelta(m) {
    const ws = workoutsOf(S.user.id, ctx().todayKey);
    return trainPts(ws.concat({ minutes: m })) - trainPts(ws);
  }
  function updatePreview() {
    const m = +$('dur').value;
    const delta = workoutDelta(m);
    const pv = $('preview');
    $('dur-out').textContent = `${m} ${t('min')}`;
    pv.classList.toggle('zero', delta <= 0);
    pv.innerHTML = delta > 0 ? `<span>${t('preview_gain')}</span><span>+${delta} ${t('pts')}</span>`
      : m < 20 ? `<span>${t('preview_min')}</span>` : `<span>${t('preview_max')}</span>`;
  }

  /* ---------- actions ---------- */
  async function copyCode() {
    const code = S.group ? S.group.invite_code : '';
    const select = () => {
      const el = $('invite-code');
      if (!el) return;
      const r = document.createRange();
      r.selectNodeContents(el);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
      toast(t('code_selected'));
    };
    try { await navigator.clipboard.writeText(code); toast(t('code_copied')); } catch (e) { select(); }
  }

  async function toggleKudos(btn) {
    const id = btn.dataset.id;
    const k = S.kudos.get(id) || { n: 0, mine: false };
    const next = { n: k.n + (k.mine ? -1 : 1), mine: !k.mine };
    S.kudos.set(id, next);
    btn.setAttribute('aria-pressed', next.mine);
    btn.setAttribute('aria-label', t('kudos_aria', next.n));
    btn.innerHTML = I.flame + next.n;
    const res = k.mine
      ? await sb.from('kudos').delete().eq('workout_id', id).eq('user_id', S.user.id)
      : await sb.from('kudos').insert({ workout_id: id });
    if (res.error) {
      console.error(res.error);
      S.kudos.set(id, k);
      render();
      toast(t('err_generic'));
    }
  }

  async function deleteWorkout(id) {
    if (!window.confirm(t('confirm_delete'))) return;
    const res = await sb.from('workouts').delete().eq('id', id);
    if (res.error) { console.error(res.error); toast(t('err_generic')); return; }
    await refresh();
    toast(t('deleted'));
  }

  async function changeLang(l) {
    useLang(l);
    render();
    if (S.me && S.user) {
      S.me.language = l;
      const res = await sb.from('profiles').update({ language: l }).eq('id', S.user.id);
      if (res.error) console.error(res.error);
    }
  }

  const intOrNull = (v) => {
    const s = String(v).trim().replace(/[\s.,']/g, '');
    if (s === '') return null;
    if (!/^\d+$/.test(s)) return NaN;
    return parseInt(s, 10);
  };

  document.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) { setTab(tabBtn.dataset.tab); return; }
    const a = e.target.closest('[data-action]');
    if (!a) return;
    const act = a.dataset.action;
    if (act === 'backdrop') { if (e.target === a) closeSheets(); return; }
    if (act === 'auth-mode') { S.authMode = a.dataset.mode; renderAuth(); }
    else if (act === 'lang') changeLang(a.dataset.lang);
    else if (act === 'logout') sb.auth.signOut();
    else if (act === 'open-workout') openSheet('sheet-workout', a);
    else if (act === 'open-values') openSheet('sheet-values', a);
    else if (act === 'open-rules') openSheet('sheet-rules', a);
    else if (act === 'close-sheet') closeSheets();
    else if (act === 'copy-code') copyCode();
    else if (act === 'copy-sync') copySync();
    else if (act === 'run-sync') { S.syncStarted = Date.now(); S.syncBefore = S.sync ? S.sync.last_used_at : null; }
    else if (act === 'open-health') openSheet('sheet-health', a);
    else if (act === 'reset-sync') resetSync();
    else if (act === 'kudos') toggleKudos(a);
    else if (act === 'delete-workout') deleteWorkout(a.dataset.id);
    else if (act === 'toggle-row') {
      S.open = S.open === a.dataset.id ? null : a.dataset.id;
      document.querySelectorAll('.lb-row').forEach((b) => {
        const on = b.dataset.id === S.open;
        b.setAttribute('aria-expanded', on);
        b.nextElementSibling.hidden = !on;
      });
    }
  });

  document.addEventListener('submit', (e) => {
    const form = e.target;
    e.preventDefault();

    if (form.id === 'auth-form') busy(form, async () => {
      formError('auth-error', '');
      const email = $('auth-email').value.trim();
      const password = $('auth-pass').value;
      if (S.authMode === 'register') {
        const name = $('auth-name').value.trim();
        if (!name) return formError('auth-error', t('err_name'));
        if (password.length < 8) return formError('auth-error', t('err_password'));
        const { data, error } = await sb.auth.signUp({ email, password, options: { data: { display_name: name, language: lang } } });
        if (error) return formError('auth-error', authMessage(error));
        if (!data.session) formError('auth-error', t('check_mail'));
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) return formError('auth-error', authMessage(error));
      }
    });

    else if (form.id === 'create-form') busy(form, async () => {
      const name = $('group-name').value.trim() || 'Wochenduell';
      const { error } = await sb.rpc('create_group', { group_name: name });
      if (error) { console.error(error); toast(t('err_generic')); return; }
      await enter();
      toast(t('group_created'));
    });

    else if (form.id === 'join-form') busy(form, async () => {
      formError('join-error', '');
      let code = $('join-code').value.trim().toUpperCase().replace(/\s+/g, '');
      if (/^[A-Z0-9]{6}$/.test(code)) code = 'WD-' + code;
      const { data, error } = await sb.rpc('join_group', { code });
      if (error) { formError('join-error', String(error.message).includes('invalid_code') ? t('err_code') : t('err_generic')); return; }
      await enter();
      toast(t('group_joined', data && data.name ? data.name : ''));
    });

    else if (form.id === 'profile-form') busy(form, async () => {
      formError('profile-error', '');
      const display_name = $('p-name').value.trim();
      const goal = intOrNull($('p-goal').value);
      if (!display_name) return formError('profile-error', t('err_name'));
      if (goal == null || Number.isNaN(goal)) return formError('profile-error', t('err_number'));
      const calorie_goal = Math.min(5000, Math.max(1000, Math.round(goal / 50) * 50));
      const { error } = await sb.from('profiles').update({ display_name, calorie_goal }).eq('id', S.user.id);
      if (error) { console.error(error); formError('profile-error', t('err_generic')); return; }
      await refresh();
      toast(t('saved'));
    });

    else if (form.id === 'workout-form') busy(form, async () => {
      const sport = (form.querySelector('input[name="sport"]:checked') || {}).value || 'other';
      const minutes = +$('dur').value;
      const delta = workoutDelta(minutes);
      const { error } = await sb.from('workouts').insert({ day: ctx().todayKey, started_at: new Date().toISOString(), sport, minutes, source: 'manual' });
      if (error) { console.error(error); toast(t('err_generic')); return; }
      closeSheets();
      await refresh();
      if (S.tab !== 'heute' && S.tab !== 'feed') setTab('heute');
      toast(t('workout_added', sportName(sport), delta));
    });

    else if (form.id === 'values-form') busy(form, async () => {
      formError('values-error', '');
      const steps = intOrNull($('v-steps').value);
      const active_kcal = intOrNull($('v-burn').value);
      const eaten_kcal = intOrNull($('v-food').value);
      if ([steps, active_kcal, eaten_kcal].some((v) => Number.isNaN(v))) return formError('values-error', t('err_number'));
      const row = { user_id: S.user.id, day: ctx().todayKey, steps, active_kcal, eaten_kcal, source: 'manual' };
      const { error } = await sb.from('daily_stats').upsert(row, { onConflict: 'user_id,day' });
      if (error) { console.error(error); formError('values-error', t('err_generic')); return; }
      closeSheets();
      await refresh();
      toast(t('values_saved'));
    });
  });

  $('dur').addEventListener('input', updatePreview);
  document.addEventListener('change', (e) => { if (e.target.name === 'sport') updatePreview(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheets(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || S.view !== 'main') return;
    if (S.syncStarted && Date.now() - S.syncStarted < 10 * 60 * 1000) afterSync();
    else refresh();
  });

  /* ---------- install hint (iPhone Safari, not yet on the home screen) ---------- */
  (function installHint() {
    const KEY = 'wochenduell-install-hint';
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const standalone = navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
    let dismissed = false;
    try { dismissed = localStorage.getItem(KEY) === '1'; } catch (e) {}
    const el = $('install');
    if (ios && !standalone && !dismissed) el.hidden = false;
    $('install-x').addEventListener('click', () => { el.hidden = true; try { localStorage.setItem(KEY, '1'); } catch (e) {} });
  })();

  /* ---------- start ---------- */
  useLang(lang);
  sb.auth.onAuthStateChange((event, session) => {
    // Supabase recommends not awaiting other calls inside this callback.
    setTimeout(() => {
      const user = session ? session.user : null;
      if (!user) {
        S.user = null; S.me = null; S.group = null; S.members = [];
        show('auth');
        return;
      }
      const same = S.user && S.user.id === user.id;
      S.user = user;
      if (same && (S.view === 'main' || S.view === 'onboard')) { if (event !== 'TOKEN_REFRESHED') refresh(); return; }
      enter();
    }, 0);
  });
})();
