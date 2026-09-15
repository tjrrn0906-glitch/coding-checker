/*
 * 브라우저(클라이언트) 전용 OCR 엔진 - 서버 없이 사진 -> 전처리 -> Tesseract.js OCR ->
 * lot-decode.js 규칙 기반 파싱까지 전부 이 파일 안에서 처리한다.
 *
 * label-app/webapp/lot_ocr.py(파이썬/OpenCV/Tesseract 버전)의 아이디어를 그대로
 * 따르되, 휴대폰에서 감당 가능한 시간 안에 끝나도록 전처리 가짓수와 재시도 횟수를
 * 줄였다 (OpenCV 대신 Canvas 2D API로 크롭/그레이스케일/대비보정/이진화를 직접 구현).
 */
(function (global) {
  "use strict";

  const VENDOR_BASE = (function () {
    // 이 스크립트 파일 자신의 위치를 기준으로 vendor/ 경로를 계산 (배포 경로가 달라도 안전)
    const scripts = document.getElementsByTagName("script");
    for (const s of scripts) {
      if (s.src && s.src.includes("ocr-engine.js")) {
        return s.src.replace(/ocr-engine\.js.*$/, "vendor/");
      }
    }
    return "./vendor/";
  })();

  let workerPromise = null;
  function getWorker() {
    if (!workerPromise) {
      workerPromise = Tesseract.createWorker("eng", 1, {
        workerPath: VENDOR_BASE + "worker.min.js",
        corePath: VENDOR_BASE + "tesseract-core-simd.wasm.js",
        langPath: VENDOR_BASE + "tessdata",
        gzip: true,
        cacheMethod: "none", // 매번 langPath에서 로드(용량 작아 문제 없음) - 브라우저 캐시(HTTP cache)가 재요청을 막아줌
      });
    }
    return workerPromise;
  }

  async function recognizeText(worker, canvas, psm) {
    try {
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      const { data } = await worker.recognize(canvas);
      return data.text || "";
    } catch (e) {
      return "";
    }
  }

  // ---------- 이미지 로딩/리사이즈 ----------

  async function loadFileToCanvas(file, maxDim) {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    let { width: w, height: h } = bitmap;
    const scale = Math.min(1, maxDim / Math.max(w, h));
    w = Math.round(w * scale);
    h = Math.round(h * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close && bitmap.close();
    return canvas;
  }

  // ---------- 노란 라벨 영역 크롭 (HSV 마스크) ----------

  function cropToYellowLabel(canvas) {
    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext("2d");
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    let minX = w, minY = h, maxX = -1, maxY = -1, count = 0;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const v = max;
        const s = max === 0 ? 0 : (max - min) / max;
        let hue = 0;
        if (max !== min) {
          if (max === r) hue = 60 * (((g - b) / (max - min)) % 6);
          else if (max === g) hue = 60 * ((b - r) / (max - min) + 2);
          else hue = 60 * ((r - g) / (max - min) + 4);
          if (hue < 0) hue += 360;
        }
        // OpenCV 기준 H 15~40(0-179 스케일) => 30~80도, S 60~255(0-255) => 0.235~1.0, V 80~255 => 0.314~1.0
        if (hue >= 30 && hue <= 80 && s >= 0.235 && v >= 0.314) {
          count++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (count < 1000) return canvas; // 노란 라벨을 못 찾으면 원본 유지

    const pad = 20;
    const x0 = Math.max(0, minX - pad), y0 = Math.max(0, minY - pad);
    const x1 = Math.min(w, maxX + pad), y1 = Math.min(h, maxY + pad);
    const cw = x1 - x0, ch = y1 - y0;
    if (cw < 20 || ch < 20) return canvas;

    const out = document.createElement("canvas");
    out.width = cw;
    out.height = ch;
    out.getContext("2d").drawImage(canvas, x0, y0, cw, ch, 0, 0, cw, ch);
    return out;
  }

  // ---------- 그레이스케일 ----------

  function toGrayscale(canvas) {
    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext("2d");
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      d[i] = d[i + 1] = d[i + 2] = y;
    }
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    out.getContext("2d").putImageData(img, 0, 0);
    return out;
  }

  // ---------- 타일 기반 로컬 대비 보정 (CLAHE 근사) ----------

  function localContrastStretch(grayCanvas, tiles = 8) {
    const w = grayCanvas.width, h = grayCanvas.height;
    const ctx = grayCanvas.getContext("2d");
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;

    const tileW = Math.max(1, Math.ceil(w / tiles));
    const tileH = Math.max(1, Math.ceil(h / tiles));
    const nx = Math.ceil(w / tileW), ny = Math.ceil(h / tileH);
    const tileMin = new Float32Array(nx * ny).fill(255);
    const tileMax = new Float32Array(nx * ny).fill(0);

    for (let y = 0; y < h; y++) {
      const ty = Math.min(ny - 1, Math.floor(y / tileH));
      for (let x = 0; x < w; x++) {
        const tx = Math.min(nx - 1, Math.floor(x / tileW));
        const v = d[(y * w + x) * 4];
        const idx = ty * nx + tx;
        if (v < tileMin[idx]) tileMin[idx] = v;
        if (v > tileMax[idx]) tileMax[idx] = v;
      }
    }

    // 평평한(대비가 거의 없는) 타일은 노이즈 증폭을 막기 위해 스트레치를 건너뛴다
    const MIN_RANGE = 25;

    function tileBounds(tx, ty) {
      const idx = ty * nx + tx;
      const lo = tileMin[idx], hi = tileMax[idx];
      return hi - lo < MIN_RANGE ? [0, 255] : [lo, hi];
    }

    for (let y = 0; y < h; y++) {
      const fy = y / tileH - 0.5;
      let ty0 = Math.floor(fy), ty1 = ty0 + 1;
      const wy = fy - ty0;
      ty0 = Math.max(0, Math.min(ny - 1, ty0));
      ty1 = Math.max(0, Math.min(ny - 1, ty1));
      for (let x = 0; x < w; x++) {
        const fx = x / tileW - 0.5;
        let tx0 = Math.floor(fx), tx1 = tx0 + 1;
        const wx = fx - tx0;
        tx0 = Math.max(0, Math.min(nx - 1, tx0));
        tx1 = Math.max(0, Math.min(nx - 1, tx1));

        const [lo00, hi00] = tileBounds(tx0, ty0);
        const [lo10, hi10] = tileBounds(tx1, ty0);
        const [lo01, hi01] = tileBounds(tx0, ty1);
        const [lo11, hi11] = tileBounds(tx1, ty1);
        const lo = (lo00 * (1 - wx) + lo10 * wx) * (1 - wy) + (lo01 * (1 - wx) + lo11 * wx) * wy;
        const hi = (hi00 * (1 - wx) + hi10 * wx) * (1 - wy) + (hi01 * (1 - wx) + hi11 * wx) * wy;

        const i = (y * w + x) * 4;
        const v = d[i];
        const range = Math.max(1, hi - lo);
        let nv = ((v - lo) / range) * 255;
        nv = Math.max(0, Math.min(255, nv));
        d[i] = d[i + 1] = d[i + 2] = nv;
      }
    }

    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    out.getContext("2d").putImageData(img, 0, 0);
    return out;
  }

  // ---------- Otsu 이진화 ----------

  function otsuThreshold(grayCanvas) {
    const w = grayCanvas.width, h = grayCanvas.height;
    const ctx = grayCanvas.getContext("2d");
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;

    const hist = new Array(256).fill(0);
    for (let i = 0; i < d.length; i += 4) hist[d[i] | 0]++;
    const total = w * h;

    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, maxVar = -1, threshold = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const varBetween = wB * wF * (mB - mF) * (mB - mF);
      if (varBetween > maxVar) {
        maxVar = varBetween;
        threshold = t;
      }
    }

    for (let i = 0; i < d.length; i += 4) {
      const v = d[i] >= threshold ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    out.getContext("2d").putImageData(img, 0, 0);
    return out;
  }

  // ---------- 회전 ----------

  function rotateCanvas(canvas, deg) {
    if (deg % 360 === 0) return canvas;
    const rad = (deg * Math.PI) / 180;
    const w = canvas.width, h = canvas.height;
    const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
    const nw = Math.round(w * cos + h * sin);
    const nh = Math.round(w * sin + h * cos);
    const out = document.createElement("canvas");
    out.width = nw;
    out.height = nh;
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, nw, nh);
    ctx.translate(nw / 2, nh / 2);
    ctx.rotate(rad);
    ctx.drawImage(canvas, -w / 2, -h / 2);
    return out;
  }

  // ---------- 가로 띠 분할 OCR (표+배경이 겹쳐 전체 인식이 깨질 때 보조 수단) ----------

  async function stripOcrText(worker, grayCanvas, bandHFrac, overlapFrac) {
    const w = grayCanvas.width, h = grayCanvas.height;
    const bandH = Math.max(Math.round(h * bandHFrac), 40);
    const step = Math.max(Math.round(bandH * (1 - overlapFrac)), 1);
    let blob = "";
    let y = 0;
    while (y < h) {
      const y2 = Math.min(y + bandH, h);
      if (y2 - y >= 15) {
        const band = document.createElement("canvas");
        band.width = w;
        band.height = y2 - y;
        band.getContext("2d").drawImage(grayCanvas, 0, y, w, y2 - y, 0, 0, w, y2 - y);
        blob += "\n" + (await recognizeText(worker, band, "6"));
      }
      if (y2 >= h) break;
      y += step;
    }
    return blob;
  }

  // ---------- 메인 오케스트레이션 ----------

  async function analyzeLabelImage(file, opts) {
    opts = opts || {};
    const years = opts.years != null ? opts.years : 3;
    const minusDay = !!opts.minusDay;
    const onProgress = opts.onProgress || function () {};

    const D = global.LotDecode;
    const worker = await getWorker();

    onProgress("사진을 불러오는 중...");
    let canvas = await loadFileToCanvas(file, 1400);
    canvas = cropToYellowLabel(canvas);

    const gray = toGrayscale(canvas);
    const stretched = localContrastStretch(gray, 8);
    const otsu = otsuThreshold(stretched);

    onProgress("글자를 읽는 중 (1/3)...");
    let blob = "";
    blob += "\n" + (await recognizeText(worker, gray, "3"));
    onProgress("글자를 읽는 중 (2/3)...");
    blob += "\n" + (await recognizeText(worker, stretched, "3"));
    onProgress("글자를 읽는 중 (3/3)...");
    blob += "\n" + (await recognizeText(worker, otsu, "3"));

    function extractFrom(textBlob) {
      const d = D.pickBestDate(textBlob);
      // tier 2 = 판정/입고/시험/유통 등 다른 날짜이거나 뒤에 시:분(:초) 타임스탬프가 붙어있어
      // 제조일자가 아닐 가능성이 높은 후보. 이게 유일한 후보라면(=제조일자 자체를 못 읽은 것)
      // 자신있게 틀린 날짜를 채워넣느니 "못 찾음"으로 정직하게 보고한다 (사용자가 직접 확인).
      const reliable = d && d.tier <= 1;
      const foundDate = reliable ? `${d.y}-${String(d.mo).padStart(2, "0")}-${String(d.d).padStart(2, "0")}` : null;
      const trustedMonth = reliable ? d.mo : null;
      const lowConfidenceDate = !reliable && d ? `${d.y}-${String(d.mo).padStart(2, "0")}-${String(d.d).padStart(2, "0")}` : null;
      const best = D.smartExtract(textBlob, trustedMonth);
      return { foundDate, trustedMonth, best, lowConfidenceDate };
    }

    let { foundDate, trustedMonth, best, lowConfidenceDate } = extractFrom(blob);
    let targetScore = trustedMonth != null ? 3.0 : 2.0;

    function goodEnough(b) {
      return b && !b.low_confidence && b.score >= targetScore;
    }

    if (!goodEnough(best) || !foundDate) {
      onProgress("잘 안 보여서 다시 시도하는 중 (구역 분할)...");
      blob += await stripOcrText(worker, gray, 0.14, 0.5);
      const r2 = extractFrom(blob);
      if (r2.foundDate && !foundDate) { foundDate = r2.foundDate; trustedMonth = r2.trustedMonth; }
      if (r2.lowConfidenceDate && !lowConfidenceDate) lowConfidenceDate = r2.lowConfidenceDate;
      targetScore = trustedMonth != null ? 3.0 : 2.0;
      if (r2.best && (!best || r2.best.score > best.score)) best = r2.best;
    }

    if (!goodEnough(best) || !foundDate) {
      for (const deg of [90, 180, 270]) {
        onProgress(`회전해서 다시 시도하는 중 (${deg}°)...`);
        const rotated = rotateCanvas(canvas, deg);
        const rGray = toGrayscale(rotated);
        blob += "\n" + (await recognizeText(worker, rGray, "3"));
        const r3 = extractFrom(blob);
        if (r3.foundDate && !foundDate) { foundDate = r3.foundDate; trustedMonth = r3.trustedMonth; }
        if (r3.lowConfidenceDate && !lowConfidenceDate) lowConfidenceDate = r3.lowConfidenceDate;
        targetScore = trustedMonth != null ? 3.0 : 2.0;
        if (r3.best && (!best || r3.best.score > best.score)) best = r3.best;
        if (goodEnough(best) && foundDate) break;
      }
    }

    if (global.OCR_DEBUG) global.__lastBlob = blob;

    const foundMfg = best && !best.low_confidence ? best.code : null;
    const result = { found_mfg: foundMfg, found_date: foundDate };
    if (best) {
      result.suffix_auto_corrected = best.corrected.changed;
      result.raw_suffix_read = best.raw_suffix;
      result.match_score = best.score;
      if (best.low_confidence) {
        result.low_confidence_guess = best.code;
        result.note = "검증 기준을 못 채워 자동 확정하지 않음 - 사진을 보면서 직접 확인 필요";
      }
    }
    if (!foundDate && lowConfidenceDate) {
      // 유일한 후보가 판정일자 스티커 등 다른 날짜일 가능성이 높은 경우 - 틀린 날짜를
      // 자신있게 채우는 대신 "확인 필요" 후보로만 알려준다.
      result.low_confidence_date_guess = lowConfidenceDate;
      result.date_note = "제조일자를 확신할 수 없어 자동 확정하지 않음(다른 날짜 스티커일 수 있음) - 사진을 보면서 직접 확인 필요";
    }

    if (foundMfg) {
      const parsed = D.parseManuf(foundMfg);
      result.parsed = parsed;
      if (parsed && foundDate) {
        result.expiry = D.computeExpiry(foundDate, years, minusDay);
        const dateMonth = parseInt(foundDate.split("-")[1], 10);
        result.month_cross_check = parsed.month_from_code === dateMonth;
      }
    } else if (foundDate) {
      result.expiry = D.computeExpiry(foundDate, years, minusDay);
    }

    return result;
  }

  global.OcrEngine = { analyzeLabelImage, getWorker };
})(typeof window !== "undefined" ? window : globalThis);
