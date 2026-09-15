/*
 * 포장기준서(착인 계산 기준) 텍스트 파싱 로직 - JS 포팅
 * 원본: label-app/spec-ocr/parse_spec.py
 * 실제 사진 9장으로 검증한 규칙을 그대로 옮겼다:
 *   - "[기준, N개월/일/년(-M개월/일/년)]" 형태의 계산식 (대괄호/소괄호 모두, 중첩 대괄호 포함)
 *   - 계산 기준: 벌크제조일 / 포장일(별도 입력 필요)
 *   - 각인 자리: 한 곳에 같이 찍는 경우 / 전면·후면으로 나눠 찍는 경우(위치별 역할은 문서마다 다름)
 *   - 코스맥스 "OPERATION BATCH SHEET" 서식: 라벨 종류(일반용/중국용 등)별 표, "N년 후 그 달의
 *     1일(or 그 달)로 반올림" 계산 규칙 - 포장기준서와는 완전히 다른 서식이라 별도 파서로 처리
 */
(function (global) {
  "use strict";

  // "벌크제조일"류는 벌크라벨 OCR에서 바로 나오는 제조일자를 그대로 쓰면 되지만,
  // "포장일"/"생산일"류는 벌크의 제조일과는 다른 날짜(그날그날의 실제 포장/충전 작업일)라
  // 벌크라벨만으로는 알 수 없다 - 사용자가 직접 입력하는 별도의 "포장일자" 값이 필요하다.
  const BASIS_KEYWORD_MAP = [
    ["벌크제조일", "bulk_mfg_date"],
    ["벌크 제조일", "bulk_mfg_date"],
    ["완제품제조일", "bulk_mfg_date"],
    ["제조일", "bulk_mfg_date"],
    ["포장일", "packaging_date"],
    ["생산일", "packaging_date"],
    ["충전일", "packaging_date"],
  ];

  const EXCLUDED_CODE_TOKENS = new Set(["EXP", "LOT"]);

  // ---------- 번호 붙은 단계(1. 2. 3.)로 블록 나누기 ----------

  function splitSteps(text) {
    const lines = text.split(/\r\n|\r|\n/);
    const blocks = [];
    let current = null;
    let blankRun = 0;

    for (const line of lines) {
      const stripped = line.trim();
      const sectionStop = /^\s*[●•@]/.test(line) || stripped === "클레임이력" || stripped === "비고";
      if (sectionStop) {
        if (current) { blocks.push(current); current = null; }
        blankRun = 0;
        continue;
      }
      if (stripped === "") {
        blankRun++;
        if (blankRun >= 2 && current) { blocks.push(current); current = null; }
        continue;
      }
      blankRun = 0;

      const m = line.match(/^\s*(\d+)\s*[.)]\s*(.*)$/);
      if (m) {
        if (current) blocks.push(current);
        current = { no: parseInt(m[1], 10), lines: [line] };
      } else if (current !== null) {
        current.lines.push(line);
      }
    }
    if (current) blocks.push(current);
    return blocks;
  }

  // ---------- 중첩까지 고려한 [ ]/( ) 최상위 구간 추출 ----------

  function extractBracketSpans(text) {
    const spans = [];
    const stack = [];
    const pairs = { "[": "]", "(": ")" };
    const closers = { "]": "[", ")": "(" };
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (pairs[ch]) {
        stack.push([ch, i]);
      } else if (closers[ch]) {
        if (stack.length && stack[stack.length - 1][0] === closers[ch]) {
          const [, start] = stack.pop();
          if (stack.length === 0) spans.push(text.slice(start + 1, i));
        }
      }
    }
    return spans;
  }

  // ---------- 계산식 브라켓 파싱 ----------

  function parseBasis(blockText) {
    let bracket = null;
    for (const content of extractBracketSpans(blockText)) {
      if (/\d+\s*(개월|일|년)/.test(content)) { bracket = content; break; }
    }
    if (bracket === null) return null;

    let basisType = null, basisKeyword = null;
    const flat = bracket.replace(/ /g, "");
    for (const [kw, btype] of BASIS_KEYWORD_MAP) {
      if (flat.includes(kw.replace(/ /g, ""))) { basisKeyword = kw; basisType = btype; break; }
    }
    // 계산식 괄호 안에 기준 키워드가 없는 경우(예: "인쇄(36개월-1일)"처럼 계산 괄호와
    // 기준 설명이 따로 떨어져 있는 뉴스킨 포장일자기반 코드 서식) - 단계 전체 텍스트에서
    // 다시 한 번 찾아본다 ("※ 관리번호, 사용기한 - 포장일 기준" 같은 문구).
    if (basisType === null) {
      const flatWhole = blockText.replace(/ /g, "");
      for (const [kw, btype] of BASIS_KEYWORD_MAP) {
        if (flatWhole.includes(kw.replace(/ /g, ""))) { basisKeyword = kw; basisType = btype; break; }
      }
    }

    const ops = [];
    const opRe = /(-)?\s*(\d+)\s*(개월|일|년)/g;
    let m2;
    while ((m2 = opRe.exec(bracket))) {
      ops.push({ sign: m2[1] ? -1 : 1, amount: parseInt(m2[2], 10), unit: m2[3] });
    }

    return { raw: bracket, basis_keyword: basisKeyword, basis_type: basisType, ops };
  }

  function applyOps(baseDate, ops) {
    // baseDate: {y, mo, d} 형태의 순수 날짜값 (Date 객체의 타임존 이슈 회피)
    let y = baseDate.y, mo = baseDate.mo, d = baseDate.d;
    for (const op of ops) {
      const signed = op.amount * op.sign;
      if (op.unit === "개월") {
        const total = (mo - 1) + signed;
        y += Math.floor(total / 12);
        mo = ((total % 12) + 12) % 12 + 1;
        const maxDay = daysInMonth(y, mo);
        if (d > maxDay) d = maxDay;
      } else if (op.unit === "일") {
        const utc = Date.UTC(y, mo - 1, d) + signed * 86400000;
        const dt = new Date(utc);
        y = dt.getUTCFullYear(); mo = dt.getUTCMonth() + 1; d = dt.getUTCDate();
      } else if (op.unit === "년") {
        y += signed;
        const maxDay = daysInMonth(y, mo);
        if (d > maxDay) d = maxDay;
      }
    }
    return { y, mo, d };
  }

  function daysInMonth(y, mo) { return new Date(Date.UTC(y, mo, 0)).getUTCDate(); }

  function pad2(n) { return String(n).padStart(2, "0"); }

  function formatDateByPattern(dateObj, pattern) {
    if (!dateObj) return null;
    const y = dateObj.y, mo = pad2(dateObj.mo), d = pad2(dateObj.d);
    const yy = String(y).slice(-2);
    if (pattern === "YYYYMMDD") return `${y}${mo}${d}`;
    if (pattern === "YYYY-MM-DD") return `${y}-${mo}-${d}`;
    if (pattern === "YYYY-MM") return `${y}-${mo}`;
    if (pattern === "YYYYMM") return `${y}${mo}`;
    if (pattern === "YY/MM/DD") return `${yy}/${mo}/${d}`;
    return `${y}-${mo}-${d}`;
  }

  // ---------- 포장일자 기반 코드(뉴스킨 등): 연중 몇번째 날 계산 ----------

  function dayOfYear(y, mo, d) {
    const start = Date.UTC(y, 0, 1);
    const cur = Date.UTC(y, mo - 1, d);
    return Math.round((cur - start) / 86400000) + 1;
  }

  function pad3(n) { return String(n).padStart(3, "0"); }

  function buildDayOfYearCode(mfrCode, dateParts, batchNum) {
    if (!mfrCode || !dateParts || batchNum == null || batchNum === "") return null;
    const doy = dayOfYear(dateParts.y, dateParts.mo, dateParts.d);
    const yDigit = String(dateParts.y % 10);
    return `${mfrCode}${pad3(doy)}${yDigit}${batchNum}`;
  }

  // "CM : 제조사코드 알파벳2자리" + "포장일자 -> ... 몇번째 날" + "배치번호" 같은 문구가
  // 있으면 관리번호 자체를 라벨/수동입력이 아니라 포장일자로부터 계산해서 만드는
  // 방식(뉴스킨 코리아 서식)으로 판단한다.
  function parseDayOfYearCodeRule(blockText) {
    if (!/제조사코드/.test(blockText) || !/배치번호/.test(blockText)) return null;
    const m = blockText.match(/([A-Za-z]{2})\s*[:：]\s*제조사코드/);
    return { rule_type: "day_of_year_code", mfr_code: m ? m[1].toUpperCase() : null, raw: blockText };
  }

  function isoToParts(isoStr) {
    if (!isoStr) return null;
    const m = isoStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!m) return null;
    return { y: parseInt(m[1], 10), mo: parseInt(m[2], 10), d: parseInt(m[3], 10) };
  }

  function partsToIso(p) { return p ? `${p.y}-${pad2(p.mo)}-${pad2(p.d)}` : null; }

  // ---------- 각인 자리(면) 하나의 예시 문구 분석 ----------

  function analyzeFace(text) {
    if (text == null) return null;
    text = text.trim();

    let dateFmt = null;
    if (/YYYYMMDD/i.test(text)) dateFmt = "YYYYMMDD";
    else if (/Y{4}[-./]M{2}[-./]D{2}/i.test(text)) dateFmt = "YYYY-MM-DD";
    else if (/Y{4}[-./]M{2}(?![-./]?D)/i.test(text)) dateFmt = "YYYY-MM";
    else if (/Y{2}[-./]M{2}[-./]D{2}/i.test(text)) dateFmt = "YY/MM/DD";

    const stripped = text.replace(/Y{2,4}[-./]?M{2}(?:[-./]?D{2})?/gi, "");
    let exampleCode = null;
    const codeRe = /[A-Za-z0-9]{2,10}/g;
    let cm;
    while ((cm = codeRe.exec(stripped))) {
      if (EXCLUDED_CODE_TOKENS.has(cm[0].toUpperCase())) continue;
      exampleCode = cm[0];
      break;
    }

    return { raw: text, date_format: dateFmt, example_code: exampleCode };
  }

  function parseFormatTemplate(blockText) {
    const m = blockText.match(/예\s*\)\s*([\s\S]*?)(?=\n\s*\*|\n\s*\d+\s*[.)]|$)/);
    const exampleBlock = m ? m[1] : "";

    const fm = exampleBlock.match(/전면\s*[:：]\s*(.+)/);
    const bm = exampleBlock.match(/후면\s*[:：]\s*(.+)/);
    const isSplitFace = !!(fm || bm);

    let frontFace, backFace;
    if (isSplitFace) {
      frontFace = analyzeFace(fm ? fm[1] : null);
      backFace = analyzeFace(bm ? bm[1] : null);
    } else {
      const lines = exampleBlock.split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
      const combined = lines.join(" ");
      frontFace = combined.trim() ? analyzeFace(combined) : null;
      backFace = null;
    }

    let exampleCode = null, dateFmt = null;
    for (const face of [frontFace, backFace]) {
      if (face) {
        if (exampleCode === null && face.example_code) exampleCode = face.example_code;
        if (dateFmt === null && face.date_format) dateFmt = face.date_format;
      }
    }

    return {
      example_code: exampleCode,
      date_format: dateFmt,
      has_exp_marker: /EXP/i.test(blockText),
      is_split_face: isSplitFace,
      front_face: frontFace,
      back_face: backFace,
    };
  }

  // ---------- 포장기준서(번호 붙은 단계) 전체 파싱 ----------

  function parsePackagingSpec(text) {
    const blocks = splitSteps(text);
    const results = [];
    for (const b of blocks) {
      const blockText = b.lines.join("\n");
      const hasMgmtNo = blockText.includes("관리번호");
      const hasExpiryWord = blockText.includes("사용기한") || /EXP/i.test(blockText);

      const basis = parseBasis(blockText);
      const fmt = parseFormatTemplate(blockText);
      const codeRule = parseDayOfYearCodeRule(blockText);
      const hasCalc = !!(basis && basis.ops.length);
      const hasOwnExample = !!(fmt.example_code || fmt.front_face || fmt.back_face);
      const isCodingStep = hasCalc || hasOwnExample || !!codeRule;

      const entry = { step_no: b.no, title: b.lines[0].trim(), is_coding_step: isCodingStep };
      if (isCodingStep) {
        entry.basis = basis;
        entry.format = fmt;
        if (codeRule) entry.code_rule = codeRule;
      } else if (hasMgmtNo && hasExpiryWord) {
        entry.references_previous_step = true;
      }

      const extra = [];
      if (blockText.includes("봉합라벨")) {
        const mm = blockText.match(/봉합라벨\s*부착\s*\[([^\]]*)\]/);
        extra.push({ type: "봉합라벨 부착 위치", value: mm ? mm[1] : null });
      }
      if (blockText.includes("날개")) {
        const mm = blockText.match(/(날개[^\n]*)/);
        extra.push({ type: "포장 방향", value: mm ? mm[1].trim() : null });
      }
      if (blockText.includes("라벨") && !blockText.includes("봉합라벨")) {
        const mm = blockText.match(/([가-힣A-Za-z]+라벨\s*부착)/);
        if (mm) extra.push({ type: "라벨 부착", value: mm[1].trim() });
      }
      if (extra.length) entry.extra_instructions = extra;

      results.push(entry);
    }

    // 여러 단계(예: 튜브 각인 + 단상자 각인)가 같은 관리번호/사용기한 규칙을 반복 지시하면서
    // 계산 기준 설명(포장일/벌크제조일 키워드, 제조사코드 안내문)은 처음 나온 단계에만 적혀
    // 있는 경우가 흔하다 - 뒤 단계는 "같은 값을 여기에도 찍어라"는 뜻이므로, 계산식(ops)은
    // 있는데 기준 키워드/코드규칙을 못 찾은 단계는 바로 앞서 나온 코드 규칙/기준을 물려받는다.
    let lastBasisType = null, lastBasisKeyword = null, lastCodeRule = null;
    for (const entry of results) {
      if (!entry.is_coding_step) continue;
      if (entry.basis && entry.basis.basis_type) {
        lastBasisType = entry.basis.basis_type;
        lastBasisKeyword = entry.basis.basis_keyword;
      }
      if (entry.code_rule) lastCodeRule = entry.code_rule;

      const missingBasisType = entry.basis && entry.basis.ops && entry.basis.ops.length && !entry.basis.basis_type;
      if (missingBasisType && lastBasisType) {
        entry.basis.basis_type = lastBasisType;
        entry.basis.basis_keyword = lastBasisKeyword;
        entry.basis.inherited = true;
      }
      if (!entry.code_rule && lastCodeRule && entry.basis && entry.basis.ops && entry.basis.ops.length) {
        entry.code_rule = Object.assign({ inherited: true }, lastCodeRule);
      }
    }
    return results;
  }

  // ---------- 코스맥스 OPERATION BATCH SHEET 서식 ----------

  function parseRoundingBasis(text) {
    const m = text.match(/(?:제조일|벌크\s*제조일|벌크\s*사용\s*기한)[^\n]{0,20}?\+?\s*(\d+)\s*년[^\n]{0,40}?그\s*달/);
    if (!m) return null;
    const years = parseInt(m[1], 10);
    const roundTo = /그\s*달의?\s*1일/.test(text) ? "month_start" : "month_only";
    return { rule_type: "years_round_to_month", basis_keyword: "벌크제조일", basis_type: "bulk_mfg_date", years, round_to: roundTo, raw: m[0].trim() };
  }

  function applyRoundingBasis(baseDate, rounding) {
    return { y: baseDate.y + rounding.years, mo: baseDate.mo, d: 1 };
  }

  function formatRoundedExpiry(dt, roundTo) {
    if (roundTo === "month_only") return `${dt.y}${pad2(dt.mo)}`;
    return `${dt.y}${pad2(dt.mo)}${pad2(dt.d)}`;
  }

  function parseOperationBatchSheet(text) {
    const variantRe = /(일반용|중국용|[가-힣]{1,3}용)\s*\n?\s*(하면라벨|단상자|리필파우치)/g;
    const starts = [];
    let vm;
    while ((vm = variantRe.exec(text))) starts.push([vm.index, vm[1], vm[2]]);

    const results = [];
    for (let i = 0; i < starts.length; i++) {
      const [start, market, part] = starts[i];
      const end = i + 1 < starts.length ? starts[i + 1][0] : text.length;
      const block = text.slice(start, end);

      let codeM = block.match(/(?:제조\s*번호|MFG\s*코드|MFG\s*코딩)[^\n]*?\(예\)\s*([A-Za-z0-9]+)/);
      if (!codeM) codeM = block.match(/\(예\)\s*([A-Za-z0-9]{2,6})/);
      const mfgCodeExample = codeM ? codeM[1] : null;

      const rounding = parseRoundingBasis(block);

      let display = null;
      if (/YYYYMMDD/.test(block)) display = "YYYYMMDD";
      else if (/YYYYMM(?!DD)/.test(block)) display = "YYYYMM";

      results.push({
        market, part, mfg_code_example: mfgCodeExample,
        expiry_rule: rounding, expiry_display: display,
        has_expiry_on_label: !!rounding,
      });
    }
    return results;
  }

  function detectDocumentStyle(text) {
    if (text.includes("OPERATION BATCH SHEET") || text.includes("코딩 상세사항")) return "batch_sheet";
    return "packaging_spec";
  }

  function parseDocument(text) {
    const style = detectDocumentStyle(text);
    if (style === "batch_sheet") return { style, entries: parseOperationBatchSheet(text) };
    return { style, entries: parsePackagingSpec(text) };
  }

  // ---------- 결과 렌더링(화면 표시용) 헬퍼 ----------

  function renderStampText(face, values) {
    // face: {date_format, example_code, raw} | null
    // values: {code, mfgStr(기준일 ISO), expiryStr(사용기한 ISO)}
    if (!face) return null;
    const parts = [];
    if (face.example_code) parts.push(`관리번호 ${values.code || "(미입력)"}`);
    if (face.date_format) {
      const isMfgFace = /제조/.test(face.raw);
      const srcIso = isMfgFace ? values.mfgStr : values.expiryStr;
      const label = isMfgFace ? "기준일" : "사용기한";
      const val = srcIso ? formatDateByPattern(isoToParts(srcIso), face.date_format) : null;
      parts.push(`${label} ${val || "(미입력)"}`);
    }
    if (!parts.length) return face.raw || null;
    return parts.join(" + ");
  }

  global.SpecDecode = {
    BASIS_KEYWORD_MAP,
    splitSteps, extractBracketSpans, parseBasis, applyOps,
    analyzeFace, parseFormatTemplate, parsePackagingSpec,
    parseRoundingBasis, applyRoundingBasis, formatRoundedExpiry, parseOperationBatchSheet,
    detectDocumentStyle, parseDocument,
    formatDateByPattern, isoToParts, partsToIso, renderStampText,
    dayOfYear, pad3, buildDayOfYearCode, parseDayOfYearCodeRule,
  };
})(typeof window !== "undefined" ? window : globalThis);
