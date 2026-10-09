'use strict';

const net = require('node:net');
const tls = require('node:tls');

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

// SMTP-клиент (AUTH LOGIN, STARTTLS/IMPLICIT TLS) на встроенных модулях.
function sendMail(cfg, { from, to, subject, text, html }, onStep) {
  const port = cfg.port || 587;
  const host = cfg.host;
  const user = cfg.user || '';
  const pass = cfg.pass || '';
  const helo = cfg.helo || 'localhost';
  const TIMEOUT = 15000;
  const step = onStep ? (s) => { try { onStep(s); } catch (_e) { /* ignore */ } } : null;

  return new Promise((resolve, reject) => {
    let socket;
    let buffer = '';
    let pending = null; // {code, res, rej, label}

    function attach(s) {
      socket = s;
      socket.setTimeout(TIMEOUT, () => {
        handleFail(new Error('SMTP: превышен таймаут ожидания ответа'));
      });
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (!buffer.includes('\r\n')) return;
        const lines = buffer.split('\r\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line) continue;
          const code = parseInt(line.slice(0, 3), 10);
          if (line[3] === '-') continue; // многострочный ответ
          if (pending) {
            const p = pending;
            pending = null;
            code === p.code ? p.res() : p.rej(new Error('SMTP [' + (p.label || '?') + '] код ' + code + ': ' + line));
          }
        }
      });
      socket.on('timeout', () => { /* таймаут обрабатывается через settimeout handler */ });
      socket.on('error', (e) => handleFail(e));
      socket.on('close', () => { if (pending) pending.rej(new Error('SMTP-соединение закрыто')); });
    }

    function handleFail(e) {
      try { socket.end(); } catch (_e) { /* ignore */ }
      reject(e);
    }

    function cmd(line, code, label) {
      return new Promise((res, rej) => {
        if (!socket || socket.destroyed) return rej(new Error('Соединение закрыто'));
        pending = { code, res, rej, label: label || (line ? String(line).split(' ')[0] : '?') };
        socket.write(line + '\r\n');
      });
    }

    function waitFor(code) {
      return new Promise((res, rej) => { pending = { code, res, rej }; });
    }

    async function run() {
      if (cfg.secure === true) {
        // Порт 465 = SMTPS: сразу TLS-подключение, затем баннер 220.
        if (step) step('подключение (TLS)');
        const t = tls.connect({ host, port, rejectUnauthorized: false });
        socket = t;
        t.setTimeout(TIMEOUT, () => handleFail(new Error('SMTP: не удалось подключиться (таймаут)')));
        await new Promise((res, rej) => { t.once('secureConnect', res); t.once('error', rej); });
        attach(t);
        await waitFor(220);
        if (step) step('EHLO');
        await cmd('EHLO ' + helo, 250);
      } else {
        if (step) step('подключение');
        socket = net.connect(port, host);
        socket.setTimeout(TIMEOUT, () => {
          handleFail(new Error('SMTP: не удалось подключиться (таймаут)'));
        });
        attach(socket);
        await waitFor(220); // баннер приходит сразу после подключения
        if (step) step('EHLO');
        await cmd('EHLO ' + helo, 250);
        // STARTTLS для порта 587
        if (step) step('STARTTLS');
        await cmd('STARTTLS', 220);
        socket.removeAllListeners('data');
        const t2 = tls.connect({ socket, rejectUnauthorized: false });
        socket = t2;
        await new Promise((res, rej) => { t2.once('secureConnect', res); t2.once('error', rej); });
        attach(t2);
        if (step) step('EHLO (TLS)');
        await cmd('EHLO ' + helo, 250);
      }
      if (user && pass) {
        if (step) step('AUTH LOGIN');
        await cmd('AUTH LOGIN', 334);
        if (step) step('логин отправлен');
        await cmd(b64(user), 334);
        if (step) step('пароль передан');
        await cmd(b64(pass), 235);
      }
      if (step) step('MAIL FROM');
      await cmd('MAIL FROM:<' + from + '>', 250);
      if (step) step('RCPT TO');
      await cmd('RCPT TO:<' + to + '>', 250);
      if (step) step('DATA');
      await cmd('DATA', 354);
      let mimeBody;
      if (html) {
        const boundary = '----=_Part_' + Date.now() + '_' + Math.random().toString(36).slice(2);
        const part = (ct) => '--' + boundary + '\r\n' +
          'Content-Type: ' + ct + '; charset=utf-8\r\n' +
          'Content-Transfer-Encoding: base64\r\n\r\n';
        mimeBody = 'Content-Type: multipart/alternative; boundary="' + boundary + '"\r\n' +
          'MIME-Version: 1.0\r\n\r\n' +
          part('text/plain') + wrapB64(text) + '\r\n\r\n' +
          part('text/html') + wrapB64(html) + '\r\n' +
          '--' + boundary + '--';
      } else {
        mimeBody = 'Content-Type: text/plain; charset=utf-8\r\n' +
          'MIME-Version: 1.0\r\n' +
          'Content-Transfer-Encoding: base64\r\n\r\n' +
          wrapB64(text);
      }
      const body = 'From: <' + from + '>\r\n' +
        'To: <' + to + '>\r\n' +
        'Subject: =?UTF-8?B?' + b64(subject) + '?=\r\n' +
        mimeBody;
      socket.write(body + '\r\n.\r\n');
      if (step) step('тело письма передано — ждём подтверждение');
      await cmd('', 250); // письмо принято сервером — отправка успешна
      if (step) step('письмо принято сервером');
      resolve(); // считаем отправку успешной; QUIT дальше не критичен
      try { socket.write('QUIT\r\n'); } catch (_e) { /* ignore */ }
      socket.end();
    }

    // первый ответ — баннер. Перед ним команду не пишем.
    run().catch(handleFail);
  });
}

function wrapB64(text) {
  return Buffer.from(String(text), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n').replace(/\r\n$/, '');
}

module.exports = { sendMail };
