import { attachmentLimits, imageTypes, inputAttachments } from './input-attachments.js';

// Parse into an inert template, traverse an allowlist, never insert clipboard HTML into the page.
export function richTextToMarkdown(html, document = globalThis.document) {
  const template = document.createElement('template'); template.innerHTML = html;
  let omittedImages = 0;
  const visit = node => {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1 && node.nodeType !== 11) return '';
    const tag = node.nodeName.toLowerCase();
    if (['script','style','iframe','object','embed','svg','math','form','input','button','noscript','template'].includes(tag)) return '';
    if (tag === 'img') { omittedImages++; return ''; }
    const text = [...node.childNodes].map(visit).join('');
    if (tag === 'br') return '\n';
    if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${text.trim()}\n\n`;
    if (['strong','b'].includes(tag)) return `**${text}**`;
    if (['em','i'].includes(tag)) return `*${text}*`;
    if (tag === 'pre') return `\n\n\`\`\`\n${node.textContent}\n\`\`\`\n\n`;
    if (tag === 'code') return `\`${text}\``;
    if (tag === 'a') {
      try { const url = new URL(node.getAttribute('href')); if (['https:','http:'].includes(url.protocol)) return `[${text.replace(/[\[\]]/g, '')}](${url.href.replace(/[()]/g, c => encodeURIComponent(c))})`; } catch {}
      return text;
    }
    if (tag === 'li') return `\n${node.parentElement?.nodeName === 'OL' ? `${[...node.parentElement.children].indexOf(node) + 1}.` : '-'} ${text.trim()}`;
    if (tag === 'blockquote') return '\n\n' + text.trim().split('\n').map(line => `> ${line}`).join('\n') + '\n\n';
    if (['p','div','section','article','ul','ol','tr'].includes(tag)) return `\n${text}\n`;
    if (['td','th'].includes(tag)) return `${text.trim()}\t`;
    return text;
  };
  return { text: visit(template.content).replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), omittedImages };
}
const readFile = file => new Promise((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(Error('图片读取失败，请重新选择。')); reader.readAsDataURL(file);
});
export function createNoteInput({ input, panel, picker, button, list, status, active, busy, changed, notice }) {
  let attachments = [], sourceDocuments = [], reading = false;
  const render = () => {
    panel.classList.toggle('hidden', !active());
    const blocked = busy() || reading;
    button.disabled = blocked; picker.disabled = blocked;
    input.readOnly = active() && blocked;
    input.required = !(active() && attachments.length);
    list.replaceChildren();
    for (const [index, file] of attachments.entries()) {
      const item = document.createElement('div'); item.className = 'note-attachment';
      const image = document.createElement('img'); image.src = file.url; image.alt = file.filename;
      const name = document.createElement('span'); name.textContent = file.filename;
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'quiet'; remove.textContent = '移除'; remove.disabled = blocked; remove.setAttribute('aria-label', `移除 ${file.filename}`);
      remove.onclick = () => { attachments.splice(index, 1); render(); changed(); };
      item.append(image, name, remove); list.append(item);
    }
    status.textContent = reading ? '正在读取图片…' : `${attachments.length ? `${attachments.length} 张图片 · ` : ''}${sourceDocuments.length ? '已保留富文本原始资料供本地保存；同步 Flomo 仅发送整理后的文字。' : ''}支持粘贴、拖入图片，最多 6 张，单张 5 MiB。图片仅保存到本地笔记。`;
  };
  const add = async files => {
    if (busy() || reading) return;
    reading = true; changed(); render();
    try {
      if (attachments.length + files.length > attachmentLimits.count) throw Error('每条笔记最多添加 6 张图片。');
      if (files.some(file => !imageTypes.includes(file.type) || !file.size || file.size > attachmentLimits.fileBytes)) throw Error('请选择不超过 5 MiB 的 PNG、JPEG 或 WebP 图片。');
      const candidates = await Promise.all(files.map(async file => ({ type: 'file', mime: file.type, filename: (file.name || '截图.png').replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 160), url: await readFile(file) })));
      const validated = inputAttachments({ attachments: [...attachments, ...candidates], sourceDocuments });
      // Decode in-browser too, so a misleading file extension never becomes a broken preview.
      for (const candidate of candidates) {
        const image = new Image(); image.src = candidate.url;
        await image.decode().catch(() => { throw Error('图片无法解码，请重新导出或截图。'); });
        if (image.naturalWidth * image.naturalHeight > 40000000) throw Error('图片像素过大，请缩小后重试。');
      }
      attachments = validated.attachments;
    } catch (error) { notice(error.message); }
    finally { reading = false; render(); changed(); }
  };
  button.onclick = () => picker.click();
  picker.onchange = () => { const files = [...picker.files]; picker.value = ''; void add(files); };
  input.addEventListener('input', () => {
    if (active() && !busy() && !reading && !input.value.trim() && sourceDocuments.length) {
      sourceDocuments = []; render(); changed();
    }
  });
  input.addEventListener('paste', event => {
    if (!active()) return;
    if (busy() || reading) { event.preventDefault(); return; }
    const files = [...(event.clipboardData?.files || [])];
    const html = event.clipboardData?.getData('text/html');
    const plain = event.clipboardData?.getData('text/plain') || '';
    if (!files.length && !html) return;
    event.preventDefault();
    if (html) {
      try {
        const docs = [...sourceDocuments, { mime: 'text/html', text: html }];
        inputAttachments({ attachments, sourceDocuments: docs });
        const converted = richTextToMarkdown(html);
        const text = converted.text || plain;
        input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
        sourceDocuments = docs;
        if (converted.omittedImages && !files.length) notice('网页内的图片未下载；请另行粘贴截图或上传图片。');
      } catch { notice('富文本内容过大，请分次保存。'); return; }
    } else if (plain) input.setRangeText(plain, input.selectionStart, input.selectionEnd, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (files.length) void add(files); else { render(); changed(); }
  });
  const form = input.closest('form');
  form.addEventListener('dragover', event => { if (active() && event.dataTransfer?.types.includes('Files')) { event.preventDefault(); form.classList.add('note-drop-active'); } });
  form.addEventListener('dragleave', () => form.classList.remove('note-drop-active'));
  form.addEventListener('drop', event => {
    if (!active() || !event.dataTransfer?.files.length) return;
    event.preventDefault(); form.classList.remove('note-drop-active'); void add([...event.dataTransfer.files]);
  });
  return { render, get reading() { return reading; }, get count() { return attachments.length; }, get hasSources() { return attachments.length > 0 || sourceDocuments.length > 0; }, snapshot: () => inputAttachments({ attachments, sourceDocuments }), clear: () => { attachments = []; sourceDocuments = []; render(); changed(); } };
}
