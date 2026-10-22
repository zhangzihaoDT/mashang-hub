// Generic, bounded input envelope shared by browser and Hub. Bytes are checked again by the capability.
export const attachmentLimits = { count: 6, fileBytes: 5 * 1024 * 1024, totalBytes: 12 * 1024 * 1024, text: 200000 };
export const imageTypes = ['image/png', 'image/jpeg', 'image/webp'];
export function inputAttachments(input) {
  const files = input.attachments ?? [], documents = input.sourceDocuments ?? [];
  const invalid = () => { throw Error('附件无效：支持 PNG、JPEG、WebP，最多 6 张，单张 5 MiB，总计 12 MiB。'); };
  if (!Array.isArray(files) || files.length > attachmentLimits.count || !Array.isArray(documents) || documents.length > 4) invalid();
  let total = 0, text = 0;
  const attachments = files.map(file => {
    if (!file || !imageTypes.includes(file.mime) || typeof file.filename !== 'string' || file.filename.length > 160 || /[\x00-\x1f\x7f/\\]/u.test(file.filename) || typeof file.url !== 'string') invalid();
    const prefix = `data:${file.mime};base64,`;
    if (!file.url.startsWith(prefix)) invalid();
    const base64 = file.url.slice(prefix.length);
    if (!base64 || base64.length > Math.ceil(attachmentLimits.fileBytes / 3) * 4 || (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(base64))) invalid();
    const size = base64.length / 4 * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
    if (size > attachmentLimits.fileBytes) invalid();
    total += size;
    return { type: 'file', mime: file.mime, filename: file.filename, url: file.url };
  });
  const sourceDocuments = documents.map(doc => {
    if (!doc || doc.mime !== 'text/html' || typeof doc.text !== 'string' || doc.text.length > attachmentLimits.text) invalid();
    text += doc.text.length;
    return { mime: 'text/html', text: doc.text };
  });
  if (total > attachmentLimits.totalBytes || text > attachmentLimits.text * 2) invalid();
  return { attachments, sourceDocuments };
}
