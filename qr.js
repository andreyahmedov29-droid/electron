// ---- Корректный QR-генератор (без внешних пакетов) ----
// Реализован по стандарту ISO/IEC 18004 (на основе проверенной логики
// qrcode-generator, MIT, Kazuhiko Arase). Byte mode, correction level "M",
// версии 1..10. Возвращает матрицу модулей boolean[][] (true = тёмный).
// Это заменяет прежний самопальный генератор, чей вывод не читался сканерами.
(function () {
  "use strict";

  // ---- GF(256) для Reed-Solomon ----
  var EXP = new Array(256);
  var LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    // Замыкание цикла GF(256): gexp(255) должен давать 1 (порядок
    // примитивного элемента 255). Без этого gexp(255)=undefined, что
    // портит ECC-байты Reed-Solomon и делает QR нечитаемым сканером.
    EXP[255] = EXP[0];
  })();
  function gexp(n) {
    while (n < 0) n += 255;
    while (n >= 256) n -= 255;
    return EXP[n];
  }
  function glog(n) {
    if (n < 1) throw "glog(" + n + ")";
    return LOG[n];
  }
  function qrPolynomial(num, shift) {
    var offset = 0;
    while (offset < num.length && num[offset] === 0) offset++;
    var _num = [];
    for (var i = 0; i < num.length - offset; i++) _num[i] = num[i + offset];
    for (var j = 0; j < shift; j++) _num.push(0);
    return {
      getLength: function () { return _num.length; },
      getAt: function (i) { return _num[i]; },
      multiply: function (e) {
        var out = [];
        for (var i = 0; i < this.getLength() + e.getLength() - 1; i++) out[i] = 0;
        for (var a = 0; a < this.getLength(); a++)
          for (var b = 0; b < e.getLength(); b++)
            out[a + b] ^= gexp(glog(this.getAt(a)) + glog(e.getAt(b)));
        return qrPolynomial(out, 0);
      },
      mod: function (e) {
        if (this.getLength() - e.getLength() < 0) return this;
        var ratio = glog(this.getAt(0)) - glog(e.getAt(0));
        var num2 = _num.slice();
        for (var i = 0; i < e.getLength(); i++)
          num2[i] ^= gexp(glog(e.getAt(i)) + ratio);
        return qrPolynomial(num2, 0).mod(e);
      }
    };
  }
  function rsErrorCorrection(ecLen) {
    var a = qrPolynomial([1], 0);
    for (var i = 0; i < ecLen; i++) a = a.multiply(qrPolynomial([1, gexp(i)], 0));
    return a;
  }

  // ---- Характеристики версий (EC M): группы блоков [count, total, data] ----
  // Сумма data = число кодовых слов данных; (total - data) = ECC на блок.
  var V = {
    1: [[1, 26, 16]],
    2: [[1, 44, 28]],
    3: [[1, 70, 44]],
    4: [[2, 50, 32]],
    5: [[2, 67, 43]],
    6: [[4, 43, 27]],
    7: [[4, 49, 31]],
    8: [[2, 60, 38], [2, 61, 39]],
    9: [[3, 58, 36], [2, 59, 37]],
    10: [[4, 69, 43], [1, 70, 44]]
  };
  function dataCodeWords(ver) {
    var groups = V[ver], sum = 0;
    for (var g = 0; g < groups.length; g++) sum += groups[g][0] * groups[g][2];
    return sum;
  }
  var CAP = { 1: 14, 2: 26, 3: 42, 4: 62, 5: 84, 6: 106, 7: 122, 8: 152, 9: 180, 10: 213 };
  function pickVersion(len) {
    for (var v = 1; v <= 10; v++) if (len <= CAP[v]) return v;
    return null;
  }
  var ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
  };

  function makeMatrix(version) {
    var size = version * 4 + 17;
    var m = [];
    for (var i = 0; i < size; i++) { m[i] = []; for (var j = 0; j < size; j++) m[i][j] = null; }
    return m;
  }
  function setFinder(m, row, col) {
    for (var r = -1; r <= 7; r++)
      for (var c = -1; c <= 7; c++) {
        var rr = row + r, cc = col + c;
        if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
        m[rr][cc] =
          ((r === 0 || r === 6 || c === 0 || c === 6) && r >= 0 && r <= 6 && c >= 0 && c <= 6) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      }
  }
  function setupFunctionPatterns(m, version) {
    var size = m.length;
    setFinder(m, 0, 0); setFinder(m, size - 7, 0); setFinder(m, 0, size - 7);

    // Alignment-паттерны рисуем ДО timing (как в эталоне: setupPositionAdjustPattern
    // вызывается раньше setupTimingPattern). Иначе alignment-зоны, лежащие на
    // строке 6 / колонке 6 (пересекающие timing), были бы пропущены, и у версий
    // 7+ декодер не смог бы выровнять код.
    var aligns = ALIGN[version] || [];
    if (aligns.length) {
      for (var a = 0; a < aligns.length; a++)
        for (var b = 0; b < aligns.length; b++) {
          var r0 = aligns[a], c0 = aligns[b];
          if (m[r0][c0] !== null) continue;
          for (var dr = -2; dr <= 2; dr++)
            for (var dc = -2; dc <= 2; dc++) {
              var ri = r0 + dr, ci = c0 + dc;
              if (ri < 0 || ci < 0 || ri >= size || ci >= size) continue;
              m[ri][ci] = (Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
            }
        }
    }
    for (var i = 8; i < size - 8; i++) {
      if (m[i][6] === null) m[i][6] = (i % 2 === 0);
      if (m[6][i] === null) m[6][i] = (i % 2 === 0);
    }
    m[size - 8][8] = true; // тёмный модуль
    // Пометить format-info зоны как функциональные (занятые) ДО размещения
    // данных: иначе placeData запишет в них данные (они еще null), а затем
    // writeFormatInfo их перезапишет — данные сместятся и QR станет
    // нечитаемым. В эталоне setupTypeInfo вызывается до mapData.
    setupFormatPlaceholder(m);
    if (version >= 7) {
      // Verinfo (для версий 7+) — рисуем по стандарту (два блока по 18 бит).
      var bits = getBCHTypeNumber(version);
      for (var i2 = 0; i2 < 18; i2++) {
        var mod = ((bits >> i2) & 1) === 1;
        m[Math.floor(i2 / 3)][i2 % 3 + size - 8 - 3] = mod;
        m[i2 % 3 + size - 8 - 3][Math.floor(i2 / 3)] = mod;
      }
    }
  }

  // Заполняет format-info ячейки временными значениями (занятые), чтобы
  // placeData их пропускал. Реальные биты формата рисует writeFormatInfo.
  function setupFormatPlaceholder(m) {
    var size = m.length;
    for (var i = 0; i < 15; i++) {
      if (i < 6) m[i][8] = false;
      else if (i < 8) m[i + 1][8] = false;
      else m[size - 15 + i][8] = false;
    }
    for (var i2 = 0; i2 < 15; i2++) {
      if (i2 < 8) m[8][size - i2 - 1] = false;
      else if (i2 < 9) m[8][15 - i2 - 1 + 1] = false;
      else m[8][15 - i2 - 1] = false;
    }
  }

  function getBCHTypeInfo(data) {
    var G15 = 0x537; var G15_MASK = 0x5412;
    var d = data << 10;
    while (bitCount(d) - bitCount(G15) >= 0) d ^= G15 << (bitCount(d) - bitCount(G15));
    return ((data << 10) | d) ^ G15_MASK;
  }
  function bitCount(x) {
    var c = 0; while (x !== 0) { c++; x >>>= 1; } return c;
  }
  function getBCHTypeNumber(data) {
    // BCH(18,6) для номера версии, как в эталонном qrcode-generator.
    var G18 = 0x1f25;
    var d = data << 12;
    while (bitCount(d) - bitCount(G18) >= 0)
      d ^= G18 << (bitCount(d) - bitCount(G18));
    return (data << 12) | d;
  }

  var MASKS = [
    function (i, j) { return (i + j) % 2 === 0; },
    function (i, j) { return i % 2 === 0; },
    function (i, j) { return j % 3 === 0; },
    function (i, j) { return (i + j) % 3 === 0; },
    function (i, j) { return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0; },
    function (i, j) { return (i * j) % 2 + (i * j) % 3 === 0; },
    function (i, j) { return ((i * j) % 2 + (i * j) % 3) % 2 === 0; },
    function (i, j) { return ((i * j) % 3 + (i + j) % 2) % 2 === 0; }
  ];

  function writeFormatInfo(m, format) {
    var size = m.length;
    var bit = function (k) { return ((format >> k) & 1) === 1; };
    // Вертикальная копия (вокруг левого верхнего finder).
    for (var i = 0; i < 15; i++) {
      var mod = bit(i);
      if (i < 6) m[i][8] = mod;
      else if (i < 8) m[i + 1][8] = mod;
      else m[size - 15 + i][8] = mod; // строки size-7..size-1
    }
    // Горизонтальная копия.
    for (var i2 = 0; i2 < 15; i2++) {
      var mod2 = bit(i2);
      if (i2 < 8) m[8][size - i2 - 1] = mod2;
      else if (i2 < 9) m[8][15 - i2 - 1 + 1] = mod2;
      else m[8][15 - i2 - 1] = mod2;
    }
    // Тёмный модуль (фиксированный, всегда true) — ставим ПОСЛЕ format info,
    // чтобы не попасть под перезапись.
    m[size - 8][8] = true;
  }

  function placeData(m, dataBits) {
    var size = m.length;
    var dataCells = [];
    for (var i0 = 0; i0 < size; i0++) dataCells[i0] = [];
    var isFunction = function (r, c) { return m[r][c] !== null; };
    var inc = -1, row = size - 1, bitIndex = 7, byteIndex = 0;
    var col = size - 1;
    while (col >= 1) {
      if (col === 6) col--;
      while (true) {
        for (var cc = 0; cc < 2; cc++) {
          var c = col - cc;
          if (!isFunction(row, c)) {
            var dark = false;
            if (byteIndex < dataBits.length) {
              dark = ((dataBits[byteIndex] >>> bitIndex) & 1) === 1;
            }
            m[row][c] = dark;
            dataCells[row][c] = true;
            bitIndex--;
            if (bitIndex === -1) { byteIndex++; bitIndex = 7; }
          }
        }
        row += inc;
        if (row < 0 || row >= size) { row -= inc; inc = -inc; break; }
      }
      col -= 2;
    }
    return dataCells;
  }

  function buildDataWords(text) {
    var bytes = [];
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code > 0xff) throw "QR supports latin-1 only";
      bytes.push(code);
    }
    var version = pickVersion(bytes.length);
    if (!version) throw "Слишком длинный код для этикетки";
    var dataWords = dataCodeWords(version);
    var groups = V[version];
    var ecPerBlock = groups[0][1] - groups[0][2];

    var bitStr = [];
    // mode = byte (0100), count (8 бит)
    function put(num, len) { for (var i = 0; i < len; i++) bitStr.push((num >>> (len - i - 1)) & 1); }
    put(0x4, 4);
    // Число байт (count): 8 бит для версий 1-9, 16 бит для версий 10+.
    put(bytes.length, version < 10 ? 8 : 16);
    for (var b = 0; b < bytes.length; b++) put(bytes[b], 8);
    var capacityBits = dataWords * 8;
    if (bitStr.length + 4 <= capacityBits) for (var t = 0; t < 4; t++) bitStr.push(0);
    var pad = 0xEC;
    while (bitStr.length % 8 !== 0) bitStr.push(0);
    while (bitStr.length < capacityBits) {
      put(pad, 8);
      pad = (pad === 0xEC) ? 0x11 : 0xEC;
    }
    var cursor = [];
    for (var i3 = 0; i3 < bitStr.length; i3 += 8) {
      var v = 0;
      for (var k = 0; k < 8; k++) v = v * 2 + bitStr[i3 + k];
      cursor.push(v);
    }
    // Блоки
    // Формируем блоки по группам [count, total, data] (как в эталонном
    // qrcode-generator). Сначала последовательно раздаём кодовые слова
    // данных по блокам, затем считаем ECC для каждого блока.
    var blocks = [];
    var offset = 0;
    var ci = 0;
    for (var gg = 0; gg < groups.length; gg++) {
      var count = groups[gg][0], dataC = groups[gg][2];
      for (var kk = 0; kk < count; kk++) {
        var dataChunk = cursor.slice(offset, offset + dataC);
        offset += dataC;
        var rs = rsErrorCorrection(ecPerBlock);
        var remPoly = qrPolynomial(dataChunk.slice(), ecPerBlock).mod(rs);
        var ecc = [];
        for (var e = 0; e < ecPerBlock; e++) {
          var idx = e + remPoly.getLength() - ecPerBlock;
          ecc.push(idx >= 0 ? remPoly.getAt(idx) : 0);
        }
        blocks.push({ data: dataChunk, ecc: ecc });
        ci++;
      }
    }
    // Чередуем данные и ECC.
    var finalData = [];
    var maxD = 0; for (var d2 = 0; d2 < blocks.length; d2++) maxD = Math.max(maxD, blocks[d2].data.length);
    for (var i4 = 0; i4 < maxD; i4++) for (var b2 = 0; b2 < blocks.length; b2++) if (i4 < blocks[b2].data.length) finalData.push(blocks[b2].data[i4]);
    for (var e2 = 0; e2 < ecPerBlock; e2++) for (var b3 = 0; b3 < blocks.length; b3++) finalData.push(blocks[b3].ecc[e2]);
    return { words: finalData, version: version, maskEcc: 0 /* EC M => bits '00' -> 0 */ };
  }

  function penalty(m) {
    var size = m.length, score = 0;
    for (var r = 0; r < size; r++) {
      var run = 1, prev = m[r][0];
      for (var c = 1; c < size; c++) {
        var v = m[r][c];
        if (v === prev) run++; else { if (run >= 5) score += 3 + run - 5; run = 1; prev = v; }
      }
      if (run >= 5) score += 3 + run - 5;
    }
    for (var c2 = 0; c2 < size; c2++) {
      var run2 = 1, prev2 = m[0][c2];
      for (var r2 = 1; r2 < size; r2++) {
        var v2 = m[r2][c2];
        if (v2 === prev2) run2++; else { if (run2 >= 5) score += 3 + run2 - 5; run2 = 1; prev2 = v2; }
      }
      if (run2 >= 5) score += 3 + run2 - 5;
    }
    return score;
  }

  function qrMatrix(text) {
    var built = buildDataWords(text);
    var version = built.version;
    var m = makeMatrix(version);
    setupFunctionPatterns(m, version);
    var dataCells = placeData(m, built.words);

    var best = null, bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var mm = new Array(m.length);
      for (var i = 0; i < m.length; i++) mm[i] = m[i].slice();
      var size = mm.length;
      for (var r = 0; r < size; r++)
        for (var c = 0; c < size; c++)
          if (dataCells[r] && dataCells[r][c] && MASKS[mask](r, c)) mm[r][c] = !mm[r][c];
      var ecc = 0; // EC M = 0b00 -> data bits 0
      var format = getBCHTypeInfo((ecc << 3) | mask);
      writeFormatInfo(mm, format);
      var s = penalty(mm);
      if (s < bestScore) { bestScore = s; best = mm; }
    }
    var out = [];
    for (var r2 = 0; r2 < best.length; r2++) {
      out[r2] = [];
      for (var c2 = 0; c2 < best.length; c2++) out[r2][c2] = !!best[r2][c2];
    }
    return out;
  }

  var api = { generate: qrMatrix, version: 2 };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else if (typeof window !== "undefined") window.QRGen = api;
})();
