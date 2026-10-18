// Script-aware alignment: normalize words, align what the actor said against the
// expected line, and decide (a) how far through the line they are and (b) what
// they dropped or swapped.

const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'hmm', 'hm', 'mm', 'mhm']);
// Spoken contractions that replace two scripted words ("gonna" for "going to").
const CONTRACTIONS = {
  gonna: 'going to', wanna: 'want to', gotta: 'got to', kinda: 'kind of', sorta: 'sort of', lemme: 'let me',
  gimme: 'give me', dunno: 'dont know', outta: 'out of', lotta: 'lot of', hafta: 'have to', oughta: 'ought to',
};
const EQUIV = { ok: 'okay', mr: 'mister', mrs: 'missus', dr: 'doctor', '&': 'and', till: 'til', til: 'til' };

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

export function numberWords(n) {
  if (n < 20) return [ONES[n]];
  if (n < 100) return [TENS[Math.floor(n / 10)], ...(n % 10 ? [ONES[n % 10]] : [])];
  if (n < 1000) return [ONES[Math.floor(n / 100)], 'hundred', ...(n % 100 ? numberWords(n % 100) : [])];
  if (n < 1e6) return [...numberWords(Math.floor(n / 1000)), 'thousand', ...(n % 1000 ? numberWords(n % 1000) : [])];
  return [...numberWords(Math.floor(n / 1e6)), 'million', ...(n % 1e6 ? numberWords(n % 1e6) : [])];
}

/** Normalize one display word into zero or more comparison tokens. */
export function normalizeWord(word) {
  let s = word.toLowerCase().replace(/[’‘`]/g, "'").replace(/[“”"«»]/g, '');
  // Times: 9:40 -> nine forty, 9:05 -> nine oh five, 9:00 -> nine
  s = s.replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h, m) => {
    const mm = Number(m);
    return [...numberWords(Number(h)), ...(mm === 0 ? [] : mm < 10 ? ['oh', ...numberWords(mm)] : numberWords(mm))].join(' ');
  });
  // Money: $14.50 -> fourteen fifty
  s = s.replace(/\$(\d[\d,]*)(?:\.(\d{2}))?/g, (_, d, c) => [...numberWords(Number(d.replace(/,/g, ''))), ...(c && Number(c) ? numberWords(Number(c)) : [])].join(' '));
  // Plain numbers (with thousands separators), ordinals 1st/2nd/3rd/4th -> cardinal words
  s = s.replace(/\b\d[\d,]*(?:st|nd|rd|th)?\b/g, (d) => numberWords(Number(d.replace(/[^\d]/g, ''))).join(' '));
  s = s.replace(/%/g, ' percent');
  return s
    .split(/[\s\-–—/]+/)
    .map((t) => t.replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '').replace(/'/g, ''))
    .filter(Boolean)
    .map((t) => EQUIV[t] || t);
}

const DECADES = { 20: 'twenties', 30: 'thirties', 40: 'forties', 50: 'fifties', 60: 'sixties', 70: 'seventies', 80: 'eighties', 90: 'nineties' };

/** Tokenize text keeping a map from each token to its display word. Fillers are optional. */
export function tokenize(text) {
  const display = text.split(/\s+/).filter(Boolean);
  const tokens = [];
  display.forEach((w, di) => {
    const word = w.replace(/^(\d0)s\b/, (m, d) => DECADES[d] || m); // 60s -> sixties
    normalizeWord(word).forEach((t) => { if (!FILLERS.has(t)) tokens.push({ t, src: di }); });
  });
  // "a hundred" == "one hundred"
  for (let k = 0; k + 1 < tokens.length; k++) {
    if (tokens[k].t === 'a' && /^(hundred|thousand|million)$/.test(tokens[k + 1].t)) tokens[k].t = 'one';
  }
  return { display, tokens };
}

export function spokenTokens(text) {
  return tokenize(text).tokens.map((x) => x.t).filter((t) => !FILLERS.has(t));
}

function lev(a, b) {
  if (a === b) return 0;
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

// Compound merges ("hand bag" ~ "handbag") must be (near) exact, or "here" + "i" ~ "here".
function sameMerge(a, b) {
  return a === b || (Math.min(a.length, b.length) >= 7 && lev(a, b) <= 1);
}

// Substitution cost: near-misses are cheaper, so swaps attach to the word they replace.
function subCost(a, b) {
  return 1 - 0.4 * (1 - lev(a, b) / Math.max(a.length, b.length));
}

export function same(a, b) {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  if (n >= 4 && lev(a, b) <= 1) return true;
  return n >= 7 && lev(a, b) <= 2;
}

/**
 * Align spoken tokens S against expected tokens E.
 * Returns { progress, ops, matched, lastMatch } for the best alignment of all of S to a
 * prefix of E (live mode), or to all of E when full=true (scoring).
 */
export function align(E, S, { full = false } = {}) {
  const n = E.length, m = S.length;
  const INF = 1e9;
  const dp = Array.from({ length: m + 1 }, () => new Float64Array(n + 1).fill(INF));
  const bp = Array.from({ length: m + 1 }, () => new Int8Array(n + 1));
  dp[0][0] = 0;
  for (let i = 0; i <= m; i++) {
    for (let j = 0; j <= n; j++) {
      if (i === 0 && j === 0) continue;
      let best = INF, op = 0;
      if (i > 0 && j > 0) { const c = dp[i - 1][j - 1] + (same(S[i - 1], E[j - 1]) ? 0 : subCost(S[i - 1], E[j - 1])); if (c < best) { best = c; op = 1; } }
      if (j > 0) { const c = dp[i][j - 1] + 1; if (c < best) { best = c; op = 2; } } // expected word dropped
      if (i > 0) { const c = dp[i - 1][j] + 1; if (c < best) { best = c; op = 3; } } // extra spoken word
      if (i > 1 && j > 0 && sameMerge(S[i - 2] + S[i - 1], E[j - 1]) && dp[i - 2][j - 1] < best) { best = dp[i - 2][j - 1]; op = 4; }
      if (i > 0 && j > 1 && sameMerge(S[i - 1], E[j - 2] + E[j - 1]) && dp[i - 1][j - 2] < best) { best = dp[i - 1][j - 2]; op = 5; }
      if (i > 0 && j > 1 && CONTRACTIONS[S[i - 1]] === `${E[j - 2]} ${E[j - 1]}` && dp[i - 1][j - 2] + 1 < best) { best = dp[i - 1][j - 2] + 1; op = 6; }
      dp[i][j] = best; bp[i][j] = op;
    }
  }
  let end = n;
  if (!full) {
    // Live: best prefix of E that explains everything said so far (ties -> further along).
    let best = INF;
    for (let j = 0; j <= n; j++) if (dp[m][j] <= best) { best = dp[m][j]; end = j; }
  }
  // Backtrace
  const ops = [];
  let i = m, j = end;
  while (i > 0 || j > 0) {
    const op = bp[i][j];
    if (op === 1) { ops.push({ type: same(S[i - 1], E[j - 1]) ? 'ok' : 'sub', e: j - 1, s: S[i - 1] }); i--; j--; }
    else if (op === 2) { ops.push({ type: 'del', e: j - 1 }); j--; }
    else if (op === 3) { ops.push({ type: 'ins', s: S[i - 1] }); i--; }
    else if (op === 4) { ops.push({ type: 'ok', e: j - 1, s: S[i - 2] + ' ' + S[i - 1] }); i -= 2; j--; }
    else if (op === 5) { ops.push({ type: 'ok', e: j - 1, s: S[i - 1] }, { type: 'ok', e: j - 2, s: S[i - 1] }); i--; j -= 2; }
    else if (op === 6) { ops.push({ type: 'sub', e: j - 2, e2: j - 1, s: S[i - 1] }); i--; j -= 2; }
    else break;
  }
  ops.reverse();
  const okOps = ops.filter((o) => o.type === 'ok');
  return {
    progress: end,
    ops,
    cost: dp[m][end],
    matched: okOps.length,
    lastMatch: okOps.length ? Math.max(...okOps.map((o) => o.e)) : -1,
    lastTouched: ops.reduce((m, o) => (o.type === 'ok' || o.type === 'sub' ? Math.max(m, o.e2 ?? o.e) : m), -1),
  };
}

/**
 * Detect a "Line!" call at the end of what was said. Returns the spoken tokens with the
 * call removed, and whether a call is present. A literal "line" the script expects next
 * (e.g. "the Brighton line") is not a call.
 */
export function extractCalls(E, S) {
  const out = [];
  let calls = 0;
  const scriptHasLine = E.includes('line');
  for (let k = 0; k < S.length; k++) {
    const t = S[k];
    const isCall = t === 'line' && (!scriptHasLine || (k === S.length - 1 && !expectsLineNext(E, out)));
    if (isCall) {
      calls++;
      if (S[k + 1] === 'please') k++;
      continue;
    }
    out.push(t);
  }
  return { tokens: out, called: calls > 0, calls };
}

function expectsLineNext(E, said) {
  const { progress } = align(E, said);
  return E[progress] === 'line';
}

/** Summarize a final alignment for the report card. */
export function scoreLine(expectedText, spokenText) {
  const { display, tokens } = tokenize(expectedText);
  const E = tokens.map((x) => x.t);
  const { tokens: S, called } = extractCalls(E, spokenTokens(spokenText));
  const res = align(E, S, { full: true });
  const status = new Array(E.length).fill('del');
  const swapped = [];
  for (const o of res.ops) {
    if (o.type === 'ok') status[o.e] = 'ok';
    else if (o.type === 'sub') {
      status[o.e] = 'sub';
      if (o.e2 !== undefined) status[o.e2] = 'sub';
      swapped.push([o.s, o.e2 !== undefined ? `${E[o.e]} ${E[o.e2]}` : E[o.e]]);
    }
  }
  const words = display.map((w, di) => {
    const idx = tokens.map((x, k) => (x.src === di ? k : -1)).filter((k) => k >= 0);
    const st = idx.every((k) => status[k] === 'ok') ? 'ok' : idx.some((k) => status[k] === 'sub') ? 'sub' : idx.some((k) => status[k] === 'ok') ? 'sub' : 'del';
    const said = st === 'sub' ? res.ops.filter((o) => o.type === 'sub' && idx.includes(o.e)).map((o) => o.s).join(' ') || null : null;
    return { w, st, said };
  });
  return {
    accuracy: E.length ? res.matched / E.length : 1,
    words,
    dropped: E.filter((_, k) => status[k] === 'del'),
    swapped,
    extra: res.ops.filter((o) => o.type === 'ins').map((o) => o.s),
    called,
  };
}
