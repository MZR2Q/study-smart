/* ============================================================
   claude-api.js  —  غلاف بسيط حول Claude Messages API من المتصفح
   يستخدم ترويسة anthropic-dangerous-direct-browser-access للسماح
   بالاتصال المباشر من المتصفح (CORS).
   ============================================================ */

const CLAUDE = (() => {
  const STORAGE_KEY = 'studysmart_config_v1';
  const DEFAULT_MODEL = 'claude-opus-5-5';
  const DEFAULT_BASE = 'https://api.anthropic.com';
  const API_VERSION = '2023-06-01';

  /* ---------- الإعدادات (التخزين المحلي) ---------- */
  function getConfig() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
    catch { return {}; }
  }
  function saveConfig(cfg) {
    const current = getConfig();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...cfg }));
  }
  function hasKey() {
    const c = getConfig();
    return !!(c.apiKey && String(c.apiKey).trim());
  }
  function model() { return getConfig().model || DEFAULT_MODEL; }
  function lang() { return getConfig().lang || 'ar'; }
  function baseUrl() {
    const b = (getConfig().baseUrl || '').trim();
    return (b || DEFAULT_BASE).replace(/\/+$/, '');
  }

  function headers() {
    const c = getConfig();
    return {
      'content-type': 'application/json',
      'x-api-key': String(c.apiKey || '').trim(),
      'anthropic-version': API_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  }

  function langInstruction() {
    const l = lang();
    if (l === 'en') return 'Respond in clear English.';
    if (l === 'same') return 'Respond in the same language as the source slides.';
    return 'اكتب جوابك بالعربية الفصحى المبسّطة، مع إبقاء المصطلحات التقنية بالإنجليزية عند الحاجة.';
  }

  /* ---------- استخراج النص من الرد ---------- */
  function extractText(data) {
    if (!data || !Array.isArray(data.content)) return '';
    return data.content.filter(b => b.type === 'text').map(b => b.text).join('');
  }

  async function friendlyError(res) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j?.error?.message || JSON.stringify(j);
    } catch { try { detail = await res.text(); } catch { /* ignore */ } }

    if (res.status === 401) return 'مفتاح Claude غير صحيح أو غير فعّال (401). تأكد من المفتاح في الإعدادات.';
    if (res.status === 403) return 'ليس لديك صلاحية على هذا المفتاح/الموديل (403).';
    if (res.status === 404) return 'الموديل غير موجود (404). جرّب موديل آخر من الإعدادات.';
    if (res.status === 429) return 'تجاوزت حد الاستخدام مؤقتًا (429). انتظر قليلًا وأعد المحاولة.';
    if (res.status >= 500) return 'خطأ مؤقت من الخادم. أعد المحاولة بعد لحظات.';
    return `خطأ في الطلب (${res.status}): ${detail || 'غير معروف'}`;
  }

  /* ---------- طلب عادي (بدون بث) ---------- */
  async function complete({ system, messages, maxTokens = 2000, effort = 'medium' }) {
    if (!hasKey()) throw new Error('ما فيه مفتاح Claude محفوظ. روح للإعدادات وحط المفتاح.');
    const body = {
      model: model(),
      max_tokens: maxTokens,
      messages,
      output_config: { effort },
    };
    if (system) body.system = system;

    let res;
    try {
      res = await fetch(`${baseUrl()}/v1/messages`, {
        method: 'POST', headers: headers(), body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error('تعذّر الاتصال بخادم Claude. تحقق من الإنترنت ثم أعد المحاولة.');
    }
    if (!res.ok) throw new Error(await friendlyError(res));
    const data = await res.json();
    return extractText(data);
  }

  /* ---------- طلب مع بث (streaming) ---------- */
  async function stream({ system, messages, maxTokens = 3000, effort = 'medium', onDelta }) {
    if (!hasKey()) throw new Error('ما فيه مفتاح Claude محفوظ. روح للإعدادات وحط المفتاح.');
    const body = {
      model: model(),
      max_tokens: maxTokens,
      messages,
      stream: true,
      output_config: { effort },
    };
    if (system) body.system = system;

    let res;
    try {
      res = await fetch(`${baseUrl()}/v1/messages`, {
        method: 'POST', headers: headers(), body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error('تعذّر الاتصال بخادم Claude. تحقق من الإنترنت ثم أعد المحاولة.');
    }
    if (!res.ok) throw new Error(await friendlyError(res));
    if (!res.body) { // متصفح قديم ما يدعم البث — fallback
      const data = await res.json();
      const t = extractText(data);
      if (onDelta) onDelta(t, t);
      return t;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', full = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let evt; try { evt = JSON.parse(payload); } catch { continue; }
        if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
          full += evt.delta.text;
          if (onDelta) onDelta(evt.delta.text, full);
        } else if (evt.type === 'error') {
          throw new Error(evt.error?.message || 'خطأ أثناء البث من Claude.');
        }
      }
    }
    return full;
  }

  /* ---------- JSON منظّم (للملخص والكويز) ---------- */
  function stripFences(s) {
    return String(s || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  function parseJsonLoose(text) {
    const cleaned = stripFences(text);
    try { return JSON.parse(cleaned); } catch { /* ابحث عن أول كتلة JSON */ }
    const start = cleaned.search(/[\[{]/);
    if (start >= 0) {
      const open = cleaned[start];
      const close = open === '{' ? '}' : ']';
      const end = cleaned.lastIndexOf(close);
      if (end > start) {
        try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { /* ignore */ }
      }
    }
    throw new Error('تعذّر قراءة رد Claude بصيغة JSON.');
  }

  async function completeJson({ system, messages, maxTokens = 2500, effort = 'medium' }) {
    const text = await complete({ system, messages, maxTokens, effort });
    return parseJsonLoose(text);
  }

  return {
    getConfig, saveConfig, hasKey, model, lang, langInstruction,
    complete, stream, completeJson,
    DEFAULT_MODEL,
  };
})();
