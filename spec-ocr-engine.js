/*
 * 포장기준서 사진 전용 OCR 오케스트레이션.
 * 벌크라벨(ocr-engine.js)과 달리 작은 노란 라벨이 아니라 A4 한 페이지 전체를 찍은
 * 사진이라 크롭/이진화 대신 리사이즈+그레이스케일만 하고, 언어도 kor+eng을 함께 써서
 * 한글 설명문과 영문/숫자 코드(YYYYMMDD, EXP, ABC 등)를 같이 인식한다.
 * label-app/spec-ocr/run_ocr.py로 실측한 결과 psm 4(단일 컬럼 가정)가 이 문서
 * 레이아웃(표+번호 목록 혼재)에서 가장 안정적이었다 - psm 6은 종종 시간초과가 났다.
 */
(function (global) {
  "use strict";

  const VENDOR_BASE = (function () {
    const scripts = document.getElementsByTagName("script");
    for (const s of scripts) {
      if (s.src && s.src.includes("spec-ocr-engine.js")) {
        return s.src.replace(/spec-ocr-engine\.js.*$/, "vendor/");
      }
    }
    return "./vendor/";
  })();

  let workerPromise = null;
  function getSpecWorker() {
    if (!workerPromise) {
      workerPromise = Tesseract.createWorker("kor+eng", 1, {
        workerPath: VENDOR_BASE + "worker.min.js",
        corePath: VENDOR_BASE + "tesseract-core-simd.wasm.js",
        langPath: VENDOR_BASE + "tessdata",
        gzip: true,
        cacheMethod: "none",
      });
    }
    return workerPromise;
  }

  async function loadFileToCanvas(file, maxDim) {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    let { width: w, height: h } = bitmap;
    const scale = Math.min(1, maxDim / Math.max(w, h));
    w = Math.round(w * scale);
    h = Math.round(h * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
    bitmap.close && bitmap.close();
    return canvas;
  }

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

  async function analyzeSpecImage(file, opts) {
    opts = opts || {};
    const onProgress = opts.onProgress || function () {};

    onProgress("사진을 불러오는 중...");
    const canvas = await loadFileToCanvas(file, 2000);
    const gray = toGrayscale(canvas);

    onProgress("포장기준서 글자를 읽는 중 (한글+숫자, 시간이 좀 걸려요)...");
    const worker = await getSpecWorker();
    await worker.setParameters({ tessedit_pageseg_mode: "4" });
    const { data } = await worker.recognize(gray);
    const text = data.text || "";

    return { text, parsed: global.SpecDecode.parseDocument(text) };
  }

  global.SpecOcrEngine = { analyzeSpecImage, getSpecWorker };
})(typeof window !== "undefined" ? window : globalThis);
