/* ============================================================
   app.js  —  منطق التطبيق الرئيسي: التوجيه، الحالة، وربط الواجهة
   ============================================================ */

(() => {
  'use strict';

  /* ---------------- الحالة ---------------- */
  const state = {
    fileName: '',
    numPages: 0,
    pages: [],            // [{num, text}]
    overview: null,       // {title, topics[], summary}
    selected: new Set(),  // أرقام الصفحات المحددة
    studyList: [],        // أرقام الصفحات بالترتيب للمذاكرة
    current: 0,           // الفهرس داخل studyList
    explanations: {},     // {pageNum: text}
    slideChats: {},       // {pageNum: [{role, content}]}
    chapterChat: [],      // [{role, content}]
  };

  /* ---------------- أدوات DOM ---------------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

  let toastTimer = null;
  function toast(msg, type = '') {
    const t = $('#toast');
    t.textContent = msg; t.className = 'toast' + (type ? ' ' + type : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
  }
  function busy(on, text) {
    const b = $('#busy');
    if (text) $('#busyText').textContent = text;
    b.hidden = !on;
  }

  /* تحويل ماركداون مبسّط إلى HTML (للعرض فقط) */
  function mdToHtml(md) {
    if (!md) return '';
    let s = String(md);
    // هروب HTML
    s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // كود مضمّن
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    // عريض / مائل
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    // عناوين
    s = s.replace(/^###\s+(.+)$/gm, '<h4>$1</h4>');
    s = s.replace(/^##\s+(.+)$/gm, '<h3>$1</h3>');
    s = s.replace(/^#\s+(.+)$/gm, '<h3>$1</h3>');

    // قوائم
    const lines = s.split('\n');
    let out = '', inUl = false, inOl = false;
    const closeLists = () => { if (inUl) { out += '</ul>'; inUl = false; } if (inOl) { out += '</ol>'; inOl = false; } };
    for (let line of lines) {
      const ul = line.match(/^\s*[-*•]\s+(.+)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (ul) { if (!inUl) { closeLists(); out += '<ul>'; inUl = true; } out += `<li>${ul[1]}</li>`; }
      else if (ol) { if (!inOl) { closeLists(); out += '<ol>'; inOl = true; } out += `<li>${ol[1]}</li>`; }
      else if (/^<h[34]>/.test(line)) { closeLists(); out += line; }
      else if (line.trim() === '') { closeLists(); }
      else { closeLists(); out += `<p>${line}</p>`; }
    }
    closeLists();
    return out;
  }

  /* ---------------- التوجيه (Router) ---------------- */
  const ROUTES = ['upload', 'overview', 'study', 'settings'];
  function showView(name) {
    $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === name));
    $$('.main-nav a').forEach(a => {
      const map = { '#/': 'home', '#/settings': 'settings' };
      a.classList.toggle('active',
        (name === 'upload' && a.dataset.nav === 'home') ||
        (name === 'settings' && a.dataset.nav === 'settings'));
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function route() {
    const hash = location.hash || '#/';
    if (hash === '#/' || hash === '') { showView('upload'); return; }
    if (hash === '#/settings') { loadSettingsIntoForm(); showView('settings'); return; }
    if (hash === '#/overview') {
      if (!state.pages.length) { location.hash = '#/'; return; }
      showView('overview'); return;
    }
    if (hash === '#/study') {
      if (!state.studyList.length) { location.hash = state.pages.length ? '#/overview' : '#/'; return; }
      showView('study'); return;
    }
    showView('upload');
  }

  /* ---------------- حالة المفتاح في الهيدر ---------------- */
  function refreshKeyStatus() {
    const s = $('#keyStatus');
    if (CLAUDE.hasKey()) { s.textContent = '● المفتاح محفوظ'; s.className = 'key-status ok'; }
    else { s.textContent = '○ لا يوجد مفتاح'; s.className = 'key-status missing'; }
  }

  function requireKeyOrSettings() {
    if (CLAUDE.hasKey()) return true;
    toast('رجاءً حط مفتاح Claude في الإعدادات أولًا.', 'err');
    location.hash = '#/settings';
    return false;
  }

  /* ============================================================
     رفع الملف
     ============================================================ */
  function setupUpload() {
    const dz = $('#dropZone'), input = $('#fileInput');
    $('#pickBtn').addEventListener('click', () => input.click());
    dz.addEventListener('click', (e) => { if (e.target === dz || e.target.classList.contains('dz-title') || e.target.classList.contains('dz-icon') || e.target.classList.contains('dz-hint')) input.click(); });
    input.addEventListener('change', () => { if (input.files[0]) handleFile(input.files[0]); });

    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); if (ev === 'drop' || e.target === dz) dz.classList.remove('drag'); }));
    dz.addEventListener('drop', e => {
      const f = e.dataTransfer.files[0];
      if (f) handleFile(f);
    });
  }

  async function handleFile(file) {
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      toast('الرجاء اختيار ملف PDF.', 'err'); return;
    }
    if (!requireKeyOrSettings()) return;

    try {
      busy(true, 'جاري قراءة ملف الـ PDF...');
      // إعادة تهيئة الحالة
      Object.assign(state, {
        fileName: file.name, pages: [], overview: null,
        selected: new Set(), studyList: [], current: 0,
        explanations: {}, slideChats: {}, chapterChat: [],
      });

      const buf = await file.arrayBuffer();
      const { numPages } = await PDF.load(buf);
      state.numPages = numPages;

      busy(true, `جاري استخراج النص (${numPages} صفحة)...`);
      state.pages = await PDF.allText((i, n) => busy(true, `جاري استخراج النص... ${i}/${n}`));

      // الانتقال لشاشة الملخص وعرض الأساسيات فورًا
      fillOverviewBasics();
      location.hash = '#/overview';
      renderThumbnails(); // يرسم المصغّرات بالخلفية

      // توليد الملخص عبر Claude
      busy(false);
      await generateOverview();
    } catch (e) {
      busy(false);
      toast(e.message || 'صار خطأ أثناء قراءة الملف.', 'err');
      console.error(e);
    }
  }

  function fillOverviewBasics() {
    const guess = PDF.metaTitle() || state.fileName.replace(/\.pdf$/i, '');
    $('#ovTitle').textContent = guess;
    $('#ovPages').textContent = `${state.numPages} صفحة`;
    $('#ovFile').textContent = state.fileName;
    $('#ovSummary').innerHTML = '<div class="skeleton-lines"><span></span><span></span><span></span></div>';
    $('#ovTopics').innerHTML = '';
  }

  /* نص مجمّع للملف (مع حد أعلى للحجم) */
  function combinedText(maxChars = 60000) {
    let out = '';
    for (const p of state.pages) {
      const block = `\n\n[صفحة ${p.num}]\n${p.text}`;
      if (out.length + block.length > maxChars) { out += `\n\n[... تم اختصار بقية الصفحات لتجاوز الحجم ...]`; break; }
      out += block;
    }
    return out.trim();
  }

  async function generateOverview() {
    if (!CLAUDE.hasKey()) return;
    try {
      const system =
        'أنت مساعد تعليمي يحلّل سلايدات محاضرة مستخرجة من ملف PDF. ' +
        CLAUDE.langInstruction() +
        ' أعطِ تحليلًا دقيقًا مبنيًا على المحتوى فقط دون تأليف.';

      const prompt =
        `هذا نص سلايدات ملف من ${state.numPages} صفحة. حلّله وأعطني النتيجة بصيغة JSON فقط بدون أي نص إضافي، بالشكل:\n` +
        `{"title": "عنوان مناسب للملف", "topics": ["موضوع 1","موضوع 2", "..."], "summary": "ملخّص عام من 3-5 جمل يوضّح عن ايش يتكلم الملف"}\n\n` +
        `النص:\n${combinedText()}`;

      const data = await CLAUDE.completeJson({
        system,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 1800, effort: 'medium',
      });

      state.overview = {
        title: (data.title || '').trim() || $('#ovTitle').textContent,
        topics: Array.isArray(data.topics) ? data.topics.filter(Boolean) : [],
        summary: (data.summary || '').trim(),
      };
      renderOverview();
    } catch (e) {
      $('#ovSummary').innerHTML = `<p style="color:var(--danger)">تعذّر توليد الملخّص: ${e.message}</p>`;
      toast(e.message || 'تعذّر توليد الملخّص.', 'err');
      console.error(e);
    }
  }

  function renderOverview() {
    const ov = state.overview;
    if (!ov) return;
    if (ov.title) $('#ovTitle').textContent = ov.title;
    $('#ovSummary').innerHTML = mdToHtml(ov.summary) || '<p>—</p>';
    const topics = $('#ovTopics');
    topics.innerHTML = '';
    if (ov.topics.length) ov.topics.forEach(t => topics.appendChild(el('span', 'chip', t)));
    else topics.appendChild(el('span', 'chip', 'لم تُحدَّد مواضيع'));
  }

  /* ---------------- المصغّرات والتحديد ---------------- */
  async function renderThumbnails() {
    const grid = $('#thumbGrid');
    grid.innerHTML = '';
    const items = [];
    for (const p of state.pages) {
      const cell = el('div', 'thumb');
      cell.dataset.page = p.num;
      cell.appendChild(el('span', 'badge', `صفحة ${p.num}`));
      cell.appendChild(el('span', 'check', '✓'));
      cell.addEventListener('click', () => toggleSelect(p.num, cell));
      grid.appendChild(cell);
      items.push({ cell, num: p.num });
    }
    updateSelCount();
    // رسم تسلسلي حتى لا نثقل المتصفح
    for (const it of items) {
      try {
        const canvas = await PDF.thumbnail(it.num, 300);
        it.cell.insertBefore(canvas, it.cell.firstChild);
      } catch (e) { /* تجاهل فشل صفحة */ }
    }
  }

  function toggleSelect(num, cell) {
    if (state.selected.has(num)) { state.selected.delete(num); cell.classList.remove('sel'); }
    else { state.selected.add(num); cell.classList.add('sel'); }
    updateSelCount();
  }
  function updateSelCount() {
    $('#selCount').textContent = `${state.selected.size} محددة`;
    $('#startStudy').disabled = state.selected.size === 0;
  }

  function setupOverviewActions() {
    $('#selectAll').addEventListener('click', () => {
      state.pages.forEach(p => state.selected.add(p.num));
      $$('.thumb').forEach(c => c.classList.add('sel'));
      updateSelCount();
    });
    $('#selectNone').addEventListener('click', () => {
      state.selected.clear();
      $$('.thumb').forEach(c => c.classList.remove('sel'));
      updateSelCount();
    });
    $('#startStudy').addEventListener('click', () => {
      if (!state.selected.size) return;
      if (!requireKeyOrSettings()) return;
      state.studyList = Array.from(state.selected).sort((a, b) => a - b);
      state.current = 0;
      location.hash = '#/study';
      enterStudy();
    });
  }

  /* ============================================================
     المذاكرة
     ============================================================ */
  function currentPageNum() { return state.studyList[state.current]; }

  function enterStudy() {
    $('#studyTitle').textContent = (state.overview?.title || state.fileName.replace(/\.pdf$/i, '')) +
      ` — ${state.studyList.length} سلايد مختارة`;
    renderNavList();
    showSlide(state.current);
  }

  function renderNavList() {
    const list = $('#navList');
    list.innerHTML = '';
    state.studyList.forEach((num, idx) => {
      const item = el('div', 'nav-item');
      item.appendChild(el('span', 'dot'));
      item.appendChild(el('span', '', `سلايد ${num}`));
      if (idx === state.current) item.classList.add('active');
      if (state.explanations[num]) item.classList.add('done');
      item.addEventListener('click', () => { state.current = idx; showSlide(idx); });
      list.appendChild(item);
    });
  }

  async function showSlide(idx) {
    state.current = idx;
    const num = currentPageNum();
    $('#navPos').textContent = `${idx + 1} / ${state.studyList.length}`;
    $$('#navList .nav-item').forEach((it, i) => it.classList.toggle('active', i === idx));
    $('#prevSlide').disabled = idx === 0;
    $('#nextSlide').disabled = idx === state.studyList.length - 1;

    // رسم السلايد
    try {
      const stageW = Math.min($('.col-slide').clientWidth - 24, 900) || 700;
      await PDF.renderTo($('#slideCanvas'), num, stageW);
    } catch (e) { console.error(e); }

    // الشرح
    renderSlideChat(num);
    if (state.explanations[num]) {
      $('#explainBox').innerHTML = mdToHtml(state.explanations[num]);
    } else {
      await generateExplanation(num);
    }
  }

  async function generateExplanation(num) {
    if (!requireKeyOrSettings()) return;
    const box = $('#explainBox');
    box.classList.add('loading');
    box.innerHTML = '<p class="typing">جاري تحضير الشرح</p>';
    try {
      const page = state.pages.find(p => p.num === num);
      const system =
        'أنت أستاذ خصوصي ممتاز يشرح سلايدات المحاضرة للطالب بأسلوب مبسّط وسلس وواضح. ' +
        CLAUDE.langInstruction() +
        ' نظّم الشرح بعناوين ونقاط عند الحاجة، واربط الفكرة بمثال بسيط إن أمكن. لا تضف معلومات غير موجودة بالسلايد إلا للتوضيح البسيط.';
      const prompt =
        `اشرح لي هذه السلايد (صفحة ${num}) من ملف "${state.overview?.title || state.fileName}" شرحًا أفهمه بسهولة:\n\n` +
        `محتوى السلايد:\n${page?.text || '(لا يوجد نص قابل للاستخراج في هذه الصفحة)'}`;

      let acc = '';
      await CLAUDE.stream({
        system,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 2200, effort: 'medium',
        onDelta: (_d, full) => { acc = full; box.innerHTML = mdToHtml(full) + '<span class="typing"></span>'; box.scrollTop = box.scrollHeight; },
      });
      state.explanations[num] = acc;
      box.classList.remove('loading');
      box.innerHTML = mdToHtml(acc);
      renderNavList();
    } catch (e) {
      box.classList.remove('loading');
      box.innerHTML = `<p style="color:var(--danger)">تعذّر توليد الشرح: ${e.message}</p>`;
      toast(e.message || 'تعذّر توليد الشرح.', 'err');
    }
  }

  function setupStudyNav() {
    $('#prevSlide').addEventListener('click', () => { if (state.current > 0) showSlide(state.current - 1); });
    $('#nextSlide').addEventListener('click', () => { if (state.current < state.studyList.length - 1) showSlide(state.current + 1); });
    $('#regenExplain').addEventListener('click', () => {
      const num = currentPageNum();
      delete state.explanations[num];
      generateExplanation(num);
    });
    document.addEventListener('keydown', (e) => {
      if (!$('[data-view="study"]').classList.contains('active')) return;
      if (e.target.tagName === 'INPUT') return;
      if (e.key === 'ArrowRight' && state.current > 0) showSlide(state.current - 1);
      if (e.key === 'ArrowLeft' && state.current < state.studyList.length - 1) showSlide(state.current + 1);
    });
  }

  /* ---------------- اسأل عن السلايد ---------------- */
  function renderSlideChat(num) {
    const thread = $('#askThread');
    thread.innerHTML = '';
    (state.slideChats[num] || []).forEach(m => appendMsg(thread, m.role, m.content));
    thread.scrollTop = thread.scrollHeight;
  }

  function appendMsg(thread, role, content) {
    const m = el('div', 'msg ' + role);
    m.appendChild(el('div', 'who', role === 'user' ? 'أنت' : 'كلود'));
    const body = el('div', 'body');
    body.innerHTML = role === 'assistant' ? mdToHtml(content) : escapeHtml(content);
    m.appendChild(body);
    thread.appendChild(m);
    thread.scrollTop = thread.scrollHeight;
    return body;
  }
  function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function setupAsk() {
    $('#askForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('#askInput');
      const q = input.value.trim();
      if (!q) return;
      if (!requireKeyOrSettings()) return;
      const num = currentPageNum();
      input.value = '';
      state.slideChats[num] = state.slideChats[num] || [];
      state.slideChats[num].push({ role: 'user', content: q });
      const thread = $('#askThread');
      appendMsg(thread, 'user', q);
      const body = appendMsg(thread, 'assistant', '');
      body.classList.add('typing');

      try {
        const page = state.pages.find(p => p.num === num);
        const system =
          'أنت مساعد مذاكرة. أجب عن سؤال الطالب بالاعتماد على محتوى السلايد الحالية وسياق المحاضرة. ' +
          CLAUDE.langInstruction() + ' كن مباشرًا ومفيدًا.';
        // بناء رسائل المحادثة لهذه السلايد
        const history = state.slideChats[num].map(m => ({ role: m.role, content: m.content }));
        history[0] = {
          role: 'user',
          content: `سياق السلايد (صفحة ${num}) من ملف "${state.overview?.title || ''}":\n${page?.text || ''}\n\n---\nسؤالي: ${state.slideChats[num][0].content}`,
        };
        let acc = '';
        await CLAUDE.stream({
          system, messages: history, maxTokens: 1800, effort: 'low',
          onDelta: (_d, full) => { acc = full; body.innerHTML = mdToHtml(full); thread.scrollTop = thread.scrollHeight; },
        });
        body.classList.remove('typing');
        body.innerHTML = mdToHtml(acc);
        state.slideChats[num].push({ role: 'assistant', content: acc });
      } catch (err) {
        body.classList.remove('typing');
        body.innerHTML = `<span style="color:var(--danger)">${err.message}</span>`;
        toast(err.message, 'err');
      }
    });
  }

  /* ============================================================
     الكويز
     ============================================================ */
  function setupQuiz() {
    $('#openQuiz').addEventListener('click', openQuiz);
    $$('[data-close]').forEach(b => b.addEventListener('click', () => { $('#' + b.dataset.close).hidden = true; }));
    $$('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.hidden = true; }));
  }

  async function openQuiz() {
    if (!requireKeyOrSettings()) return;
    const modal = $('#quizModal');
    modal.hidden = false;
    const body = $('#quizBody');
    body.innerHTML = '<div class="skeleton-lines"><span></span><span></span><span></span></div><p style="color:var(--muted)">جاري توليد الأسئلة من السلايدات المختارة...</p>';
    try {
      const sel = state.studyList.length ? state.studyList : state.pages.map(p => p.num);
      const text = sel.map(n => {
        const p = state.pages.find(x => x.num === n);
        return `[صفحة ${n}]\n${p?.text || ''}`;
      }).join('\n\n').slice(0, 55000);

      const count = Math.min(10, Math.max(4, sel.length));
      const system =
        'أنت معلّم تصمّم اختبارات. اصنع أسئلة اختيار من متعدد دقيقة مبنية على المحتوى فقط. ' +
        CLAUDE.langInstruction();
      const prompt =
        `كوّن اختبارًا من ${count} أسئلة اختيار من متعدد (4 خيارات لكل سؤال) على محتوى هذه السلايدات. ` +
        `أعطني النتيجة بصيغة JSON فقط بالشكل:\n` +
        `{"questions":[{"q":"نص السؤال","options":["أ","ب","ج","د"],"answer":0,"explain":"سبب صحة الإجابة"}]}\n` +
        `حيث answer هو فهرس الخيار الصحيح (يبدأ من 0).\n\nالمحتوى:\n${text}`;

      const data = await CLAUDE.completeJson({
        system, messages: [{ role: 'user', content: prompt }],
        maxTokens: 3500, effort: 'medium',
      });
      renderQuiz(Array.isArray(data.questions) ? data.questions : []);
    } catch (e) {
      body.innerHTML = `<p style="color:var(--danger)">تعذّر توليد الكويز: ${e.message}</p>`;
    }
  }

  function renderQuiz(questions) {
    const body = $('#quizBody');
    body.innerHTML = '';
    if (!questions.length) { body.innerHTML = '<p>لم أتمكّن من توليد أسئلة.</p>'; return; }

    const form = el('form');
    questions.forEach((q, qi) => {
      const card = el('div', 'quiz-q');
      card.appendChild(el('div', 'q-text', `${qi + 1}. ${escapeHtml(q.q || '')}`));
      (q.options || []).forEach((opt, oi) => {
        const label = el('label', 'quiz-opt');
        const radio = el('input'); radio.type = 'radio'; radio.name = 'q' + qi; radio.value = oi;
        label.appendChild(radio);
        label.appendChild(el('span', '', escapeHtml(opt)));
        card.appendChild(label);
      });
      const expl = el('div', 'q-explain', q.explain ? `<strong>التوضيح:</strong> ${escapeHtml(q.explain)}` : '');
      card.appendChild(expl);
      form.appendChild(card);
    });
    body.appendChild(form);

    const actions = el('div', 'quiz-actions');
    const submitBtn = el('button', 'btn btn-primary', 'تصحيح الإجابات');
    submitBtn.type = 'button';
    const retryBtn = el('button', 'btn btn-ghost', 'كويز جديد');
    retryBtn.type = 'button';
    retryBtn.addEventListener('click', openQuiz);
    actions.appendChild(submitBtn);
    actions.appendChild(retryBtn);
    body.appendChild(actions);

    submitBtn.addEventListener('click', () => {
      let score = 0;
      const cards = $$('.quiz-q', form);
      cards.forEach((card, qi) => {
        const q = questions[qi];
        const opts = $$('.quiz-opt', card);
        const chosen = $(`input[name="q${qi}"]:checked`, card);
        opts.forEach((o, oi) => {
          o.classList.remove('chosen', 'correct', 'wrong');
          $('input', o).disabled = true;
          if (oi === q.answer) o.classList.add('correct');
        });
        if (chosen) {
          const ci = parseInt(chosen.value, 10);
          opts[ci].classList.add('chosen');
          if (ci === q.answer) score++; else opts[ci].classList.add('wrong');
        }
        $('.q-explain', card).classList.add('show');
      });
      const scoreEl = el('div', 'quiz-score', `نتيجتك: ${score} / ${questions.length}`);
      body.insertBefore(scoreEl, form);
      scoreEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      submitBtn.disabled = true;
    });
  }

  /* ============================================================
     نقاش الشابتر
     ============================================================ */
  function setupChapter() {
    $('#openChapter').addEventListener('click', () => {
      if (!requireKeyOrSettings()) return;
      $('#chapterModal').hidden = false;
      renderChapterThread();
      $('#chapterInput').focus();
    });
    $('#chapterForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('#chapterInput');
      const q = input.value.trim();
      if (!q) return;
      input.value = '';
      const thread = $('#chapterThread');
      state.chapterChat.push({ role: 'user', content: q });
      appendMsg(thread, 'user', q);
      const body = appendMsg(thread, 'assistant', '');
      body.classList.add('typing');
      try {
        const system =
          'أنت أستاذ خبير في موضوع هذه المحاضرة، تناقش الطالب في محتوى الشابتر كامل وتجاوب أسئلته وتربط بين الأفكار. ' +
          CLAUDE.langInstruction();
        const history = state.chapterChat.map(m => ({ role: m.role, content: m.content }));
        history[0] = {
          role: 'user',
          content: `هذا محتوى الشابتر كامل من ملف "${state.overview?.title || state.fileName}":\n${combinedText(70000)}\n\n---\nأول رسالة مني: ${state.chapterChat[0].content}`,
        };
        let acc = '';
        await CLAUDE.stream({
          system, messages: history, maxTokens: 2500, effort: 'medium',
          onDelta: (_d, full) => { acc = full; body.innerHTML = mdToHtml(full); thread.scrollTop = thread.scrollHeight; },
        });
        body.classList.remove('typing');
        body.innerHTML = mdToHtml(acc);
        state.chapterChat.push({ role: 'assistant', content: acc });
      } catch (err) {
        body.classList.remove('typing');
        body.innerHTML = `<span style="color:var(--danger)">${err.message}</span>`;
      }
    });
  }

  function renderChapterThread() {
    const thread = $('#chapterThread');
    thread.innerHTML = '';
    if (!state.chapterChat.length) {
      thread.appendChild(el('div', 'msg assistant',
        '<div class="who">كلود</div><div class="body">أهلاً! اسألني أي شيء عن الشابتر كامل — مقارنات، تلخيص، أمثلة، أو أي نقطة ما فهمتها.</div>'));
    } else {
      state.chapterChat.forEach(m => appendMsg(thread, m.role, m.content));
    }
  }

  /* ============================================================
     الإعدادات
     ============================================================ */
  function loadSettingsIntoForm() {
    const c = CLAUDE.getConfig();
    $('#apiKeyInput').value = c.apiKey || '';
    $('#modelSelect').value = c.model || CLAUDE.DEFAULT_MODEL;
    $('#langSelect').value = c.lang || 'ar';
    $('#baseUrlInput').value = c.baseUrl || '';
    $('#settingsMsg').textContent = '';
  }

  function setupSettings() {
    $('#revealKey').addEventListener('click', () => {
      const i = $('#apiKeyInput');
      i.type = i.type === 'password' ? 'text' : 'password';
    });
    $('#settingsForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const key = $('#apiKeyInput').value.trim();
      CLAUDE.saveConfig({
        apiKey: key,
        model: $('#modelSelect').value,
        lang: $('#langSelect').value,
        baseUrl: $('#baseUrlInput').value.trim(),
      });
      refreshKeyStatus();
      const msg = $('#settingsMsg');
      msg.textContent = key ? '✓ تم الحفظ بنجاح.' : '✓ تم الحفظ (تنبيه: لا يوجد مفتاح).';
      msg.className = 'settings-msg ok';
      toast('تم حفظ الإعدادات.', 'ok');
    });
    $('#testConn').addEventListener('click', async () => {
      const key = $('#apiKeyInput').value.trim();
      if (!key) { toast('حط المفتاح أولًا.', 'err'); return; }
      // احفظ مؤقتًا ثم اختبر
      CLAUDE.saveConfig({
        apiKey: key, model: $('#modelSelect').value,
        lang: $('#langSelect').value, baseUrl: $('#baseUrlInput').value.trim(),
      });
      const msg = $('#settingsMsg');
      msg.textContent = 'جاري الاختبار...'; msg.className = 'settings-msg';
      try {
        const r = await CLAUDE.complete({
          messages: [{ role: 'user', content: 'قل "تم" فقط.' }],
          maxTokens: 20, effort: 'low',
        });
        msg.textContent = '✓ الاتصال ناجح! المفتاح يعمل.';
        msg.className = 'settings-msg ok';
        refreshKeyStatus();
      } catch (e) {
        msg.textContent = '✗ ' + e.message;
        msg.className = 'settings-msg err';
      }
    });
  }

  /* ---------------- روابط التنقّل ---------------- */
  function setupLinks() {
    document.addEventListener('click', (e) => {
      const link = e.target.closest('[data-link]');
      if (link) { e.preventDefault(); location.hash = link.dataset.link; }
    });
  }

  /* ---------------- الإقلاع ---------------- */
  function init() {
    setupLinks();
    setupUpload();
    setupOverviewActions();
    setupStudyNav();
    setupAsk();
    setupQuiz();
    setupChapter();
    setupSettings();
    refreshKeyStatus();

    window.addEventListener('hashchange', route);
    route();

    // عند تغيّر حجم النافذة أعِد رسم السلايد الحالية
    let rt;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => {
        if ($('[data-view="study"]').classList.contains('active') && state.studyList.length) {
          PDF.renderTo($('#slideCanvas'), currentPageNum(),
            Math.min($('.col-slide').clientWidth - 24, 900) || 700).catch(() => {});
        }
      }, 250);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
