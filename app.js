(function () {
  const $ = id => document.getElementById(id);
  const CFG = window.FC_CONFIG || {};
  const BUCKET = CFG.BUCKET || 'flashcards';

  const ICON_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>';
  const ICON_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
  const ICON_DEL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';

  /* ======================= STATE ======================= */
  let sb = null, session = null;
  let cards = [];          // [{id, word, topic, image_path, sort_order, url}]
  let deck = [];           // card ids in play order
  let idx = 0, phase = 0, playing = true, elapsed = 0, lastT = 0;
  let shuffle = true, topic = '', secs = 10, wordSecs = 2;
  let quiz = false, answered = false, quizFor = null, quizOpts = [], wrong = new Set();
  let sTopic = '';
  const zoom = { s: 1, x: 0, y: 0 };

  try {
    const s = parseInt(localStorage.getItem('fc-secs'), 10); if ([3, 5, 10, 15, 20].includes(s)) secs = s;
    const w = parseInt(localStorage.getItem('fc-word-secs'), 10); if ([1, 2, 3, 5, 10].includes(w)) wordSecs = w;
  } catch (e) {}
  $('secsSel').value = String(secs);
  $('wordSel').value = String(wordSecs);
  try { quiz = localStorage.getItem('fc-mode') === 'quiz'; } catch (e) {}
  $('modeSel').value = quiz ? 'quiz' : 'view';
  document.body.classList.toggle('quiz', quiz);
  const phaseSecs = () => (phase === 0 ? secs : wordSecs);

  /* ======================= ROUTING ======================= */
  function route() {
    const h = location.hash;
    const m = h === '#quan-ly' ? 'manage' : h === '#danh-van' ? 'spell' : 'play';
    $('viewPlay').hidden = m !== 'play';
    $('viewSpell').hidden = m !== 'spell';
    $('viewManage').hidden = m !== 'manage';
    $('tabPlay').setAttribute('aria-current', m === 'play' ? 'page' : 'false');
    $('tabSpell').setAttribute('aria-current', m === 'spell' ? 'page' : 'false');
    $('tabManage').setAttribute('aria-current', m === 'manage' ? 'page' : 'false');
    if (m !== 'play') setPlaying(false);
  }
  window.addEventListener('hashchange', route);
  route();

  /* ======================= SUPABASE ======================= */
  const configured = CFG.SUPABASE_URL && !CFG.SUPABASE_URL.includes('YOUR-PROJECT') && CFG.SUPABASE_KEY && !CFG.SUPABASE_KEY.startsWith('YOUR-');
  if (!configured || !window.supabase) {
    showEmpty('Chưa cấu hình Supabase', 'Mở file config.js và điền SUPABASE_URL, SUPABASE_KEY (xem README).');
    $('loginPanel').hidden = true;
    return;
  }
  sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY);
  const imgUrl = path => sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;

  let loading = null;
  async function loadCards() {
    if (loading) return loading;           // gộp các lần gọi dồn dập
    loading = (async () => {
      // Tải theo từng đợt 1000 thẻ để không bị giới hạn số lượng
      let data = [], error = null;
      for (let from = 0; ; from += 1000) {
        const r = await sb.from('cards').select('*')
          .order('sort_order', { ascending: true })
          .range(from, from + 999);
        if (r.error) { error = r.error; break; }
        data = data.concat(r.data);
        if (r.data.length < 1000) break;
      }
      if (error) { showEmpty('Không tải được bộ thẻ', error.message); return; }
      const keep = deck[idx];
      cards = data.map(c => ({ ...c, url: c.image_path ? imgUrl(c.image_path) : '' }));
      fillTopics();
      rebuildDeck(keep);
      renderList();
      spellSync();
    })();
    try { await loading; } finally { loading = null; }
  }

  // Realtime: thẻ thêm/sửa/xoá ở bất kỳ máy nào -> tải lại ngay
  let reloadTimer = null;
  sb.channel('cards-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'cards' }, () => {
      clearTimeout(reloadTimer); reloadTimer = setTimeout(loadCards, 300);
    })
    .subscribe(status => $('liveDot').classList.toggle('on', status === 'SUBSCRIBED'));

  loadCards();

  /* ======================= PLAYER ======================= */
  function showEmpty(title, msg) {
    $('playerBox').hidden = true; $('emptyPlay').hidden = false;
    $('emptyTitle').textContent = title; $('emptyMsg').textContent = msg || '';
  }
  function fillTopics() {
    const ts = [...new Set(cards.map(c => (c.topic || '').trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'vi', { numeric: true }));
    for (const sel of [$('topicSel'), $('manageTopic'), $('spellTopic')]) {
      const cur = sel.value;
      sel.length = 1;
      ts.forEach(t => { const o = document.createElement('option'); o.value = t; o.textContent = t; sel.appendChild(o); });
      sel.value = ts.includes(cur) ? cur : '';
    }
    $('topicList').innerHTML = '';
    ts.forEach(t => { const o = document.createElement('option'); o.value = t; $('topicList').appendChild(o); });
    topic = $('topicSel').value;
    sTopic = $('spellTopic').value;
  }
  function rebuildDeck(keepId) {
    const ids = cards.filter(c => c.image_path && (!topic || (c.topic || '').trim() === topic)).map(c => c.id);   // Học/Chọn đáp án: chỉ thẻ có ảnh
    if (shuffle) {
      // giữ thứ tự trộn cũ, thẻ mới chèn vào cuối
      const old = deck.filter(id => ids.includes(id));
      const fresh = ids.filter(id => !old.includes(id));
      for (let i = fresh.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [fresh[i], fresh[j]] = [fresh[j], fresh[i]]; }
      deck = old.concat(fresh);
    } else deck = ids;
    const k = keepId ? deck.indexOf(keepId) : -1;
    if (k >= 0) idx = k;
    else { idx = Math.min(idx, Math.max(0, deck.length - 1)); phase = 0; elapsed = 0; answered = false; resetZoom(); }
    renderCard();
  }
  function reshuffle() {
    deck = [];
    rebuildDeck(null);
    idx = 0; phase = 0; elapsed = 0; renderCard();
  }
  const cur = () => cards.find(c => c.id === deck[idx]);

  function renderCard() {
    if (!deck.length) {
      showEmpty('Chưa có thẻ có ảnh', 'Vào tab “Tạo thẻ” để thêm ảnh và từ mới.');
      $('counter').textContent = '0 / 0';
      return;
    }
    $('playerBox').hidden = false; $('emptyPlay').hidden = true;
    const c = cur();
    const img = $('cardImg');
    if (img.getAttribute('src') !== c.url) img.setAttribute('src', c.url);
    img.alt = phase === 1 ? c.word : 'Hình minh hoạ, đoán từ tiếng Anh';
    $('cardWord').textContent = c.word;
    $('stage').classList.toggle('reveal', phase === 1);
    const key = c.id + ':' + idx + ':' + phase;          // đọc từ 1 lần mỗi khi chữ hiện ra
    if (phase === 1 && key !== lastSpoken) { lastSpoken = key; setTimeout(() => speak(c.word), quiz ? 350 : 0); }
    if (phase === 0) lastSpoken = '';
    $('counter').textContent = (idx + 1) + ' / ' + deck.length;
    renderChoices(c);
    updatePhaseText();
    const n = cards.find(x => x.id === deck[(idx + 1) % deck.length]);
    if (n) { const p = new Image(); p.src = n.url; }
    drawProgress();
  }
  function updatePhaseText() {
    $('phaseTxt').textContent = zoom.s > 1 ? 'Đang phóng to, đã tạm dừng'
      : (quiz && !answered) ? 'Chọn từ đúng với tranh'
      : (quiz && answered) ? (playing ? 'Chính xác!' : 'Chính xác! Bấm › để sang thẻ tiếp')
      : !playing ? 'Đã tạm dừng, bấm ▶ để tiếp tục'
      : (phase === 0 ? 'Nhìn tranh và đoán từ…' : 'Từ mới');
  }
  const drawProgress = () => { $('prog').style.width = Math.min(100, elapsed / (phaseSecs() * 10)) + '%'; };

  function go(delta) {
    if (!deck.length) return;
    if (quiz && delta > 0 && !answered) { nudge(); return; }   // chưa chọn đúng thì không cho next
    idx = (idx + delta + deck.length) % deck.length;
    phase = 0; elapsed = 0; answered = false; quizFor = null; resetZoom(); renderCard();
  }
  function advance() {
    if (quiz && phase === 0) return;                            // chế độ chọn: phải chọn đáp án
    if (phase === 0) { phase = 1; elapsed = 0; renderCard(); } else go(1);
  }

  /* ---------- Chế độ CHỌN ĐÁP ÁN ---------- */
  const ICON_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
  const ICON_BAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  const norm = w => (w || '').trim().toLowerCase();
  const shuffled = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  function buildOptions(c) {
    const seen = new Set([norm(c.word)]), pool = [];
    const add = list => { for (const x of shuffled(list)) { const k = norm(x.word); if (k && !seen.has(k)) { seen.add(k); pool.push(x.word.trim()); } } };
    add(cards.filter(x => deck.includes(x.id)));   // ưu tiên từ cùng chủ đề đang học
    if (pool.length < 3) add(cards);
    return shuffled([c.word.trim(), ...pool.slice(0, 3)]);
  }
  function renderChoices(c) {
    const box = $('choices');
    box.hidden = !quiz;
    $('nextBtn').disabled = quiz && !answered;
    if (!quiz) return;
    if (quizFor !== c.id) { quizFor = c.id; quizOpts = buildOptions(c); wrong = new Set(); }
    box.innerHTML = '';
    quizOpts.forEach((w, i) => {
      const b = document.createElement('button');
      b.className = 'choice';
      const ok = answered && norm(w) === norm(c.word), bad = wrong.has(norm(w));
      if (ok) b.classList.add('ok');
      if (bad) b.classList.add('bad');
      b.disabled = answered || bad;
      b.innerHTML = `<span class="key">${i + 1}</span><span class="txt"></span><span class="mark">${ok ? ICON_OK : bad ? ICON_BAD : ''}</span>`;
      b.querySelector('.txt').textContent = w;
      b.onclick = () => pick(w, b);
      box.appendChild(b);
    });
  }
  function pick(w, btn) {
    const c = cur();
    if (!c || answered) return;
    if (norm(w) === norm(c.word)) {
      beep(true);
      answered = true; phase = 1; elapsed = 0;     // hiện từ trên tranh, rồi tự sang thẻ nếu đang phát
      renderCard();
    } else {
      beep(false);
      setTimeout(() => speak(w), 300);                    // đọc cả từ chọn sai
      wrong.add(norm(w));
      renderCard();
      const b = [...$('choices').children].find(x => x.querySelector('.txt').textContent === w);
      if (b) { b.classList.add('shake'); setTimeout(() => b.classList.remove('shake'), 450); }
    }
  }
  function nudge() {
    const box = $('choices');
    box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake');
    setTimeout(() => box.classList.remove('shake'), 450);
  }
  $('modeSel').onchange = () => {
    quiz = $('modeSel').value === 'quiz';
    try { localStorage.setItem('fc-mode', quiz ? 'quiz' : 'view'); } catch (e) {}
    document.body.classList.toggle('quiz', quiz);
    phase = 0; elapsed = 0; answered = false; quizFor = null;
    renderCard();
  };
  /* ---------- ÂM THANH: đọc từ (giọng máy) + tiếng đúng/sai ---------- */
  let soundOn = true, lastSpoken = '', voice = null, actx = null;
  try { soundOn = localStorage.getItem('fc-sound') !== 'off'; } catch (e) {}
  const tts = 'speechSynthesis' in window;
  function pickVoice() {
    if (!tts) return;
    const vs = speechSynthesis.getVoices().filter(v => /^en([-_]|$)/i.test(v.lang));
    voice = vs.find(v => /en[-_]US/i.test(v.lang) && /google|samantha|aria|jenny|natural/i.test(v.name))
         || vs.find(v => /en[-_]US/i.test(v.lang)) || vs.find(v => /en[-_]GB/i.test(v.lang)) || vs[0] || null;
  }
  if (tts) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
  // iPad/iPhone và một số tablet: phải "mở khoá" âm thanh bằng lần chạm đầu tiên
  const unlockAudio = () => {
    if (tts) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); }
    try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch (e) {}
    window.removeEventListener('pointerdown', unlockAudio, true);
    window.removeEventListener('keydown', unlockAudio, true);
  };
  window.addEventListener('pointerdown', unlockAudio, true);
  window.addEventListener('keydown', unlockAudio, true);
  function speak(text) {
    if (!soundOn || !tts || !text) return;
    const say = () => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US'; if (voice) u.voice = voice;
      u.rate = 0.85;
      speechSynthesis.speak(u);
    };
    if (speechSynthesis.paused) speechSynthesis.resume();     // Chrome Android đôi khi bị kẹt "paused"
    // Chrome Android hay bỏ qua câu nói nếu gọi speak() ngay sau cancel()
    if (speechSynthesis.speaking || speechSynthesis.pending) { speechSynthesis.cancel(); setTimeout(say, 150); }
    else say();
  }
  function beep(ok) {
    if (!soundOn) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const notes = ok ? [[660, 0], [990, .12]] : [[200, 0], [150, .15]];
      notes.forEach(([f, t]) => {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = ok ? 'sine' : 'square'; o.frequency.value = f;
        const s0 = actx.currentTime + t;
        g.gain.setValueAtTime(0.0001, s0); g.gain.exponentialRampToValueAtTime(ok ? .25 : .12, s0 + .02);
        g.gain.exponentialRampToValueAtTime(0.0001, s0 + .22);
        o.connect(g).connect(actx.destination); o.start(s0); o.stop(s0 + .25);
      });
    } catch (e) {}
  }
  function updateSoundBtn() {
    $('soundBtn').setAttribute('aria-pressed', String(soundOn));
    $('icoSound').toggleAttribute('hidden', !soundOn);
    $('icoMute').toggleAttribute('hidden', soundOn);
  }
  updateSoundBtn();
  $('soundBtn').onclick = () => {
    soundOn = !soundOn;
    try { localStorage.setItem('fc-sound', soundOn ? 'on' : 'off'); } catch (e) {}
    if (!soundOn && tts) speechSynthesis.cancel();
    updateSoundBtn();
    if (soundOn && phase === 1 && cur()) speak(cur().word);
  };

  function setPlaying(v) {
    playing = v;
    // SVG không có thuộc tính .hidden, phải dùng attribute
    $('icoPause').toggleAttribute('hidden', !v);
    $('icoPlay').toggleAttribute('hidden', v);
    $('playBtn').setAttribute('aria-label', v ? 'Tạm dừng' : 'Phát');
    $('stage').classList.toggle('paused', !v);
    updatePhaseText();
  }
  function loop(t) {
    const dt = t - lastT; lastT = t;
    if (playing && deck.length && !$('viewPlay').hidden && !document.hidden && !(quiz && phase === 0)) {
      elapsed += dt;
      if (elapsed >= phaseSecs() * 1000) advance(); else drawProgress();
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(t => { lastT = t; requestAnimationFrame(loop); });

  $('prevBtn').onclick = () => go(-1);
  $('nextBtn').onclick = () => go(1);
  $('playBtn').onclick = () => { if (!playing && zoom.s > 1) resetZoom(); setPlaying(!playing); renderCard(); };
  $('shuffleBtn').onclick = () => { shuffle = !shuffle; $('shuffleBtn').setAttribute('aria-pressed', String(shuffle)); reshuffle(); };
  $('topicSel').onchange = () => { topic = $('topicSel').value; idx = 0; deck = []; rebuildDeck(null); };
  $('secsSel').onchange = () => {
    secs = parseInt($('secsSel').value, 10);
    try { localStorage.setItem('fc-secs', String(secs)); } catch (e) {}
    drawProgress();
  };
  $('wordSel').onchange = () => {
    wordSecs = parseInt($('wordSel').value, 10);
    try { localStorage.setItem('fc-word-secs', String(wordSecs)); } catch (e) {}
    drawProgress();
  };

  const stage = $('stage');
  const fsOk = !!(document.fullscreenEnabled && stage.requestFullscreen);
  $('fsBtn').hidden = !fsOk;
  function toggleFs() {
    if (!fsOk) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else stage.requestFullscreen().catch(() => {});
  }
  $('fsBtn').onclick = toggleFs;

  /* ---------- Zoom: nút +/−, lăn chuột, chụm 2 ngón, kéo để di chuyển ---------- */
  const MAXZ = 5;
  function applyZoom() {
    const w = stage.clientWidth, h = stage.clientHeight;
    const mx = (zoom.s - 1) * w / 2, my = (zoom.s - 1) * h / 2;
    zoom.x = Math.max(-mx, Math.min(mx, zoom.x));
    zoom.y = Math.max(-my, Math.min(my, zoom.y));
    $('pan').style.transform = `translate(${zoom.x}px,${zoom.y}px) scale(${zoom.s})`;
    stage.classList.toggle('zoomed', zoom.s > 1);
  }
  function setZoom(s) {
    const was = zoom.s;
    zoom.s = Math.max(1, Math.min(MAXZ, s));
    if (zoom.s === 1) { zoom.x = 0; zoom.y = 0; }
    else { zoom.x *= zoom.s / was; zoom.y *= zoom.s / was; }
    if (zoom.s > 1 && playing) setPlaying(false);   // phóng to thì tạm dừng
    applyZoom(); renderCard();
  }
  function resetZoom() { zoom.s = 1; zoom.x = 0; zoom.y = 0; applyZoom(); }
  $('zoomIn').onclick = e => { e.stopPropagation(); setZoom(zoom.s * 1.4); };
  $('zoomOut').onclick = e => { e.stopPropagation(); setZoom(zoom.s / 1.4); };
  $('zoomReset').onclick = e => { e.stopPropagation(); setZoom(1); };
  stage.addEventListener('wheel', e => { e.preventDefault(); setZoom(zoom.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15)); }, { passive: false });

  const pts = new Map();
  let pinchStart = 0, pinchScale = 1, moved = false;
  const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  stage.addEventListener('pointerdown', e => {
    if (e.target.closest('.zoombar')) return;
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) moved = false;
    if (pts.size === 2) { pinchStart = dist(); pinchScale = zoom.s; }
  });
  stage.addEventListener('pointermove', e => {
    const p = pts.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
    if (pts.size === 2 && pinchStart) setZoom(pinchScale * dist() / pinchStart);
    else if (pts.size === 1 && zoom.s > 1) { stage.classList.add('dragging'); zoom.x += dx; zoom.y += dy; applyZoom(); }
  });
  const endPtr = e => { pts.delete(e.pointerId); if (pts.size < 2) pinchStart = 0; stage.classList.remove('dragging'); };
  stage.addEventListener('pointerup', endPtr);
  stage.addEventListener('pointercancel', endPtr);
  stage.addEventListener('click', e => {
    if (e.target.closest('.zoombar') || moved || zoom.s > 1) return;
    if (phase === 1) {                                   // bấm vào chữ: đọc lại
      const r = $('cardWord').getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) { speak(cur().word); return; }
    }
    advance();                                     // bấm vào tranh: hiện chữ / sang thẻ
  });
  window.addEventListener('resize', applyZoom);

  document.addEventListener('keydown', e => {
    if ($('viewPlay').hidden || e.target.matches('input,select,textarea')) return;
    if (e.key === 'ArrowRight') { go(1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { go(-1); e.preventDefault(); }
    else if (e.key === ' ') { $('playBtn').click(); e.preventDefault(); }
    else if (e.key === 'f' || e.key === 'F') toggleFs();
    else if (e.key === 's' || e.key === 'S') { if (cur()) { const was = soundOn; soundOn = true; speak(cur().word); soundOn = was; } }
    else if (e.key === '+' || e.key === '=') setZoom(zoom.s * 1.4);
    else if (e.key === '-') setZoom(zoom.s / 1.4);
    else if (e.key === '0') setZoom(1);
    else if (quiz && /^[1-4]$/.test(e.key)) { const b = $('choices').children[+e.key - 1]; if (b && !b.disabled) b.click(); }
  });

  /* ======================= MODULE 2: AUTH ======================= */
  function setAuth(s) {
    session = s;
    $('loginPanel').hidden = !!s;
    $('editor').hidden = !s;
    renderList();
  }
  sb.auth.getSession().then(({ data }) => setAuth(data.session));
  sb.auth.onAuthStateChange((_ev, s) => setAuth(s));

  $('loginForm').onsubmit = async e => {
    e.preventDefault();
    setStatus('loginStatus', 'Đang đăng nhập…');
    const { error } = await sb.auth.signInWithPassword({ email: $('email').value.trim(), password: $('password').value });
    setStatus('loginStatus', error ? 'Sai email hoặc mật khẩu.' : '', !!error);
  };
  $('logoutBtn').onclick = () => sb.auth.signOut();

  /* ======================= MODULE 2: THÊM THẺ ======================= */
  let pending = []; // {file, url, word}
  const wordFromName = n => {
    const w = n.replace(/\.[^.]+$/, '').replace(/^\d+[\s._-]*/, '').replace(/[_-]+/g, ' ').trim();
    return (/^[0-9a-f]{12,}$/i.test(w) || /\d{4,}/.test(w) || w.length > 30) ? '' : w;
  };

  function addFiles(list) {
    for (const f of list) if (f.type.startsWith('image/')) pending.push({ file: f, url: URL.createObjectURL(f), word: wordFromName(f.name), meaning: '' });
    renderPending();
  }
  function renderPending() {
    const box = $('pending'); box.innerHTML = '';
    pending.forEach((p, i) => {
      const el = document.createElement('div'); el.className = 'item';
      el.innerHTML = `<img alt=""><div class="fields"><input class="field pw" aria-label="Từ mới" placeholder="✏️ Nhập từ mới (vd: gloves)"><input class="field pm" aria-label="Nghĩa" placeholder="Nghĩa (không bắt buộc)"></div><div class="acts"><button class="ibtn del" aria-label="Bỏ ảnh này">${ICON_DEL}</button></div>`;
      el.querySelector('img').src = p.url;
      const inp = el.querySelector('.pw'); inp.value = p.word; inp.oninput = () => (p.word = inp.value);
      const mi = el.querySelector('.pm'); mi.value = p.meaning; mi.oninput = () => (p.meaning = mi.value);
      el.querySelector('button').onclick = () => { URL.revokeObjectURL(p.url); pending.splice(i, 1); renderPending(); };
      box.appendChild(el);
    });
    $('pendingActions').hidden = !pending.length;
    $('savePending').textContent = pending.length > 1 ? `Lưu ${pending.length} thẻ` : 'Lưu thẻ';
  }
  const drop = $('drop');
  drop.onclick = () => $('fileIn').click();
  drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileIn').click(); } };
  $('fileIn').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); };
  // Dán ảnh trực tiếp (Ctrl+V) khi đang ở tab Tạo thẻ
  document.addEventListener('paste', e => {
    if ($('viewManage').hidden || $('editor').hidden) return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  $('clearPending').onclick = () => { pending.forEach(p => URL.revokeObjectURL(p.url)); pending = []; renderPending(); };

  // Thu nhỏ ảnh lớn để tiết kiệm dung lượng (giữ nền trong suốt bằng WebP)
  async function shrink(file) {
    if (file.type === 'image/svg+xml' || file.type === 'image/gif') return file;
    try {
      const bmp = await createImageBitmap(file);
      const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      if (s === 1 && file.size < 1.5e6) return file;
      const cv = document.createElement('canvas');
      cv.width = Math.round(bmp.width * s); cv.height = Math.round(bmp.height * s);
      cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
      return (await new Promise(r => cv.toBlob(r, 'image/webp', 0.88))) || file;
    } catch (e) { return file; }
  }
  const extOf = t => ({ 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/svg+xml': 'svg' }[t] || 'img');

  $('savePending').onclick = async () => {
    if (pending.some(p => !p.word.trim())) { setStatus('addStatus', 'Điền từ mới cho tất cả ảnh trước khi lưu.', true); return; }
    const t = $('newTopic').value.trim();
    $('savePending').disabled = true;
    let order = cards.length ? Math.max(...cards.map(c => c.sort_order)) : 0;
    let done = 0;
    const items = [...pending];
    try {
      for (const p of items) {
        setStatus('addStatus', `Đang lưu ${done + 1}/${items.length}…`);
        const blob = await shrink(p.file);
        const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extOf(blob.type)}`;
        const up = await sb.storage.from(BUCKET).upload(path, blob, { contentType: blob.type, cacheControl: '31536000' });
        if (up.error) throw up.error;
        order += 1;
        const ins = await sb.from('cards').insert({ word: p.word.trim(), meaning: (p.meaning || '').trim(), topic: t, image_path: path, sort_order: order });
        if (ins.error) { await sb.storage.from(BUCKET).remove([path]); throw ins.error; }
        URL.revokeObjectURL(p.url);
        pending.splice(pending.indexOf(p), 1);
        done++;
      }
      setStatus('addStatus', `Đã lưu ${done} thẻ.`);
    } catch (e) {
      setStatus('addStatus', `Đã lưu ${done} thẻ, thẻ tiếp theo bị lỗi: ${e.message || e}`, true);
    }
    $('savePending').disabled = false;
    renderPending();
    loadCards();
  };

  /* ======================= MODULE 2: DANH SÁCH ======================= */
  function renderList() {
    const box = $('list'); box.innerHTML = '';
    if (!session) return;
    const mt = $('manageTopic').value;
    const shown = cards.filter(c => !mt || (c.topic || '').trim() === mt);
    $('totalCount').textContent = cards.length ? `(${cards.length})` : '';
    if (!shown.length) { box.innerHTML = '<p class="status">Chưa có thẻ nào ở đây.</p>'; return; }
    shown.forEach((c, i) => {
      const el = document.createElement('div'); el.className = 'item';
      el.innerHTML = `<button class="thumb" title="Bấm để đổi ảnh" aria-label="Đổi ảnh"><img alt=""><span>Đổi ảnh</span></button><div class="fields"><input class="field w" aria-label="Từ mới"><input class="field m" aria-label="Nghĩa" placeholder="Nghĩa"><input class="field t" list="topicList" aria-label="Chủ đề" placeholder="Chủ đề"></div>
        <div class="acts"><button class="ibtn up" aria-label="Lên trên">${ICON_UP}</button><button class="ibtn dn" aria-label="Xuống dưới">${ICON_DOWN}</button><button class="ibtn del" aria-label="Xoá thẻ">${ICON_DEL}</button></div>`;
      const th = el.querySelector('.thumb');
      if (c.url) el.querySelector('img').src = c.url;
      else { th.classList.add('noimg'); el.querySelector('img').remove(); th.querySelector('span').textContent = '+ Ảnh'; th.title = 'Thêm ảnh'; }
      th.onclick = () => pickImageFor(c);
      th.ondragover = e => { e.preventDefault(); th.classList.add('over'); };
      th.ondragleave = () => th.classList.remove('over');
      th.ondrop = e => { e.preventDefault(); th.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) replaceImage(c, f); };
      const w = el.querySelector('.w'), t = el.querySelector('.t'), mm = el.querySelector('.m');
      w.value = c.word || ''; t.value = c.topic || ''; mm.value = c.meaning || '';
      const save = (inp, key) => async () => {
        const v = inp.value.trim();
        if (v === (c[key] || '')) return;
        if (key === 'word' && !v) { inp.value = c.word; return; }
        const { error } = await sb.from('cards').update({ [key]: v }).eq('id', c.id);
        setStatus('listStatus', error ? 'Không lưu được: ' + error.message : 'Đã lưu.', !!error);
        if (!error) loadCards();
      };
      w.onchange = save(w, 'word'); t.onchange = save(t, 'topic'); mm.onchange = save(mm, 'meaning');
      [w, t, mm].forEach(x => (x.onkeydown = e => { if (e.key === 'Enter') x.blur(); }));
      const up = el.querySelector('.up'), dn = el.querySelector('.dn');
      up.disabled = i === 0; dn.disabled = i === shown.length - 1;
      up.onclick = () => swap(c, shown[i - 1]);
      dn.onclick = () => swap(c, shown[i + 1]);
      el.querySelector('.del').onclick = async () => {
        if (!confirm(`Xoá thẻ “${c.word}”?`)) return;
        const { error } = await sb.from('cards').delete().eq('id', c.id);
        if (error) { setStatus('listStatus', 'Không xoá được: ' + error.message, true); return; }
        if (c.image_path) await sb.storage.from(BUCKET).remove([c.image_path]);
        setStatus('listStatus', 'Đã xoá.');
        loadCards();
      };
      box.appendChild(el);
    });
  }
  /* ---------- Đổi ảnh của thẻ có sẵn ---------- */
  const replaceIn = document.createElement('input');
  replaceIn.type = 'file'; replaceIn.accept = 'image/*'; replaceIn.hidden = true;
  document.body.appendChild(replaceIn);
  let replaceTarget = null;
  function pickImageFor(c) { replaceTarget = c; replaceIn.value = ''; replaceIn.click(); }
  replaceIn.onchange = () => { const f = replaceIn.files[0]; if (f && replaceTarget) replaceImage(replaceTarget, f); };
  async function replaceImage(c, file) {
    if (!file.type.startsWith('image/')) { setStatus('listStatus', 'File không phải ảnh.', true); return; }
    setStatus('listStatus', `Đang đổi ảnh cho “${c.word}”…`);
    try {
      const blob = await shrink(file);
      const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extOf(blob.type)}`;
      const up = await sb.storage.from(BUCKET).upload(path, blob, { contentType: blob.type, cacheControl: '31536000' });
      if (up.error) throw up.error;
      const { error } = await sb.from('cards').update({ image_path: path }).eq('id', c.id);
      if (error) { await sb.storage.from(BUCKET).remove([path]); throw error; }
      if (c.image_path) await sb.storage.from(BUCKET).remove([c.image_path]);
      setStatus('listStatus', `Đã đổi ảnh cho “${c.word}”.`);
      loadCards();
    } catch (e) { setStatus('listStatus', 'Không đổi được ảnh: ' + (e.message || e), true); }
  }

  let swapping = false;
  async function swap(a, b) {
    if (!b || swapping) return;
    swapping = true;
    const r1 = await sb.from('cards').update({ sort_order: b.sort_order }).eq('id', a.id);
    const r2 = r1.error ? r1 : await sb.from('cards').update({ sort_order: a.sort_order }).eq('id', b.id);
    if (r1.error || r2.error) setStatus('listStatus', 'Không đổi thứ tự được: ' + (r1.error || r2.error).message, true);
    swapping = false;
    loadCards();
  }
  $('manageTopic').onchange = renderList;


  /* ======================= MODULE: THÊM TỪ KHÔNG ẢNH ======================= */
  $('wordForm').onsubmit = async e => {
    e.preventDefault();
    const word = $('wfWord').value.trim();
    if (!word) return;
    const order = (cards.length ? Math.max(...cards.map(c => c.sort_order)) : 0) + 1;
    const { error } = await sb.from('cards').insert({ word, meaning: $('wfMeaning').value.trim(), topic: $('wfTopic').value.trim(), image_path: null, sort_order: order });
    if (error) { setStatus('wordStatus', 'Không thêm được: ' + error.message, true); return; }
    setStatus('wordStatus', `Đã thêm “${word}”.`);
    $('wfWord').value = ''; $('wfMeaning').value = ''; $('wfWord').focus();
    loadCards();
  };

  /* ======================= MODULE 3: ĐÁNH VẦN ======================= */
  let sMode = 'missing', sDeck = [], sIdx = 0, sFor = null, sDone = false, sTimer = null;
  let sHidden = new Set(), sVals = {};           // điền chữ thiếu
  let sTiles = [], sAns = {};                    // sắp xếp: tiles [{id,ch,used}], sAns[pos] = tileId
  try { if (localStorage.getItem('fc-spell-mode') === 'scramble') sMode = 'scramble'; } catch (e) {}
  $('spellMode').value = sMode;
  const isLetter = ch => /\p{L}/u.test(ch);
  const eqCh = (a, b) => (a || '').toLowerCase() === (b || '').toLowerCase();
  const sCur = () => cards.find(c => c.id === sDeck[sIdx]);
  const sChars = () => [...(sCur()?.word || '').trim()];

  function spellSync() {
    const ids = cards.filter(c => (c.word || '').trim() && (!sTopic || (c.topic || '').trim() === sTopic)).map(c => c.id);
    const keepId = sDeck[sIdx];
    const old = sDeck.filter(id => ids.includes(id));
    const fresh = shuffled(ids.filter(id => !old.includes(id)));
    sDeck = old.concat(fresh);
    const k = sDeck.indexOf(keepId);
    sIdx = k >= 0 ? k : Math.min(sIdx, Math.max(0, sDeck.length - 1));
    if (k < 0) sFor = null;
    renderSpell();
  }
  function spellNew() {
    const c = sCur(); if (!c) return;
    sFor = c.id; sDone = false; clearTimeout(sTimer);
    const chars = sChars();
    const letters = chars.map((ch, i) => isLetter(ch) ? i : -1).filter(i => i >= 0);
    if (sMode === 'missing') {
      const k = letters.length <= 2 ? 1 : Math.max(1, Math.round(letters.length * 0.4));
      sHidden = new Set(shuffled(letters).slice(0, k)); sVals = {};
    } else {
      let order = letters.map((pos, i) => ({ id: 't' + i, ch: chars[pos], used: false }));
      const orig = order.map(t => t.ch.toLowerCase()).join('');
      for (let n = 0; n < 10; n++) {             // trộn đến khi khác thứ tự gốc
        order = shuffled(order);
        if (order.map(t => t.ch.toLowerCase()).join('') !== orig || new Set(orig).size < 2) break;
      }
      sTiles = order; sAns = {};
    }
  }
  function renderSpell() {
    const has = sDeck.length > 0;
    $('spellBox').hidden = !has; $('spellEmpty').hidden = has;
    if (!has) {
      $('spellEmpty').querySelector('strong').textContent = 'Chưa có từ nào';
      $('spellEmpty').querySelector('span').textContent = 'Vào tab “Tạo thẻ” để thêm từ.';
      $('spellCounter').textContent = '0 / 0';
      return;
    }
    const c = sCur();
    if (sFor !== c.id) spellNew();
    $('spellCounter').textContent = (sIdx + 1) + ' / ' + sDeck.length;
    const img = $('spellImg');
    img.hidden = !c.url; if (c.url && img.getAttribute('src') !== c.url) img.setAttribute('src', c.url);
    $('spellMeaning').textContent = c.meaning || (c.url ? '' : 'Nghe và viết lại từ');
    $('spellNext').disabled = !sDone;
    $('spellHintBtn').disabled = sDone; $('spellReset').disabled = sDone;
    const chars = sChars();
    const ans = $('spellAnswer'); ans.innerHTML = '';
    ans.classList.toggle('done', sDone);
    const tilesBox = $('spellTiles'); tilesBox.innerHTML = ''; tilesBox.hidden = sMode !== 'scramble' || sDone;

    chars.forEach((ch, i) => {
      if (ch === ' ') { const g = document.createElement('span'); g.className = 'sgap'; ans.appendChild(g); return; }
      if (!isLetter(ch)) { const f = document.createElement('span'); f.className = 'slot fixed'; f.textContent = ch; ans.appendChild(f); return; }
      if (sDone) { const f = document.createElement('span'); f.className = 'slot ok'; f.textContent = ch; ans.appendChild(f); return; }
      if (sMode === 'missing') {
        if (!sHidden.has(i)) { const f = document.createElement('span'); f.className = 'slot fixed'; f.textContent = ch; ans.appendChild(f); return; }
        const inp = document.createElement('input');
        inp.className = 'slot input'; inp.maxLength = 2; inp.dataset.pos = i;
        inp.autocomplete = 'off'; inp.autocapitalize = 'off'; inp.spellcheck = false; inp.setAttribute('autocorrect', 'off');
        inp.setAttribute('aria-label', 'Chữ cái thứ ' + (i + 1));
        inp.value = sVals[i] || '';
        if (inp.value && sVals['bad' + i]) inp.classList.add('bad');
        if (sVals['hint' + i]) { inp.classList.add('hinted'); inp.readOnly = true; }
        inp.oninput = () => {
          const v = [...inp.value].filter(isLetter).pop() || '';
          inp.value = v; sVals[i] = v; delete sVals['bad' + i]; inp.classList.remove('bad');
          if (v) focusNextInput(i);
          if (allFilled()) checkSpell();
        };
        inp.onkeydown = e => {
          if (e.key === 'Backspace' && !inp.value) { e.preventDefault(); focusPrevInput(i); }
          else if (e.key === 'ArrowLeft') { e.preventDefault(); focusPrevInput(i, true); }
          else if (e.key === 'ArrowRight') { e.preventDefault(); focusNextInput(i, true); }
        };
        ans.appendChild(inp);
      } else {
        const b = document.createElement('button');
        b.className = 'slot drop-slot'; b.dataset.pos = i;
        const t = sTiles.find(x => x.id === sAns[i]);
        if (t) { b.textContent = t.ch; b.classList.add('filled'); if (t.bad) b.classList.add('bad'); if (t.hint) b.classList.add('hinted'); }
        b.setAttribute('aria-label', t ? 'Chữ ' + t.ch + ', bấm để bỏ' : 'Ô trống');
        b.onclick = () => { if (t && !t.hint) { freeSlot(i); renderSpell(); } };
        ans.appendChild(b);
      }
    });

    if (sMode === 'scramble' && !sDone) {
      sTiles.forEach(t => {
        const b = document.createElement('button');
        b.className = 'tile'; b.textContent = t.ch;
        if (t.used) b.classList.add('used');
        b.disabled = t.used;
        b.onclick = () => placeTile(t);
        tilesBox.appendChild(b);
      });
    }
    if (sMode === 'missing' && !sDone && !ans.contains(document.activeElement) && !$('viewSpell').hidden) {
      const first = [...ans.querySelectorAll('input.slot')].find(x => !x.value) || ans.querySelector('input.slot');
      if (first && matchMedia('(hover:hover)').matches) first.focus({ preventScroll: true });   // máy tính: tự focus; tablet: chạm để mở bàn phím
    }
  }
  const inputs = () => [...$('spellAnswer').querySelectorAll('input.slot')];
  function focusNextInput(pos, any) {
    const list = inputs(); const i = list.findIndex(x => +x.dataset.pos === pos);
    const nxt = list.slice(i + 1).find(x => any || !x.value) || (any ? null : list.find(x => !x.value));
    if (nxt) nxt.focus();
  }
  function focusPrevInput(pos) {
    const list = inputs(); const i = list.findIndex(x => +x.dataset.pos === pos);
    if (i > 0) { const p = list[i - 1]; p.focus(); p.select(); }
  }
  function slotPositions() { return sChars().map((ch, i) => isLetter(ch) ? i : -1).filter(i => i >= 0); }
  function allFilled() {
    if (sMode === 'missing') return [...sHidden].every(i => sVals[i]);
    return slotPositions().every(i => sAns[i]);
  }
  function placeTile(t) {
    if (sDone || t.used) return;
    const pos = slotPositions().find(i => !sAns[i]);
    if (pos === undefined) return;
    sAns[pos] = t.id; t.used = true;
    sTiles.forEach(x => (x.bad = false));
    renderSpell();
    if (allFilled()) checkSpell();
  }
  function freeSlot(pos) {
    const t = sTiles.find(x => x.id === sAns[pos]);
    if (t) { t.used = false; t.bad = false; t.hint = false; }
    delete sAns[pos];
  }
  function checkSpell() {
    const chars = sChars();
    let ok = true;
    if (sMode === 'missing') {
      sHidden.forEach(i => { if (!eqCh(sVals[i], chars[i])) { ok = false; sVals['bad' + i] = true; } });
    } else {
      slotPositions().forEach(i => { const t = sTiles.find(x => x.id === sAns[i]); if (!t || !eqCh(t.ch, chars[i])) { ok = false; if (t) t.bad = true; } });
    }
    if (ok) {
      sDone = true; beep(true);
      setTimeout(() => speak(sCur().word), 300);
      spellMsg('Chính xác!', 'ok');
      renderSpell();
      clearTimeout(sTimer);
      sTimer = setTimeout(() => { if (sDone && !$('viewSpell').hidden) spellGo(1); }, 2500);
    } else {
      beep(false);
      spellMsg(sMode === 'missing' ? 'Chưa đúng, sửa các ô màu đỏ nhé' : 'Chưa đúng, bấm vào chữ màu đỏ để đổi', 'bad');
      renderSpell();
      const a = $('spellAnswer'); a.classList.remove('shake'); void a.offsetWidth; a.classList.add('shake');
      if (sMode === 'missing') { const b = inputs().find(x => x.classList.contains('bad')); if (b) { b.focus(); b.select(); } }
    }
  }
  function spellMsg(t, kind) { const m = $('spellMsg'); m.textContent = t; m.className = 'spell-msg ' + (kind || ''); }
  function spellHint() {
    if (sDone) return;
    const chars = sChars();
    if (sMode === 'missing') {
      const pos = [...sHidden].sort((a, b) => a - b).find(i => !eqCh(sVals[i], chars[i]));
      if (pos === undefined) return;
      sVals[pos] = chars[pos]; sVals['hint' + pos] = true; delete sVals['bad' + pos];
    } else {
      const pos = slotPositions().find(i => { const t = sTiles.find(x => x.id === sAns[i]); return !t || !eqCh(t.ch, chars[i]); });
      if (pos === undefined) return;
      if (sAns[pos]) freeSlot(pos);
      let t = sTiles.find(x => !x.used && eqCh(x.ch, chars[pos]));
      if (!t) {                                   // chữ cần đang nằm sai chỗ khác -> lấy về
        const q = slotPositions().find(i => { const x = sTiles.find(y => y.id === sAns[i]); return x && eqCh(x.ch, chars[pos]) && !eqCh(chars[i], chars[pos]); });
        if (q !== undefined) { const id = sAns[q]; freeSlot(q); t = sTiles.find(x => x.id === id); }
      }
      if (!t) return;
      sAns[pos] = t.id; t.used = true; t.hint = true;
    }
    spellMsg('');
    renderSpell();
    if (allFilled()) checkSpell();
  }
  function spellGo(d) {
    if (!sDeck.length) return;
    if (d > 0 && !sDone) {                        // chưa làm đúng thì không cho sang từ tiếp
      const a = $('spellAnswer'); a.classList.remove('shake'); void a.offsetWidth; a.classList.add('shake');
      spellMsg('Hoàn thành từ này trước nhé (có thể bấm Gợi ý)', 'bad');
      return;
    }
    clearTimeout(sTimer);
    sIdx = (sIdx + d + sDeck.length) % sDeck.length;
    sFor = null; spellMsg(''); renderSpell();
  }
  $('spellPrev').onclick = () => spellGo(-1);
  $('spellNext').onclick = () => spellGo(1);
  $('spellHintBtn').onclick = spellHint;
  $('spellReset').onclick = () => { sFor = null; spellMsg(''); renderSpell(); };
  $('spellSay').onclick = () => { const c = sCur(); if (c) { const was = soundOn; soundOn = true; speak(c.word); soundOn = was; } };
  $('spellMode').onchange = () => {
    sMode = $('spellMode').value;
    try { localStorage.setItem('fc-spell-mode', sMode); } catch (e) {}
    sFor = null; spellMsg(''); renderSpell();
  };
  $('spellTopic').onchange = () => { sTopic = $('spellTopic').value; sDeck = []; sIdx = 0; sFor = null; spellMsg(''); spellSync(); };
  document.addEventListener('keydown', e => {
    if ($('viewSpell').hidden || sMode !== 'scramble' || sDone) return;
    if (e.target.matches('input,select,textarea')) return;
    if (e.key === 'Backspace') {                  // xoá chữ cuối cùng đã đặt
      const filled = slotPositions().filter(i => sAns[i] && !sTiles.find(x => x.id === sAns[i]).hint);
      if (filled.length) { freeSlot(filled.pop()); renderSpell(); }
      e.preventDefault();
    } else if (e.key.length === 1 && isLetter(e.key)) {
      const t = sTiles.find(x => !x.used && eqCh(x.ch, e.key));
      if (t) placeTile(t);
    } else if (e.key === 'Enter' && sDone) spellGo(1);
  });
  window.addEventListener('hashchange', () => { if (location.hash === '#danh-van') renderSpell(); });

  function setStatus(id, msg, err) { const s = $(id); s.textContent = msg; s.classList.toggle('err', !!err); }
})();
