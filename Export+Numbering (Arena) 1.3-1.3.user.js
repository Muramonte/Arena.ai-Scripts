// ==UserScript==
// @name         Export+Numbering (Arena) 1.3
// @namespace    https://tampermonkey.net/
// @version      1.3
// @description  Export chat history from Arena-like pages with iframe support and markdown preservation + numbering (#1 - user, #1.1 - model answer)
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
  // Hotkey: Alt+Shift+S (wired directly in the keydown listener below)

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
      'left:50%',
      'bottom:66px',
      'transform:translateX(-50%)',
      'z-index:2147483647',
      'padding:10px 14px',
      'border-radius:10px',
      'background:rgba(20,20,20,.92)',
      'color:#fff',
      'font:13px/1.4 system-ui,sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,.25)',
      'max-width:360px',
      'text-align:center'
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

  // arena.ai specific: a user message wrapper has a class containing
  // "justify-end"; an assistant message wrapper has the class
  // "bg-surface-primary" and carries the model name in a nested
  // span.truncate inside its sticky header.
  function detectRole(el) {
    let node = el;
    while (node && node !== document.body) {
      if (node.classList) {
        const classes = Array.from(node.classList);
        if (classes.some(c => c.includes('justify-end'))) {
          return { role: 'user', model: null };
        }
        if (classes.includes('bg-surface-primary')) {
          const modelSpan = node.querySelector('span.truncate');
          return { role: 'assistant', model: modelSpan ? normalizeText(modelSpan.textContent) : null };
        }
      }
      node = node.parentElement;
    }
    return { role: 'unknown', model: null };
  }

  // Site-specific structured collection: each ".prose" block is treated as
  // one whole message (not split into separate paragraph/list candidates),
  // and tagged with its role (user/assistant) for numbering.
  function collectMessageBlocks(doc, accTop = 0, accLeft = 0, depth = 0, out = [], orderRef = { n: 0 }) {
    const root = doc.body;
    if (!root) return out;

    const proseNodes = Array.from(root.querySelectorAll('.prose'));

    for (const el of proseNodes) {
      if (!isVisible(el)) continue;

      // Skip nested .prose blocks inside another .prose block (avoid double count)
      if (el.parentElement && el.parentElement.closest('.prose')) continue;

      const rawText = normalizeText(el.innerText || el.textContent || '');
      if (!rawText) continue;
      if (rawText.length > 20000) continue;

      const rect = el.getBoundingClientRect();
      const roleInfo = detectRole(el);

      out.push({
        el,
        text: rawText,
        top: accTop + rect.top,
        left: accLeft + rect.left,
        depth,
        order: orderRef.n++,
        role: roleInfo.role,
        model: roleInfo.model
      });
    }

    const iframes = Array.from(root.querySelectorAll('iframe'));
    for (const iframe of iframes) {
      try {
        const innerDoc = iframe.contentDocument;
        if (!innerDoc || !innerDoc.body) continue;
        const off = getFrameOffset(iframe);
        collectMessageBlocks(innerDoc, accTop + off.top, accLeft + off.left, depth + 1, out, orderRef);
      } catch (e) {
        // Cross-origin iframe: inaccessible
      }
    }

    return out;
  }

  function sortMessageBlocks(blocks) {
    const sorted = blocks.slice().sort((a, b) => {
      if (Math.abs(a.top - b.top) > 2) return a.top - b.top;
      if (Math.abs(a.left - b.left) > 2) return a.left - b.left;
      if (a.depth !== b.depth) return a.depth - b.depth;
      return a.order - b.order;
    });

    const result = [];
    const seen = new Set();
    for (const b of sorted) {
      const key = b.text.slice(0, 220);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(b);
    }
    return result;
  }

  // Numbers user turns as #1, #2, ... and each assistant reply following a
  // user turn as #N.1, #N.2, ... (multiple assistant replies before the
  // next user turn — e.g. side-by-side comparisons — just keep incrementing
  // the sub-counter).
  function assignNumbers(blocks) {
    let userCounter = 0;
    let subCounter = 0;

    for (const b of blocks) {
      if (b.role === 'user') {
        userCounter++;
        subCounter = 0;
        b.label = `#${userCounter}`;
      } else if (b.role === 'assistant') {
        subCounter++;
        b.label = `#${userCounter || 0}.${subCounter}`;
      } else {
        b.label = null;
      }
    }
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

    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      const text = Array.from(node.childNodes).map(serializeInline).join('').trim();
      return `${'#'.repeat(level)} ${text}\n\n`;
    }

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
      if (href) {
        return text ? `[${text}](${href})` : `[link](${href})`;
      }
      return text;
    }

    if (tag === 'pre') {
      const code = (node.textContent || '').replace(/\r/g, '').replace(/\n$/, '');
      return `\n\`\`\`\n${code}\n\`\`\`\n`;
    }

    if (tag === 'li') {
      const text = Array.from(node.childNodes).map(serializeInline).join('').trim();
      const parent = node.parentElement;
      if (parent && parent.tagName.toLowerCase() === 'ol') {
        const items = Array.from(parent.children).filter(c => c.tagName.toLowerCase() === 'li');
        const idx = items.indexOf(node);
        const start = parseInt(parent.getAttribute('start') || '1', 10);
        const num = start + (idx >= 0 ? idx : 0);
        return `${num}. ${text}\n`;
      }
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

  function collectCandidatesFromDocument(doc, accTop = 0, accLeft = 0, depth = 0, out = [], orderRef = { n: 0 }) {
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
      'blockquote',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6'
    ].join(',');

    const nodes = Array.from(root.querySelectorAll(candidateSelectors));

    for (const el of nodes) {
      if (!isVisible(el)) continue;

      const isHeading = /^h[1-6]$/i.test(el.tagName);
      const rawText = normalizeText(el.innerText || el.textContent || '');

      if (!isHeading && rawText.length < 15) continue;
      if (rawText.length > 12000) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 10) continue;

      const childTextCount = Array.from(el.children || []).filter(ch => {
        if (!isVisible(ch)) return false;
        const t = normalizeText(ch.innerText || '');
        return t.length > 30;
      }).length;

      if (!isHeading && childTextCount > 8 && rawText.length < 300) continue;

      out.push({
        el,
        text: rawText,
        top: accTop + rect.top,
        left: accLeft + rect.left,
        depth,
        order: orderRef.n++
      });
    }

    const iframes = Array.from(root.querySelectorAll('iframe'));
    for (const iframe of iframes) {
      try {
        const innerDoc = iframe.contentDocument;
        if (!innerDoc || !innerDoc.body) continue;
        const off = getFrameOffset(iframe);
        collectCandidatesFromDocument(innerDoc, accTop + off.top, accLeft + off.left, depth + 1, out, orderRef);
      } catch (e) {
        // Cross-origin iframe: inaccessible
      }
    }

    return out;
  }

  // Drop container blocks whenever a more specific (descendant) block was
  // also collected — prevents the same content appearing twice (once as
  // the wrapping message div, once as its inner paragraphs/list items).
  function removeContainerDuplicates(blocks) {
    return blocks.filter(b => {
      for (const other of blocks) {
        if (other === b) continue;
        if (b.el.contains(other.el)) return false; // b is an ancestor of another candidate -> drop b
      }
      return true;
    });
  }

  function dedupeAndSort(blocks) {
    const withoutContainers = removeContainerDuplicates(blocks);

    withoutContainers.sort((a, b) => {
      if (Math.abs(a.top - b.top) > 2) return a.top - b.top;
      if (Math.abs(a.left - b.left) > 2) return a.left - b.left;
      if (a.depth !== b.depth) return a.depth - b.depth;
      return a.order - b.order;
    });

    const result = [];
    const seen = new Set();

    for (const b of withoutContainers) {
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

  // Same as buildMarkdown, but prefixes each message with its "#1", "#1.1"
  // label and a role heading (who sent it / which model answered).
  function buildNumberedMarkdown(blocks) {
    const parts = [];

    parts.push(`# ${document.title || 'Chat export'}`);
    parts.push('');
    parts.push(`Exported: ${new Date().toLocaleString()}`);
    parts.push('');

    for (const b of blocks) {
      const md = serializeBlockToMarkdown(b.el);
      if (!md) continue;

      if (b.label) {
        const who = b.role === 'user' ? 'Вы' : (b.model || 'Модель');
        parts.push(`### ${b.label} ${who}`);
        parts.push('');
      }

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

      let output = '';

      // 1) Try structured, numbered collection (relies on arena.ai's
      //    current markup: .prose message blocks + justify-end /
      //    bg-surface-primary role classes).
      const messageBlocks = sortMessageBlocks(collectMessageBlocks(document));
      const knownRoleCount = messageBlocks.filter(b => b.role === 'user' || b.role === 'assistant').length;

      if (messageBlocks.length >= 2 && knownRoleCount >= messageBlocks.length / 2) {
        assignNumbers(messageBlocks);
        output = buildNumberedMarkdown(messageBlocks);
      } else {
        // 2) Fall back to the generic block collector (no numbering) —
        //    used on pages that don't match the expected markup.
        const blocks = dedupeAndSort(collectCandidatesFromDocument(document));
        if (blocks.length >= 5) {
          output = buildMarkdown(blocks);
        } else {
          // 3) Last resort: dump the whole visible page text.
          output = fallbackWholePageText();
        }
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
    btn.textContent = 'Export';
    btn.style.cssText = [
      'position:fixed',
      'left:50%',
      'bottom:16px',
      'transform:translateX(-50%)',
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
