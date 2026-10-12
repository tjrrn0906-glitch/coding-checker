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
    // OCR이 번호 자체("2.")를 다른 글자로 잘못 읽는 경우가 실제로 있다(예: "2."가
    // "lo"나 "locate"로 오인식됨) - 이러면 그 단계의 계산식 줄까지 통째로 "번호 없는
    // 줄"로 취급돼 아예 버려지던 문제가 있었다. 첫 번호 단계가 나오기 전의 내용도
    // preamble 블록(no: null)으로 따로 모아뒀다가, 끝에 계산식/코드규칙처럼 보이는
    // 내용이 있으면 결과에 포함시킨다(그 외엔 어차피 is_coding_step이 false로 걸러짐).
    let preamble = [];

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
      // OCR 잡음(예: "EXP[공란]YYYYMMDD까지"가 깨져서 "1)YYYYMMODJIAT"처럼 읽히는 경우)이
      // 숫자+구두점 패턴에 우연히 맞아떨어져 가짜 단계 경계로 오인되는 걸 막기 위해,
      // 번호 뒤 제목에 한글이 하나라도 있어야 "진짜" 새 단계 시작으로 인정한다.
      // 실측한 모든 포장기준서에서 실제 단계 제목은 예외 없이 번호 바로 뒤에 한글이 온다.
      const isGenuineStepStart = m && /[가-힣]/.test(m[2]);
      if (isGenuineStepStart) {
        if (current) blocks.push(current);
        current = { no: parseInt(m[1], 10), lines: [line] };
      } else if (current !== null) {
        current.lines.push(line);
      } else {
        preamble.push(line);
      }
    }
    if (current) blocks.push(current);
    if (preamble.length) blocks.unshift({ no: null, lines: preamble });
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
          // 예전엔 바깥쪽 괄호까지 완전히 다 닫혀서 스택이 비었을 때만(최상위 구간만)
          // 기록했는데, 실제 사진에서 OCR이 괄호 한쪽을 다른 글자로 잘못 읽어
          // (예: "[...좌측]"의 "]"가 ")"로 깨짐) 그 뒤에 나오는 진짜 계산식 대괄호까지
          // "안쪽에 중첩된 것"처럼 보여 통째로 버려지는 문제가 있었다. 짝이 맞게
          // 닫히기만 하면(중첩 여부와 무관하게) 바로 기록해서 이런 깨진 괄호 하나
          // 때문에 뒤쪽 내용 전체가 묻히지 않게 한다.
          spans.push(text.slice(start + 1, i));
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
    if (pattern === "DDMMYYYY") return `${d}${mo}${y}`;
    if (pattern === "DD-MM-YYYY") return `${d}-${mo}-${y}`;
    if (pattern === "MMDDYYYY") return `${mo}${d}${y}`;
    if (pattern === "MM-DD-YYYY") return `${mo}-${d}-${y}`;
    if (pattern === "MM-YYYY") return `${mo}-${y}`;
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

  // ---------- 고운세상코스메틱(Dr.G) "GEN/LOK" 코딩체계 ----------
  // 관리번호 = NC(고정) + 충전년코드(1자) + 충전월코드(1자) + 해당월 충전일순번(1~2자) + S(고정)
  // 충전년코드: I/O/Q/V 제외 22개 알파벳을 W=2022년부터 순환 배정 (W,X,Y,Z,A,B,...)
  const GEN_LOK_VALID_LETTERS = "ABCDEFGHJKLMNPRSTUWXYZ".split(""); // I,O,Q,V 제외, 22개
  const GEN_LOK_YEAR_START_LETTER = "W";
  const GEN_LOK_YEAR_START = 2022;
  // 충전월코드: 1~9월은 숫자 그대로, 10/11/12월은 전용 알파벳(자사 월코드 체계와는 다른 별도 매핑)
  const GEN_LOK_MONTH_LETTER = { 10: "O", 11: "N", 12: "D" };
  // 사용기한: 캘린더 월 계산이 아니라 "문서에 사용기한 직접계산금지"로 명시된 고정 일수표를
  // 충전일(또는 포장일)에 더하는 방식 - 표에 없는 개월수는 계산하지 않고 안내만 한다.
  const GEN_LOK_DAY_FIXED_TABLE = { 36: 1095, 30: 912, 24: 730 };

  function genLokYearLetter(year) {
    const n = GEN_LOK_VALID_LETTERS.length;
    const startIdx = GEN_LOK_VALID_LETTERS.indexOf(GEN_LOK_YEAR_START_LETTER);
    const offset = year - GEN_LOK_YEAR_START;
    const idx = ((startIdx + offset) % n + n) % n;
    return GEN_LOK_VALID_LETTERS[idx];
  }

  function genLokMonthCode(month) {
    if (GEN_LOK_MONTH_LETTER[month]) return GEN_LOK_MONTH_LETTER[month];
    if (month >= 1 && month <= 9) return String(month);
    return null;
  }

  function buildGenLokCode(baseParts, daySeq) {
    if (!baseParts || daySeq == null || String(daySeq).trim() === "") return null;
    const yearL = genLokYearLetter(baseParts.y);
    const monC = genLokMonthCode(baseParts.mo);
    if (!monC) return null;
    return `NC${yearL}${monC}${String(daySeq).trim().toUpperCase()}S`;
  }

  function genLokFixedDays(months) {
    return GEN_LOK_DAY_FIXED_TABLE[months] != null ? GEN_LOK_DAY_FIXED_TABLE[months] : null;
  }

  function applyFixedDays(baseParts, days) {
    const utc = Date.UTC(baseParts.y, baseParts.mo - 1, baseParts.d) + days * 86400000;
    const dt = new Date(utc);
    return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }

  // "충전년코드"+"충전월코드" 두 용어가 함께 있으면 Dr.G(GEN)/LOK 서식으로 판단한다
  // (오탐 가능성이 매우 낮은 고유 용어 조합).
  function parseGenLokCodeRule(blockText) {
    if (!/충전년코드/.test(blockText) || !/충전월코드/.test(blockText)) return null;
    const m = blockText.match(/(\d+)\s*개월/);
    const months = m ? parseInt(m[1], 10) : null;
    const fixedDays = months != null ? genLokFixedDays(months) : null;
    return { rule_type: "gen_lok_code", months, fixed_days: fixedDays, raw: blockText };
  }

  // ---------- COSMAX California Corp./NATURIUM 줄리안데이 로트체계 ----------
  // 관리번호(LOT#) = X(고정, 코스맥스) + 연도숫자(그 해 끝자리) + 줄리안데이 3자리(충진일 기준) +
  // 당일배치문자(A=그날 첫 벌크배치, B=두번째...) - 문서 원문에 "줄리안 달력 날짜"라는
  // 표현이 쓰여 있어 이를 고유 트리거로 사용한다.
  function buildCosmaxCaJulianCode(baseParts, batchLetter) {
    if (!baseParts || !batchLetter) return null;
    const doy = dayOfYear(baseParts.y, baseParts.mo, baseParts.d);
    return `X${baseParts.y % 10}${pad3(doy)}${String(batchLetter).trim().toUpperCase()}`;
  }

  function parseCosmaxCaJulianCodeRule(blockText) {
    if (!/줄리안/.test(blockText)) return null;
    return { rule_type: "cosmax_ca_julian_code", raw: blockText };
  }

  // ---------- LG생활건강(더페이스샵 등) 새 관리번호 체계 ----------
  // 관리번호 = 벌크제조년도 끝자리(1자리) + 벌크제조번호를 엑셀 컬럼식 알파벳으로 변환한 값
  // (1=A,2=B...9=I 포함,26=Z,27=AA... - 자사 로트체계의 I제외 규칙과는 무관한 별도 체계)
  // 고객사명(LG생활건강/더페이스샵)은 보통 문서 맨 위 제목에만 한 번 적혀 있고 각
  // 번호 단계 본문에는 반복되지 않는 경우가 많다. 그래서 고객사 언급 여부는
  // 문서 전체(docWideHasCustomer)에서 판단하고, 계산 키워드("끝자리", "알파벳")만
  // 해당 단계 블록 안에서 확인한다.
  function parseLgHcCodeRule(blockText, docWideHasCustomer) {
    const hasCustomer = docWideHasCustomer != null
      ? docWideHasCustomer
      : (/LG생활건강/.test(blockText) || /더페이스샵/.test(blockText));
    if (!hasCustomer) return null;
    if (!/끝자리/.test(blockText) || !/알파벳/.test(blockText)) return null;
    return { rule_type: "lg_hc_code", raw: blockText };
  }

  function buildLgHcCode(bulkPrefix) {
    if (!bulkPrefix) return null;
    const LD = global.LotDecode;
    const alpha = LD ? LD.numberToAlphaBase26(bulkPrefix.seq) : null;
    if (!alpha) return null;
    return `${bulkPrefix.year % 10}${alpha}`;
  }

  // ---------- 페리페라형 판매문서: 계산식 없이 지정관리번호 하나만 적혀있는 경우 ----------
  // 코스맥스 EADEM/페리페라처럼 "관리번호(또는 지정관리번호): ABC123" 식으로 고객사가
  // 이미 정해둔 코드 하나만 문서에 박혀있는 경우 - 계산식이 아니라 그 코드를 그대로
  // 관리번호로 쓰면 된다는 뜻이므로 전체 원문에서 찾아 제안한다.
  function findDesignatedMgmtCode(fullText) {
    if (!fullText) return null;
    const re = /지정\s*관리번호\s*[:：]\s*([A-Za-z0-9]{2,12})|관리번호\s*[:：]\s*([A-Za-z0-9]{2,12})/g;
    let m;
    while ((m = re.exec(fullText))) {
      const code = (m[1] || m[2] || "").toUpperCase();
      if (code && !EXCLUDED_CODE_TOKENS.has(code)) return code;
    }
    return null;
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

    // 연도가 맨 앞인 형식(YYYYMMDD 등)을 먼저 확인하고, 없으면 EU(DD먼저)/US OTC·비EU
    // 아마존(MM먼저) 등 연도-비선행 형식을 확인한다 (예: "EXPDDMMYYYY" 구분자 없음,
    // "EXP MM-DD-YYYY" 처럼 "까지" 문구 없이 쓰이는 형식). 코스알엑스처럼 "일" 없이
    // 월/연도만 찍는 "MM-YYYY" 전용 표기도 함께 지원한다.
    let dateFmt = null;
    if (/YYYYMMDD/i.test(text)) dateFmt = "YYYYMMDD";
    else if (/Y{4}[-./]M{2}[-./]D{2}/i.test(text)) dateFmt = "YYYY-MM-DD";
    else if (/Y{4}[-./]M{2}(?![-./]?D)/i.test(text)) dateFmt = "YYYY-MM";
    else if (/Y{2}[-./]M{2}[-./]D{2}/i.test(text)) dateFmt = "YY/MM/DD";
    else if (/DDMMYYYY/i.test(text)) dateFmt = "DDMMYYYY";
    else if (/D{2}[-./]M{2}[-./]Y{4}/i.test(text)) dateFmt = "DD-MM-YYYY";
    else if (/MMDDYYYY/i.test(text)) dateFmt = "MMDDYYYY";
    else if (/M{2}[-./]D{2}[-./]Y{4}/i.test(text)) dateFmt = "MM-DD-YYYY";
    else if (/M{2}[-./]Y{4}/i.test(text)) dateFmt = "MM-YYYY";

    const stripped = text.replace(
      /(?:Y{2,4}[-./]?M{2}(?:[-./]?D{2})?|D{2}[-./]?M{2}[-./]?Y{2,4}|M{2}[-./]?D{2}[-./]?Y{2,4}|M{2}[-./]?Y{2,4})/gi,
      ""
    );
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
    // LG생활건강/더페이스샵 같은 고객사명은 문서 맨 위 제목에만 한 번 적혀 있고
    // 번호 단계 본문엔 반복되지 않는 경우가 많아, 문서 전체 기준으로 한 번만 판단한다.
    const docWideHasLgHcCustomer = /LG생활건강/.test(text) || /더페이스샵/.test(text);
    for (const b of blocks) {
      const blockText = b.lines.join("\n");
      const hasMgmtNo = blockText.includes("관리번호");
      const hasExpiryWord = blockText.includes("사용기한") || /EXP/i.test(blockText);

      const basis = parseBasis(blockText);
      const fmt = parseFormatTemplate(blockText);
      const codeRule = parseDayOfYearCodeRule(blockText)
        || parseGenLokCodeRule(blockText)
        || parseCosmaxCaJulianCodeRule(blockText)
        || parseLgHcCodeRule(blockText, docWideHasLgHcCustomer);
      const hasCalc = !!(basis && basis.ops.length);
      const hasOwnExample = !!(fmt.example_code || fmt.front_face || fmt.back_face);
      const isCodingStep = hasCalc || hasOwnExample || !!codeRule;

      // 제목 결정: 번호가 있는 블록(b.no != null)은 splitSteps에서 "번호 뒤에 한글이
      // 있어야만" 새 단계로 인정하므로, 그 블록의 첫 줄(lines[0])은 항상 그 한글을
      // 포함한 진짜 제목 줄이다 - 그대로 쓰면 된다.
      // preamble 블록(b.no === null, 첫 번째 진짜 번호 단계가 나오기 전의 내용)은
      // 다르다 - 어느 줄이 "제목"에 해당하는지 알 수 있는 단서가 없고, OCR이 "-"
      // 같은 불릿 기호까지 지워버리는 경우가 있어서(예: "-용기 라벨 부착"이
      // "다선 [...]"처럼 기호 없이 깨짐) 내용으로 진짜 제목 줄을 구분해내는 건
      // 신뢰할 수 없다. 이런 경우 아무 줄이나 집어 제목인 것처럼 보여주면 오히려
      // 헷갈리므로, 번호를 읽지 못했다는 걸 솔직하게 알려주는 고정 문구를 쓴다
      // (실제 계산 내용은 아래 기준/각인 줄에 그대로 표시되니 정보 손실은 없다).
      const titleLine = b.no != null ? b.lines[0].trim() : '(번호를 읽지 못한 단계 - 아래 계산 내용 확인)';
      const entry = { step_no: b.no, title: titleLine, is_coding_step: isCodingStep };
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
    const designatedMgmtCode = findDesignatedMgmtCode(text);
    if (style === "batch_sheet") return { style, entries: parseOperationBatchSheet(text), designatedMgmtCode };
    return { style, entries: parsePackagingSpec(text), designatedMgmtCode };
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
    genLokYearLetter, genLokMonthCode, buildGenLokCode, genLokFixedDays, applyFixedDays,
    parseGenLokCodeRule, buildCosmaxCaJulianCode, parseCosmaxCaJulianCodeRule,
    parseLgHcCodeRule, buildLgHcCode, findDesignatedMgmtCode,
  };
})(typeof window !== "undefined" ? window : globalThis);
