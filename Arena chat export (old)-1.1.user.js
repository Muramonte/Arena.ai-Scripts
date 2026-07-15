// ==UserScript==
// @name         Arena chat export (old)
// @namespace    https://tampermonkey.net/
// @version      1.1
// @description  Export chat history from Arena-like pages with iframe support and markdown preservation
// @match        https://arena.lmsys.org/*
// @match        https://chat.lmsys.org/*
// @match        https://arena.ai/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const BTN_ID = 'tm-chat-export-btn';
  const TOAST_ID = 'tm-chat-export-toast';
  const HOTKEY = 'Alt+Shift+S';

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function normalizeText(s) {
    return (s || '')
      .replace(/\r/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 10 && rect.height > 10;
  }

  function sanitizeFilename(name) {
    return (name || 'chat')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'chat';
  }

  function toast(msg) {
    const old = document.getElementById(TOAST_ID);
    if (old) old.remove();

    const el = document.createElement('div');
    el.id = TOAST_ID;
    el.textContent = msg;
    el.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:72px',
      'z-index:2147483647',
      'padding:10px 14px',
      'border-radius:10px',
      'background:rgba(20,20,20,.92)',
      'color:#fff',
      'font:13px/1.4 system-ui,sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,.25)',
      'max-width:360px'
    ].join(';');

    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  function downloadFile(text, filename) {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = sanitizeFilename(filename) + '.md';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function getFrameOffset(iframe) {
    const r = iframe.getBoundingClientRect();
    return { top: r.top, left: r.left };
  }

  function serializeInline(node) {
    if (!node) return '';

    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue || '';
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }

    const tag = node.tagName.toLowerCase();

    if (tag === 'br') return '\n';

    if (tag === 'strong' || tag === 'b') {
      return `**${Array.from(node.childNodes).map(serializeInline).join('') }**`;
    }

    if (tag === 'em' || tag === 'i') {
      return `*${Array.from(node.childNodes).map(serializeInline).join('') }*`;
    }

    if (tag === 'code' && node.parentElement && node.parentElement.tagName.toLowerCase() !== 'pre') {
      const txt = normalizeText(node.textContent || '').replace(/`/g, '\\`');
      return `\`${txt}\``;
    }

    if (tag === 'a') {
      const text = Array.from(node.childNodes).map(serializeInline).join('').trim() || (node.textContent || '').trim();
      const href = node.getAttribute('href');
      if (href && text) return `[${text}](${href})`;
      return text;
    }

    if (tag === 'pre') {
      const code = (node.textContent || '').replace(/\r/g, '').replace(/\n$/, '');
      return `\n\`\`\`\n${code}\n\`\`\`\n`;
    }

    if (tag === 'li') {
      const text = Array.from(node.childNodes).map(serializeInline).join('').trim();
      return `- ${text}\n`;
    }

    if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article' || tag === 'blockquote') {
      const text = Array.from(node.childNodes).map(serializeInline).join('');
      return text + '\n\n';
    }

    return Array.from(node.childNodes).map(serializeInline).join('');
  }

  function serializeBlockToMarkdown(el) {
    let text = serializeInline(el);

    text = text
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return text;
  }

  function collectCandidatesFromDocument(doc, accTop = 0, accLeft = 0, depth = 0, out = []) {
    const root = doc.body;
    if (!root) return out;

    const candidateSelectors = [
      '[data-message-id]',
      '[data-testid*="message"]',
      '[role="article"]',
      'article',
      '[class*="message"]',
      '[class*="msg"]',
      '[class*="chat"]',
      'main p',
      'main li',
      'main pre',
      'main blockquote',
      'p',
      'li',
      'pre',
      'blockquote'
    ].join(',');

    const nodes = Array.from(root.querySelectorAll(candidateSelectors));

    for (const el of nodes) {
      if (!isVisible(el)) continue;

      const rawText = normalizeText(el.innerText || el.textContent || '');
      if (rawText.length < 15) continue;
      if (rawText.length > 12000) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 10) continue;

      const childTextCount = Array.from(el.children || []).filter(ch => {
        if (!isVisible(ch)) return false;
        const t = normalizeText(ch.innerText || '');
        return t.length > 30;
      }).length;

      if (childTextCount > 8 && rawText.length < 300) continue;

      out.push({
        el,
        text: rawText,
        top: accTop + rect.top,
        left: accLeft + rect.left,
        depth
      });
    }

    const iframes = Array.from(root.querySelectorAll('iframe'));
    for (const iframe of iframes) {
      try {
        const innerDoc = iframe.contentDocument;
        if (!innerDoc || !innerDoc.body) continue;
        const off = getFrameOffset(iframe);
        collectCandidatesFromDocument(innerDoc, accTop + off.top, accLeft + off.left, depth + 1, out);
      } catch (e) {
        // Cross-origin iframe: inaccessible
      }
    }

    return out;
  }

  function dedupeAndSort(blocks) {
    blocks.sort((a, b) => {
      if (Math.abs(a.top - b.top) > 2) return a.top - b.top;
      if (Math.abs(a.left - b.left) > 2) return a.left - b.left;
      return a.depth - b.depth;
    });

    const result = [];
    const seen = new Set();

    for (const b of blocks) {
      const key = b.text.slice(0, 220);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(b);
    }

    return result;
  }

  function buildMarkdown(blocks) {
    const parts = [];

    parts.push(`# ${document.title || 'Chat export'}`);
    parts.push('');
    parts.push(`Exported: ${new Date().toLocaleString()}`);
    parts.push('');

    for (const b of blocks) {
      const md = serializeBlockToMarkdown(b.el);
      if (!md) continue;
      parts.push(md);
      parts.push('');
    }

    return parts.join('\n')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim() + '\n';
  }

  function fallbackWholePageText() {
    const text = normalizeText(document.body?.innerText || document.body?.textContent || '');
    return text ? `# ${document.title || 'Chat export'}\n\n${text}\n` : '';
  }

  async function exportChat() {
    try {
      toast('Сбор чата...');

      const blocks = dedupeAndSort(collectCandidatesFromDocument(document));

      let output = '';
      if (blocks.length >= 5) {
        output = buildMarkdown(blocks);
      } else {
        output = fallbackWholePageText();
      }

      if (!output.trim()) {
        toast('Текст не найден.');
        return;
      }

      downloadFile(output, document.title || 'arena-chat');
      toast('Файл скачан.');
    } catch (err) {
      console.error(err);
      toast('Ошибка экспорта.');
    }
  }

  function addButton() {
    if (document.getElementById(BTN_ID)) return;

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.textContent = 'Export chat';
    btn.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:2147483647',
      'padding:10px 14px',
      'border:none',
      'border-radius:12px',
      'background:#222',
      'color:#fff',
      'font:13px/1.2 system-ui,sans-serif',
      'cursor:pointer',
      'box-shadow:0 8px 24px rgba(0,0,0,.25)'
    ].join(';');

    btn.addEventListener('click', exportChat);
    document.body.appendChild(btn);
  }

  document.addEventListener('keydown', e => {
    if (e.altKey && e.shiftKey && (e.key === 'S' || e.key === 's' || e.code === 'KeyS')) {
      e.preventDefault();
      exportChat();
    }
  });

  const init = () => {
    if (document.body) addButton();
    else setTimeout(init, 200);
  };

  init();
})();