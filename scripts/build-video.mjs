// Assemble a recorded take (screencast frames + in-page audio) into an MP4.
// Usage: node scripts/build-video.mjs demo/build/take-... [out.mp4]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const take = path.resolve(process.argv[2]);
const out = path.resolve(process.argv[3] || path.join(take, 'scene-partner-demo.mp4'));
const { frames, audio } = JSON.parse(fs.readFileSync(path.join(take, 'take.json'), 'utf8'));

// Screencast timestamps and the audio clock are both wall-clock seconds.
const a0 = audio.epochMs / 1000;
const a1 = a0 + audio.seconds;
let first = 0;
while (first + 1 < frames.length && frames[first + 1].t <= a0) first++;
const list = [];
for (let i = first; i < frames.length; i++) {
  const start = i === first ? a0 : Math.max(frames[i].t, a0);
  const end = Math.min(i + 1 < frames.length ? frames[i + 1].t : a1, a1);
  if (end <= start) continue;
  list.push(`file 'frames/${frames[i].file}'`, `duration ${(end - start).toFixed(4)}`);
}
list.push(list[list.length - 2]); // concat demuxer: repeat the last file
fs.writeFileSync(path.join(take, 'frames.txt'), list.join('\n') + '\n');
console.log(`frames ${frames.length - first} · video starts ${(frames[first].t - a0).toFixed(3)}s vs audio · ${audio.seconds.toFixed(1)}s`);

execFileSync('ffmpeg', [
  '-y', '-hide_banner', '-loglevel', 'warning',
  '-f', 'concat', '-safe', '0', '-i', path.join(take, 'frames.txt'),
  '-i', path.join(take, 'audio.wav'),
  '-fps_mode', 'cfr', '-r', '30',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-tune', 'stillimage',
  '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
  '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
  '-movflags', '+faststart', '-shortest', out,
], { stdio: 'inherit', cwd: take });
console.log(out);
