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
  const zoom = { s: 1, x: 0, y: 0 };

  try {
    const s = parseInt(localStorage.getItem('fc-secs'), 10); if ([3, 5, 10, 15, 20].includes(s)) secs = s;
    const w = parseInt(localStorage.getItem('fc-word-secs'), 10); if ([1, 2, 3, 5, 10].includes(w)) wordSecs = w;
  } catch (e) {}
  $('secsSel').value = String(secs);
  $('wordSel').value = String(wordSecs);
  const phaseSecs = () => (phase === 0 ? secs : wordSecs);

  /* ======================= ROUTING ======================= */
  function route() {
    const m = location.hash === '#quan-ly' ? 'manage' : 'play';
    $('viewPlay').hidden = m !== 'play';
    $('viewManage').hidden = m !== 'manage';
    $('tabPlay').setAttribute('aria-current', m === 'play' ? 'page' : 'false');
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
      const { data, error } = await sb.from('cards').select('*').order('sort_order', { ascending: true });
      if (error) { showEmpty('Không tải được bộ thẻ', error.message); return; }
      const keep = deck[idx];
      cards = data.map(c => ({ ...c, url: imgUrl(c.image_path) }));
      fillTopics();
      rebuildDeck(keep);
      renderList();
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
    for (const sel of [$('topicSel'), $('manageTopic')]) {
      const cur = sel.value;
      sel.length = 1;
      ts.forEach(t => { const o = document.createElement('option'); o.value = t; o.textContent = t; sel.appendChild(o); });
      sel.value = ts.includes(cur) ? cur : '';
    }
    $('topicList').innerHTML = '';
    ts.forEach(t => { const o = document.createElement('option'); o.value = t; $('topicList').appendChild(o); });
    topic = $('topicSel').value;
  }
  function rebuildDeck(keepId) {
    const ids = cards.filter(c => !topic || (c.topic || '').trim() === topic).map(c => c.id);
    if (shuffle) {
      // giữ thứ tự trộn cũ, thẻ mới chèn vào cuối
      const old = deck.filter(id => ids.includes(id));
      const fresh = ids.filter(id => !old.includes(id));
      for (let i = fresh.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [fresh[i], fresh[j]] = [fresh[j], fresh[i]]; }
      deck = old.concat(fresh);
    } else deck = ids;
    const k = keepId ? deck.indexOf(keepId) : -1;
    if (k >= 0) idx = k;
    else { idx = Math.min(idx, Math.max(0, deck.length - 1)); phase = 0; elapsed = 0; resetZoom(); }
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
      showEmpty('Chưa có thẻ nào', 'Vào tab “Tạo thẻ” để thêm ảnh và từ mới.');
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
    $('counter').textContent = (idx + 1) + ' / ' + deck.length;
    updatePhaseText();
    const n = cards.find(x => x.id === deck[(idx + 1) % deck.length]);
    if (n) { const p = new Image(); p.src = n.url; }
    drawProgress();
  }
  function updatePhaseText() {
    $('phaseTxt').textContent = zoom.s > 1 ? 'Đang phóng to, đã tạm dừng'
      : !playing ? 'Đã tạm dừng, bấm ▶ để tiếp tục'
      : (phase === 0 ? 'Nhìn tranh và đoán từ…' : 'Từ mới');
  }
  const drawProgress = () => { $('prog').style.width = Math.min(100, elapsed / (phaseSecs() * 10)) + '%'; };

  function go(delta) {
    if (!deck.length) return;
    idx = (idx + delta + deck.length) % deck.length;
    phase = 0; elapsed = 0; resetZoom(); renderCard();
  }
  function advance() {
    if (phase === 0) { phase = 1; elapsed = 0; renderCard(); } else go(1);
  }
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
    if (playing && deck.length && !$('viewPlay').hidden && !document.hidden) {
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
    advance();                                     // bấm vào tranh: hiện chữ / sang thẻ
  });
  window.addEventListener('resize', applyZoom);

  document.addEventListener('keydown', e => {
    if ($('viewPlay').hidden || e.target.matches('input,select,textarea')) return;
    if (e.key === 'ArrowRight') { go(1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { go(-1); e.preventDefault(); }
    else if (e.key === ' ') { $('playBtn').click(); e.preventDefault(); }
    else if (e.key === 'f' || e.key === 'F') toggleFs();
    else if (e.key === '+' || e.key === '=') setZoom(zoom.s * 1.4);
    else if (e.key === '-') setZoom(zoom.s / 1.4);
    else if (e.key === '0') setZoom(1);
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
    for (const f of list) if (f.type.startsWith('image/')) pending.push({ file: f, url: URL.createObjectURL(f), word: wordFromName(f.name) });
    renderPending();
  }
  function renderPending() {
    const box = $('pending'); box.innerHTML = '';
    pending.forEach((p, i) => {
      const el = document.createElement('div'); el.className = 'item';
      el.innerHTML = `<img alt=""><div class="fields"><input class="field" aria-label="Từ mới" placeholder="✏️ Nhập từ mới (vd: gloves)"></div><div class="acts"><button class="ibtn del" aria-label="Bỏ ảnh này">${ICON_DEL}</button></div>`;
      el.querySelector('img').src = p.url;
      const inp = el.querySelector('input'); inp.value = p.word; inp.oninput = () => (p.word = inp.value);
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
        const ins = await sb.from('cards').insert({ word: p.word.trim(), topic: t, image_path: path, sort_order: order });
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
      el.innerHTML = `<img alt=""><div class="fields"><input class="field w" aria-label="Từ mới"><input class="field t" list="topicList" aria-label="Chủ đề" placeholder="Chủ đề"></div>
        <div class="acts"><button class="ibtn up" aria-label="Lên trên">${ICON_UP}</button><button class="ibtn dn" aria-label="Xuống dưới">${ICON_DOWN}</button><button class="ibtn del" aria-label="Xoá thẻ">${ICON_DEL}</button></div>`;
      el.querySelector('img').src = c.url;
      const w = el.querySelector('.w'), t = el.querySelector('.t');
      w.value = c.word || ''; t.value = c.topic || '';
      const save = (inp, key) => async () => {
        const v = inp.value.trim();
        if (v === (c[key] || '')) return;
        if (key === 'word' && !v) { inp.value = c.word; return; }
        const { error } = await sb.from('cards').update({ [key]: v }).eq('id', c.id);
        setStatus('listStatus', error ? 'Không lưu được: ' + error.message : 'Đã lưu.', !!error);
        if (!error) loadCards();
      };
      w.onchange = save(w, 'word'); t.onchange = save(t, 'topic');
      [w, t].forEach(x => (x.onkeydown = e => { if (e.key === 'Enter') x.blur(); }));
      const up = el.querySelector('.up'), dn = el.querySelector('.dn');
      up.disabled = i === 0; dn.disabled = i === shown.length - 1;
      up.onclick = () => swap(c, shown[i - 1]);
      dn.onclick = () => swap(c, shown[i + 1]);
      el.querySelector('.del').onclick = async () => {
        if (!confirm(`Xoá thẻ “${c.word}”?`)) return;
        const { error } = await sb.from('cards').delete().eq('id', c.id);
        if (error) { setStatus('listStatus', 'Không xoá được: ' + error.message, true); return; }
        await sb.storage.from(BUCKET).remove([c.image_path]);
        setStatus('listStatus', 'Đã xoá.');
        loadCards();
      };
      box.appendChild(el);
    });
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

  function setStatus(id, msg, err) { const s = $(id); s.textContent = msg; s.classList.toggle('err', !!err); }
})();
