'use strict';
/**
 * Файлы (фото, видео, документы) для обращений и чата.
 * Загрузка: POST /api/files — «сырое» тело запроса, заголовки Content-Type и X-File-Name (encodeURIComponent).
 * Хранение: байты в ${DATA_DIR}/files/<id>, метаданные — таблица files. id — 24 случайных байта (hex).
 * Выдача: GET /api/files/:id без авторизации (id неугадываем), с поддержкой Range для видео.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_FILE = 25 * 1024 * 1024;
const ID_RE = /^[0-9a-f]{48}$/;

const EXACT = new Set([
  'video/mp4', 'video/webm', 'video/quicktime', 'application/pdf',
  'application/msword', 'application/vnd.ms-excel', 'text/plain', 'text/csv'
]);

function httpError(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }

function baseType(ct) { return String(ct || '').split(';')[0].trim().toLowerCase(); }

function isAllowed(type) {
  if (!type || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type)) return false;
  if (type === 'image/svg+xml') return false; // SVG может содержать скрипты — не принимаем
  if (type.startsWith('image/')) return true;
  if (EXACT.has(type)) return true;
  return type.startsWith('application/vnd.openxmlformats-officedocument.');
}

function kindOf(type) { return type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : 'doc'; }
const isInline = (type) => type.startsWith('image/') || type.startsWith('video/') || type === 'application/pdf';

function cleanName(raw) {
  let name = 'файл';
  if (raw) { try { name = decodeURIComponent(String(raw)); } catch (_) { name = String(raw); } }
  name = name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim().slice(0, 140);
  return name || 'файл';
}

function publicMeta(f) {
  return { id: f.id, name: f.name, type: f.type, size: f.size, kind: kindOf(f.type), url: '/api/files/' + f.id };
}

/** Принять загрузку. Возвращает { status: 201, body: meta }. */
function upload(req, store, me) {
  const type = baseType(req.headers['content-type']);
  if (!isAllowed(type)) {
    req.resume();
    return Promise.reject(httpError(415, 'unsupported_type', 'Этот тип файла не поддерживается. Можно: фото, видео (mp4, webm, mov), PDF, документы Word/Excel, текст, CSV'));
  }
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_FILE) {
    req.resume();
    return Promise.reject(httpError(413, 'payload_too_large', 'Файл больше 25 МБ'));
  }
  const id = crypto.randomBytes(24).toString('hex');
  const dir = store.filesDir;
  const tmp = path.join(dir, id + '.part');
  const final = path.join(dir, id);
  const name = cleanName(req.headers['x-file-name']);

  return new Promise((resolve, reject) => {
    let size = 0, failed = false;
    const out = fs.createWriteStream(tmp, { flags: 'wx' });
    const fail = (e) => {
      if (failed) return;
      failed = true;
      req.unpipe(out); req.resume();
      const cleanup = () => fs.rm(tmp, { force: true }, () => {});
      if (out.closed) cleanup(); else { out.once('close', cleanup); out.destroy(); }
      reject(e);
    };
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_FILE) fail(httpError(413, 'payload_too_large', 'Файл больше 25 МБ'));
    });
    req.on('error', fail);
    req.on('aborted', () => fail(httpError(400, 'aborted', 'Загрузка прервана')));
    out.on('error', fail);
    out.on('finish', () => {
      if (failed) return;
      if (size === 0) { fs.rm(tmp, { force: true }, () => {}); return reject(httpError(400, 'validation', 'Пустой файл')); }
      fs.rename(tmp, final, (err) => {
        if (err) return fail(err);
        const meta = { id, name, type, size, userId: me ? me.id : null, at: new Date().toISOString() };
        try { store.addFile(meta); } catch (e) { fs.rm(final, { force: true }, () => {}); return reject(e); }
        resolve({ status: 201, body: publicMeta(meta) });
      });
    });
    req.pipe(out);
  });
}

/** Отдать файл (с поддержкой Range). Ответ отправляется здесь; возвращает { handled: true }. */
function serve(req, res, store, id) {
  if (!ID_RE.test(id)) throw httpError(404, 'not_found', 'Файл не найден');
  const meta = store.getFile(id);
  const file = path.join(store.filesDir, id);
  let st;
  try { st = meta && fs.statSync(file); } catch (_) { st = null; }
  if (!meta || !st || !st.isFile()) throw httpError(404, 'not_found', 'Файл не найден');

  const size = st.size;
  const ascii = meta.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const disp = (isInline(meta.type) ? 'inline' : 'attachment') + `; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(meta.name)}`;
  const headers = {
    'Content-Type': meta.type.startsWith('text/') ? meta.type + '; charset=utf-8' : meta.type,
    'Content-Disposition': disp,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'",
    'Cache-Control': 'private, max-age=86400',
    'Accept-Ranges': 'bytes',
    'Last-Modified': st.mtime.toUTCString()
  };

  let start = 0, end = size - 1, status = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    let ok = !!m && (m[1] !== '' || m[2] !== '');
    if (ok) {
      if (m[1] === '') { const n = Number(m[2]); start = Math.max(0, size - n); end = size - 1; ok = n > 0; }
      else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
      ok = ok && start <= end && start < size;
    }
    if (!ok) {
      res.writeHead(416, Object.assign(headers, { 'Content-Range': `bytes */${size}`, 'Content-Length': 0 }));
      res.end();
      return { handled: true };
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') { res.end(); return { handled: true }; }
  fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  return { handled: true };
}

module.exports = { upload, serve, isAllowed, MAX_FILE, publicMeta };
