import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWord, tokenize, spokenTokens, align, extractCalls, scoreLine } from '../public/lib/align.js';

const E = (s) => tokenize(s).tokens.map((x) => x.t);

test('normalizes times, numbers, punctuation and contractions', () => {
  assert.deepEqual(normalizeWord('9:40'), ['nine', 'forty']);
  assert.deepEqual(normalizeWord('9:05.'), ['nine', 'oh', 'five']);
  assert.deepEqual(normalizeWord('2,000'), ['two', 'thousand']);
  assert.deepEqual(normalizeWord("hasn't"), ['hasnt']);
  assert.deepEqual(normalizeWord('hand-bag—a'), ['hand', 'bag', 'a']);
  assert.deepEqual(normalizeWord('$14.50'), ['fourteen', 'fifty']);
});

test('formatted final and unformatted partial agree', () => {
  assert.deepEqual(spokenTokens('Please tell me the 9:40 hasn\'t left.'), spokenTokens('please tell me the nine forty hasnt left'));
});

test('live progress follows a partial transcript', () => {
  const exp = E("You don't understand. She doesn't know I'm here. I flew in from Denver this morning just to say I'm sorry.");
  const r = align(exp, spokenTokens("you don't understand she doesn't know i'm here"));
  assert.equal(r.progress, 8);
  assert.equal(r.matched, 8);
});

test('repeated words do not trigger an early end', () => {
  const exp = E('Hello. Okay. I can do hello.');
  assert.equal(align(exp, spokenTokens('hello')).progress, 1);
  assert.equal(align(exp, spokenTokens('hello okay i can do hello')).progress, 6);
});

test('merged/split compounds count as matches', () => {
  const exp = E('In a hand-bag.');
  const r = align(exp, spokenTokens('in a handbag'), { full: true });
  assert.equal(r.matched, 4);
});

test('line calls are stripped, but a scripted "line" is not', () => {
  const ferry = E('For not picking up the phone. For three years.');
  const c = extractCalls(ferry, spokenTokens('For not picking up the phone. Line?'));
  assert.equal(c.called, true);
  assert.equal(c.tokens.includes('line'), false);

  const brighton = E('Yes. The Brighton line.');
  const b = extractCalls(brighton, spokenTokens('Yes. The Brighton line.'));
  assert.equal(b.called, false);
});

test('scoring flags a paraphrase', () => {
  const s = scoreLine("I don't even know what I'm going to say to her.", "I don't even know what I'm gonna say to her.");
  assert.ok(s.accuracy < 1 && s.accuracy > 0.75, `accuracy ${s.accuracy}`);
  assert.deepEqual(s.swapped, [['gonna', 'going to']]);
  assert.equal(s.words.find((w) => w.w === 'going').said, 'gonna');
  const perfect = scoreLine('Please tell me the 9:40 hasn\'t left.', 'Please tell me the 9:40 hasn\'t left.');
  assert.equal(perfect.accuracy, 1);
});

test('fillers are optional and spoken forms of numbers match', () => {
  assert.equal(scoreLine("Then your sister's having a lovely, uh, very wet crossing.", "Then your sister's having a lovely, very wet crossing.").accuracy, 1);
  assert.equal(scoreLine('DANNY, sixties, counts the cash drawer.', 'Danny, 60s, counts the cash drawer.').accuracy, 1);
  assert.equal(scoreLine('in about a hundred milliseconds', 'in about 100 milliseconds').accuracy, 1);
});
