// Screenplay / stage-play parser.
//
// Accepts three common shapes, mixed freely:
//   MAYA: (beat) Please tell me the 9:40 hasn't left.      <- "NAME: line"
//   MAYA                                                     <- screenplay cue
//   (breathless)
//   Please tell me the 9:40 hasn't left.
//   LADY BRACKNELL.                                          <- stage play (Gutenberg) cue
//   [Sitting down.] You can take a seat, Mr. Worthing.
// Anything else is a scene heading (INT./EXT.) or an action / stage direction.
// Optional header directives: TITLE:, AUTHOR:, CAST: NAME=voice, ..., FX: NAME=radio

const DIRECTIVE = /^(TITLE|AUTHOR|CAST|FX)\s*:\s*(.*)$/i;
const HEADING = /^(INT\.|EXT\.|INT\/EXT|I\/E\.?|INT |EXT )/;
const NAME = "[A-Z][A-Z0-9 .'’\\-]{0,30}?";
const INLINE = new RegExp(`^(${NAME})\\s*(?:\\((?:V\\.O\\.|O\\.S\\.|CONT'D)\\))?\\s*:\\s*(.+)$`);
const CUE = new RegExp(`^(${NAME})\\.?\\s*(?:\\((?:V\\.O\\.|O\\.S\\.|CONT'D)\\))?$`);

export function parseScript(src) {
  const meta = { title: 'Untitled scene', author: '', cast: {}, fx: {} };
  const items = [];
  const rows = src.replace(/\r/g, '').split('\n');
  let i = 0;

  // Header directives (only at the top).
  for (; i < rows.length; i++) {
    const row = rows[i].trim();
    if (!row) continue;
    const m = row.match(DIRECTIVE);
    if (!m) break;
    const key = m[1].toUpperCase();
    if (key === 'TITLE') meta.title = m[2].trim();
    else if (key === 'AUTHOR') meta.author = m[2].trim();
    else for (const pair of m[2].split(',')) {
      const [name, value] = pair.split('=').map((s) => s && s.trim());
      if (name && value) meta[key === 'CAST' ? 'cast' : 'fx'][name.toUpperCase()] = value.toLowerCase();
    }
  }

  // Group the rest into paragraphs (blank-line separated).
  const paras = [];
  let cur = [];
  for (; i < rows.length; i++) {
    const row = rows[i].trim();
    if (!row) { if (cur.length) paras.push(cur); cur = []; } else cur.push(row);
  }
  if (cur.length) paras.push(cur);

  for (const para of paras) {
    const first = para[0];
    let m;
    if (HEADING.test(first) && first === first.toUpperCase()) {
      items.push({ type: 'heading', text: para.join(' ') });
    } else if ((m = first.match(INLINE)) && isName(m[1])) {
      // NAME: text  (a paragraph may hold several NAME: lines without blank lines)
      let current = null;
      for (const row of para) {
        const mm = row.match(INLINE);
        if (mm && isName(mm[1])) {
          current = { character: canon(mm[1]), raw: mm[2] };
          items.push(current);
        } else if (current) current.raw += ' ' + row;
      }
    } else if (para.length > 1 && (m = first.match(CUE)) && isName(m[1])) {
      items.push({ character: canon(m[1]), raw: para.slice(1).join(' ') });
    } else {
      items.push({ type: 'action', text: para.join(' ') });
    }
  }

  // Normalize dialogue: split delivery notes from spoken text.
  let lineNo = 0;
  const out = items.map((it, idx) => {
    const base = { id: `i${idx}` };
    if (!it.character) return { ...base, ...it, speech: it.text.replace(/[[\]]/g, '') };
    const notes = [];
    const speech = it.raw
      .replace(/[([]([^)\]]*)[)\]]/g, (_, n) => { notes.push(n.trim().replace(/\.$/, '')); return ' '; })
      .replace(/\s*\.\s\.\s\.\s*/g, '... ') // Gutenberg ". . ." ellipses
      .replace(/\s+/g, ' ')
      .trim();
    return { ...base, type: 'line', character: it.character, note: notes.join('; '), speech, n: ++lineNo };
  }).filter((it) => it.type !== 'line' || it.speech);

  const characters = [...new Set(out.filter((x) => x.type === 'line').map((x) => x.character))];
  return { meta, items: out, characters };
}

function isName(s) {
  const t = s.trim().replace(/\.$/, '');
  // ALL CAPS, 1-4 words, not a heading keyword or a shouted sentence.
  return t === t.toUpperCase() && /[A-Z]/.test(t) && t.split(/\s+/).length <= 4 && !HEADING.test(t + ' ') &&
    !/^(THE END|FADE|CUT TO|CONTINUED)/.test(t);
}

function canon(s) {
  return s.trim().replace(/\.$/, '').replace(/\s+/g, ' ');
}
