import { inspectExecution, waitForExecution } from '../opencode-execution.mjs';
const failure = code => Object.assign(new Error(code), { code });
const textOf = response => (response?.parts || []).filter(part => part.type === 'text').map(part => part.text || '').join('\n').trim();
export async function readNoteResponse(api, record, initial, waitOptions = {}) {
  const { structured = false, ...executionOptions } = waitOptions;
  let response = initial;
  if (response?.info?.error) throw failure('NOTE_MODEL_FAILED');
  if (!textOf(response) || response?.info?.id && response.info.finish !== 'stop') {
    let evidence = await inspectExecution(api, record);
    if (evidence.state === 'RUNNING') evidence = await waitForExecution(api, record, executionOptions);
    if (evidence?.state !== 'COMPLETED') throw failure(evidence?.state === 'FAILED' ? 'NOTE_MODEL_FAILED' : 'NOTE_RESPONSE_EMPTY');
    response = evidence.response;
  }
  const text = textOf(response).replace(/^```(?:json)?\s*|\s*```$/g, '');
  if (!text) throw failure('NOTE_RESPONSE_EMPTY');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw failure('NOTE_RESPONSE_FORMAT'); }
  if (typeof parsed?.final_note !== 'string' || !parsed.final_note.trim()) throw failure('NOTE_RESPONSE_FORMAT');
  if (parsed.final_note.length > 60000) throw failure('NOTE_RESPONSE_FORMAT');
  if (structured) {
    if (typeof parsed.extracted_content !== 'string' || !parsed.extracted_content.trim() || parsed.extracted_content.length > 200000) throw failure('NOTE_RESPONSE_FORMAT');
    return { final_note: parsed.final_note, extracted_content: parsed.extracted_content };
  }
  return parsed.final_note;
}
export function noteFailure(error) {
  if (error?.sourcesSaved) return { code: 'NOTE_SOURCES_SAVED', message: error.code === 'NOTE_IMAGE_MODEL' ? '原始资料已保存，当前模型不支持图片识别；请选择支持图片的模型后重新整理。' : '原始资料已保存，笔记整理未完成；输入仍保留，可重新整理。' };
  const formatError = /^(First line must be a bold title|Finish Flomo formatting before preview|Remove blank lines between list items|Preserve original tags|final_note must already have normalized whitespace and newlines)$/.test(error?.message || '');
  const code = ['NOTE_SESSION_DIRECTORY','NOTE_MODEL_FAILED','NOTE_RESPONSE_EMPTY','NOTE_RESPONSE_FORMAT'].includes(error?.code) ? error.code
    : /exceeds 2000/.test(error?.message || '') ? 'NOTE_TOO_LONG' : formatError ? 'NOTE_RESPONSE_FORMAT' : 'NOTE_PREPARATION_FAILED';
  const message = {
    NOTE_SESSION_DIRECTORY: '笔记工作目录尚未就绪，请稍后再试。',
    NOTE_MODEL_FAILED: '笔记整理服务暂时不可用，尚未发送到 Flomo。',
    NOTE_RESPONSE_EMPTY: '笔记整理未返回内容，尚未发送到 Flomo。',
    NOTE_RESPONSE_FORMAT: '整理后的笔记格式不完整，尚未发送到 Flomo。',
    NOTE_TOO_LONG: '笔记超过 Flomo 的 2000 字限制，请先保存本地并精简内容。',
    NOTE_PREPARATION_FAILED: '笔记预览未完成，尚未发送到 Flomo。',
  }[code];
  return { code, message };
}

// Only remove whitespace between adjacent list items; fenced code stays exact.
export function normalizeFlomoListSpacing(text) {
  const lines = text.split('\n'), output = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
    }
    if (!fence && !lines[i].trim() && /^- .+/.test(output.at(-1) || '')) {
      let next = i + 1;
      while (next < lines.length && !lines[next].trim()) next++;
      if (/^- .+/.test(lines[next] || '')) { i = next - 1; continue; }
    }
    output.push(lines[i]);
  }
  return output.join('\n');
}
