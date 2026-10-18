// Director's notes via AssemblyAI LLM Gateway (OpenAI-compatible chat completions).
//
// The facts come from the alignment, not the model: we draft the notes from the
// scored run, then ask a fast rewrite model to phrase them like a director would.
// If the rewrite invents quotes, we fall back to the draft.
import { API_KEY } from './env.mjs';

const GATEWAY = 'https://llm-gateway.assemblyai.com/v1/chat/completions';
const MODEL = process.env.LLM_MODEL || 'qwen3.5-4b-32k-fast';

/**
 * results: [{expected, spoken, accuracy, dropped:[], swapped:[[said, script]], called, pauseMs, cueMs}]
 * Returns { notes, facts, source: 'llm' | 'rules', model? }.
 */
export async function directorNotes({ character, results }) {
  const { facts, fallback } = draftNotes(character, results);
  try {
    const res = await fetch(GATEWAY, {
      method: 'POST',
      headers: { Authorization: API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 200,
        temperature: 0.5,
        messages: [
          {
            role: 'system',
            content: 'You are a warm theatre director giving an actor quick notes after a line run. Turn the rough notes into what you ' +
              'would actually say out loud: conversational, encouraging, specific. Keep every number and every quoted word exactly. ' +
              'Do not add facts. At most three sentences.',
          },
          { role: 'user', content: 'Rough notes: 6 of 7 lines word-perfect. Held a 3.2-second pause in line 3 and kept your place. Line 6: said "gonna", script says "going to". Called for a line in line 4. Cues picked up in 0.6 seconds on average.' },
          { role: 'assistant', content: 'Lovely run: six of seven lines word-perfect, and that 3.2-second pause in line 3 really held. Watch line 6, where the script says "going to", not "gonna". You called for a line in line 4, so run that speech a couple more times tonight.' },
          { role: 'user', content: `Rough notes: ${facts}` },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json();
    const text = json.choices?.[0]?.message?.content?.trim().replace(/^["']|["']$/g, '');
    if (!res.ok || !text) throw new Error(json.message || `HTTP ${res.status}`);
    if (!faithful(text, facts)) throw new Error('rewrite changed the facts');
    return { notes: text, facts, source: 'llm', model: MODEL };
  } catch (e) {
    console.warn('Director notes: using rules —', e.message);
    return { notes: fallback, facts, source: 'rules' };
  }
}

function draftNotes(character, results) {
  const facts = [];
  const prose = [];
  const n = results.length;
  const perfect = results.filter((r) => r.accuracy >= 0.999).length;
  facts.push(`${perfect} of ${n} lines word-perfect.`);
  prose.push(`Good run as ${character}: ${perfect} of ${n} lines were word-perfect.`);
  const indexed = results.map((r, i) => ({ ...r, line: i + 1 }));
  const held = indexed.filter((r) => r.pauseMs > 1200).sort((a, b) => b.pauseMs - a.pauseMs)[0];
  if (held) {
    const s = (held.pauseMs / 1000).toFixed(1);
    facts.push(`Held a ${s}-second pause in line ${held.line} and kept your place.`);
    prose.push(`You held a ${s}-second pause in line ${held.line} and kept your place.`);
  }
  const swap = indexed.find((r) => r.swapped.length);
  if (swap) {
    const [said, script] = swap.swapped[0];
    facts.push(`Line ${swap.line}: said "${said}", script says "${script}".`);
    prose.push(`In line ${swap.line} you said "${said}" — the script says "${script}".`);
  }
  const dropped = indexed.find((r) => r.dropped.length && !r.swapped.length);
  if (dropped) {
    const w = dropped.dropped.slice(0, 3).join(' ');
    facts.push(`Line ${dropped.line}: dropped "${w}".`);
    prose.push(`In line ${dropped.line} you dropped "${w}".`);
  }
  const called = indexed.filter((r) => r.called).map((r) => r.line);
  if (called.length) {
    facts.push(`Called for a line in line ${called.join(' and ')}.`);
    prose.push(`You called for a line in line ${called.join(' and ')}, so run that speech again tonight.`);
  }
  const cues = results.map((r) => r.cueMs).filter((x) => Number.isFinite(x));
  if (cues.length) {
    const avg = (cues.reduce((a, b) => a + b, 0) / cues.length / 1000).toFixed(1);
    facts.push(`Cues picked up in ${avg} seconds on average.`);
    prose.push(`Your scene partners picked up your cues in ${avg} seconds on average.`);
  }
  return { facts: facts.join(' '), fallback: prose.join(' ') };
}

// Every quoted phrase and number in the rewrite must come from the draft.
function faithful(text, draft) {
  const quotes = [...text.matchAll(/["“”]([^"“”]{2,40})["“”]/g)].map((m) => m[1].toLowerCase());
  const nums = text.match(/\d+(?:\.\d+)?/g) || [];
  const d = draft.toLowerCase();
  return quotes.every((q) => d.includes(q)) && nums.every((x) => draft.includes(x));
}
