import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseScript } from '../public/lib/parse.js';

const read = (f) => fs.readFileSync(new URL(`../scenes/${f}`, import.meta.url), 'utf8');

test('parses NAME: dialogue, headings, actions and directives', () => {
  const { meta, items, characters } = parseScript(read('01-last-ferry.txt'));
  assert.equal(meta.title, 'The Last Ferry');
  assert.equal(meta.cast.MAYA, 'eve');
  assert.equal(meta.fx.RADIO, 'radio');
  assert.deepEqual(characters, ['MAYA', 'DANNY', 'RADIO']);
  assert.equal(items[0].type, 'heading');
  assert.equal(items[1].type, 'action');
  const danny = items.find((x) => x.character === 'DANNY');
  assert.equal(danny.note, 'without looking up');
  assert.equal(danny.speech, 'Left at 9:40. On the dot. Like it does every night.');
  assert.equal(items.filter((x) => x.character === 'MAYA').length, 7);
});

test('parses Gutenberg-style stage plays with [directions]', () => {
  const { items, characters } = parseScript(read('02-earnest-handbag.txt'));
  assert.deepEqual(characters, ['LADY BRACKNELL', 'JACK']);
  const grave = items.find((x) => x.note === 'Gravely');
  assert.equal(grave.speech, 'In a hand-bag.');
  const long = items.find((x) => x.character === 'JACK' && x.speech.startsWith('I am afraid'));
  assert.match(long.speech, /lost me\.\.\. I don’t actually know/);
});

test('parses classic screenplay cues', () => {
  const { items } = parseScript('INT. KITCHEN - DAY\n\nSAM\n(quietly)\nIs it done?\n\nALEX (V.O.)\nAlmost.\n');
  assert.deepEqual(items.map((x) => x.type), ['heading', 'line', 'line']);
  assert.equal(items[1].note, 'quietly');
  assert.equal(items[2].character, 'ALEX');
});
