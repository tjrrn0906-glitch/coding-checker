/*
 * 자사 로트체계 파싱/교차검증/사용기한 계산 로직 (JS 포팅)
 * 원본: label-app/webapp/lot_ocr.py 의 smart_extract / correct_suffix /
 *       letter_candidates / pick_best_date / parse_manuf / compute_expiry
 * 브라우저에서 서버 없이 그대로 동작하도록 순수 JS로 옮긴 버전.
 * 정규식/스코어링 로직은 Python 버전과 최대한 동일하게 유지했다.
 */
(function (global) {
  "use strict";

  const LOT_LETTERS = "ABCDEFGHJKLMNOPQRSTUVWXYZ".split(""); // I 제외, 25개
  const MONTH_CODE = {
    A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 9, K: 10, L: 11, M: 12,
    N: 1, P: 2, Q: 3, R: 4, S: 5, T: 6, U: 7, V: 8, W: 9, X: 10, Y: 11, Z: 12,
  };
  const YEAR_CYCLE = "LMNOPQRSTUVWXYZABCDEFGHJ".split(""); // 24개, 2010=L

  const MFG_DATE_HINT = "제조";
  const OTHER_DATE_HINTS = ["판정", "입고", "시험", "유통"];

  // 필러문자 0~2자, 연도 앞자리 1~2자리(1자리인 경우 '2'/'3' 복원 시도)
  const CODE_LOOSE_RE = /(\d{1,2})([A-Z0-9]{0,2}?)(\d{3})[/\\|IL]([A-Z0-9]{3})/g;

  const LETTER_CONFUSION = {
    "0": ["O"], "1": ["I", "L"], "2": ["Z"], "5": ["S"],
    "6": ["G"], "8": ["B"], "9": ["G"], "4": ["A"],
  };
  const LETTER_LETTER_CONFUSION = { I: ["J", "L"], J: ["I"], L: ["I"] };

  const PLAUSIBLE_YEAR_MIN = 2015;
  const PLAUSIBLE_YEAR_MAX = 2035; // inclusive, mirrors python range(2015,2036)

  function yearPlausible(y) {
    return y >= PLAUSIBLE_YEAR_MIN && y <= PLAUSIBLE_YEAR_MAX;
  }

  function letterCandidates(ch) {
    ch = ch.toUpperCase();
    const cands = [];
    if (/[A-Z]/.test(ch)) cands.push(ch);
    (LETTER_CONFUSION[ch] || []).forEach((c) => { if (!cands.includes(c)) cands.push(c); });
    (LETTER_LETTER_CONFUSION[ch] || []).forEach((c) => { if (!cands.includes(c)) cands.push(c); });
    return cands.length ? cands : [ch];
  }

  function correctSuffix(lotRaw, monRaw, yearRaw, seq, prefixYear, trustedMonth) {
    const expectedYearLetter = YEAR_CYCLE[((prefixYear - 2010) % 24 + 24) % 24];
    let best = null, bestScore = -1;
    for (const lotC of letterCandidates(lotRaw)) {
      const lotIdx = LOT_LETTERS.indexOf(lotC);
      const lotGroup = lotIdx >= 0 ? [0, 1, 2, 3, 4, 5].map((k) => lotIdx + 1 + 25 * k) : [];
      const lotOk = lotGroup.includes(seq);
      for (const monC of letterCandidates(monRaw)) {
        const monVal = MONTH_CODE[monC];
        const monOk = monVal !== undefined && (trustedMonth == null || monVal === trustedMonth);
        for (const yearC of letterCandidates(yearRaw)) {
          const yearOk = yearC === expectedYearLetter;
          let score = (lotOk ? 1 : 0) + (monOk ? 1 : 0) + (yearOk ? 1 : 0);
          score += 0.1 * (lotC === lotRaw ? 1 : 0) + 0.1 * (monC === monRaw ? 1 : 0) + 0.1 * (yearC === yearRaw ? 1 : 0);
          if (score > bestScore) {
            bestScore = score;
            best = {
              lot_l: lotC, mon_l: monC, year_l: yearC,
              lot_ok: lotOk, mon_ok: monOk, year_ok: yearOk,
              changed: lotC !== lotRaw || monC !== monRaw || yearC !== yearRaw,
            };
          }
        }
      }
    }
    return best;
  }

  // 4자리 연도 날짜
  const DATE_RE = /(20\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})/g;
  // 2자리 연도 날짜(제조일자 앞자리 "20"이 통째로 빠진 경우 대비)
  const SHORT_DATE_RE = /(?<!\d)(\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})(?!\d)/g;
  const TIME_NEARBY_RE = /\d{1,2}:\d{2}(:\d{2})?/;

  function hasTimeNearby(text, endPos, window = 20) {
    return TIME_NEARBY_RE.test(text.slice(endPos, endPos + window));
  }

  function classifyTier(text, startPos, endPos) {
    const context = text.slice(Math.max(0, startPos - 20), startPos);
    const hasTime = hasTimeNearby(text, endPos);
    if (context.includes(MFG_DATE_HINT)) return 0;
    if (hasTime || OTHER_DATE_HINTS.some((h) => context.includes(h))) return 2;
    return 1;
  }

  function pickBestDate(textBlob) {
    const candidates = []; // {tier, pos, y, mo, d}

    for (const m of textBlob.matchAll(DATE_RE)) {
      const tier = classifyTier(textBlob, m.index, m.index + m[0].length);
      candidates.push({ tier, pos: m.index, y: parseInt(m[1], 10), mo: parseInt(m[2], 10), d: parseInt(m[3], 10) });
    }

    for (const m of textBlob.matchAll(SHORT_DATE_RE)) {
      const yy = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
      const year = 2000 + yy;
      if (!yearPlausible(year)) continue;
      if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) continue;
      const tier = classifyTier(textBlob, m.index, m.index + m[0].length);
      candidates.push({ tier, pos: m.index, y: year, mo, d });
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => (a.tier - b.tier) || (a.pos - b.pos));
    return candidates[0];
  }

  function smartExtract(textBlob, trustedMonth) {
    const clean = textBlob.toUpperCase().replace(/ /g, "");
    let best = null, bestScore = -1;
    for (const m of clean.matchAll(CODE_LOOSE_RE)) {
      let [, yyRaw, filler, seqS, suffix] = m;
      let yy;
      if (yyRaw.length === 1) {
        const cands = ["2", "3"].map((p) => p + yyRaw).filter((c) => yearPlausible(2000 + parseInt(c, 10)));
        if (!cands.length) continue;
        yy = cands[0];
      } else {
        yy = yyRaw;
      }
      const year = 2000 + parseInt(yy, 10);
      if (!yearPlausible(year)) continue;
      const seq = parseInt(seqS, 10);
      const corrected = correctSuffix(suffix[0], suffix[1], suffix[2], seq, year, trustedMonth);
      const monWeight = trustedMonth != null ? 1.0 : 0.3;
      const score = (corrected.lot_ok ? 1 : 0) + monWeight * (corrected.mon_ok ? 1 : 0) + (corrected.year_ok ? 1 : 0);
      if (score > bestScore) {
        bestScore = score;
        const fillerDisp = filler ? filler[0] : "X";
        const code = `${yy}${fillerDisp}${seqS}/${corrected.lot_l}${corrected.mon_l}${corrected.year_l}`;
        best = { code, raw_suffix: suffix, corrected, score };
      }
    }
    const minAccept = trustedMonth != null ? 2.3 : 3.0;
    if (best && bestScore < minAccept) best.low_confidence = true;
    return best;
  }

  function parseManuf(code) {
    const m = code.match(/^(\d{2})(.)(\d{3})\/([A-Z])([A-Z])([A-Z])$/);
    if (!m) return null;
    const [, yy, ignored, seqS, lotL, monL, yearL] = m;
    const seq = parseInt(seqS, 10);
    const year = 2000 + parseInt(yy, 10);

    const lotIdx = LOT_LETTERS.indexOf(lotL);
    const lotGroupValues = lotIdx >= 0 ? [0, 1, 2, 3, 4, 5].map((k) => lotIdx + 1 + 25 * k) : [];
    const lotGroupOk = lotGroupValues.includes(seq);
    const monthFromCode = MONTH_CODE[monL] ?? null;
    const expectedYearLetter = YEAR_CYCLE[((year - 2010) % 24 + 24) % 24];
    const yearMatch = expectedYearLetter === yearL;

    return {
      year, ignored_char: ignored, seq, lot_l: lotL, mon_l: monL, year_l: yearL,
      lot_group_values: lotGroupValues, lot_group_ok: lotGroupOk,
      month_from_code: monthFromCode, expected_year_letter: expectedYearLetter, year_match: yearMatch,
    };
  }

  function computeExpiry(mfgDateStr, years, minusDay) {
    const [y, mo, d] = mfgDateStr.split("-").map((x) => parseInt(x, 10));
    let dt = new Date(Date.UTC(y + years, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1) {
      // 2/29 등 존재하지 않는 날짜로 넘어간 경우 - 하루 전으로 보정 (Python의 date() 예외 보정과 동일한 취지)
      dt = new Date(Date.UTC(y + years, mo - 1, d - 1));
    }
    if (minusDay) dt = new Date(dt.getTime() - 86400000);
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(dt.getUTCDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  }

  global.LotDecode = {
    LOT_LETTERS, MONTH_CODE, YEAR_CYCLE,
    letterCandidates, correctSuffix, pickBestDate, smartExtract,
    parseManuf, computeExpiry,
  };
})(typeof window !== "undefined" ? window : globalThis);
