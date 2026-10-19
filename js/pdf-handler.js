/* ============================================================
   pdf-handler.js  —  تحميل الـ PDF، استخراج النص، ورسم الصفحات
   يعتمد على PDF.js (window.pdfjsLib)
   ============================================================ */

const PDF = (() => {
  // ضبط مسار الـ worker على الـ CDN
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  let doc = null;        // كائن مستند PDF.js
  let meta = null;       // بيانات الملف الوصفية

  /* تحميل الملف من ArrayBuffer */
  async function load(arrayBuffer) {
    if (!window.pdfjsLib) throw new Error('مكتبة قراءة PDF لم تُحمَّل. تأكد من الاتصال بالإنترنت.');
    // نسخة من البيانات لأن PDF.js قد يستهلك الـ buffer
    const task = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) });
    doc = await task.promise;
    try { meta = await doc.getMetadata(); } catch { meta = null; }
    return { numPages: doc.numPages, meta };
  }

  function numPages() { return doc ? doc.numPages : 0; }

  function metaTitle() {
    const t = meta?.info?.Title;
    return (t && String(t).trim()) ? String(t).trim() : '';
  }

  /* استخراج نص صفحة واحدة */
  async function pageText(pageNum) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    // تجميع العناصر مع محاولة الحفاظ على فواصل الأسطر
    let lastY = null, out = '';
    for (const item of content.items) {
      const y = item.transform ? item.transform[5] : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) out += '\n';
      out += item.str + (item.hasEOL ? '\n' : ' ');
      lastY = y;
    }
    return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* استخراج نص كل الصفحات -> مصفوفة */
  async function allText(onProgress) {
    const n = numPages();
    const pages = [];
    for (let i = 1; i <= n; i++) {
      pages.push({ num: i, text: await pageText(i) });
      if (onProgress) onProgress(i, n);
    }
    return pages;
  }

  /* رسم صفحة على canvas معيّن بعرض مستهدف */
  async function renderTo(canvas, pageNum, targetWidth) {
    // ألغِ أي عملية رسم سابقة على نفس الـ canvas (تفادي خطأ PDF.js عند التنقّل السريع)
    if (canvas._renderTask) { try { canvas._renderTask.cancel(); } catch { /* ignore */ } }
    const page = await doc.getPage(pageNum);
    const base = page.getViewport({ scale: 1 });
    const scale = targetWidth ? (targetWidth / base.width) : 1;
    const viewport = page.getViewport({ scale });
    const ctx = canvas.getContext('2d');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const task = page.render({ canvasContext: ctx, viewport });
    canvas._renderTask = task;
    try { await task.promise; }
    catch (e) { if (e && e.name === 'RenderingCancelledException') return canvas; throw e; }
    finally { if (canvas._renderTask === task) canvas._renderTask = null; }
    return canvas;
  }

  /* رسم صورة مصغّرة وإرجاعها كـ dataURL */
  async function thumbnail(pageNum, width = 260) {
    const canvas = document.createElement('canvas');
    await renderTo(canvas, pageNum, width);
    return canvas;
  }

  function reset() { doc = null; meta = null; }

  return { load, numPages, metaTitle, pageText, allText, renderTo, thumbnail, reset };
})();
