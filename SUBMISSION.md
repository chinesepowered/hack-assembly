# Submission copy: Scene Partner

**Project name:** Scene Partner

**One-liner:** Rehearse any scene with AI scene partners who come in on cue, built on AssemblyAI streaming TTS
and Universal-3.6 Pro.

**Short description (≈60 words):**
Scene Partner is a rehearsal room for actors. Paste a scene and every other character is voiced with AssemblyAI's
streaming TTS. Run your lines off-book, and Universal-3.6 Pro follows you through the script. Your partner comes
in the instant your line ends, holds through dramatic pauses, and prompts you when you call "Line?". Afterward you
get a report card and spoken director's notes.

**What's interesting technically:**
- *Script-aware endpointing.* Because the app knows the line, it aligns live partials against it and sends
  `ForceEndpoint` once the actor goes quiet near the end. The cue lands about 240 ms after the last word (demo
  take average). A mid-line pause isn't treated as a turn end.
- *All three AssemblyAI pillars in one loop.* Streaming TTS for partners, narrator, live prompts (about 200 ms)
  and spoken notes. Streaming STT with keyterms pulled from the script. LLM Gateway for director's notes,
  grounded in the scored run, with a faithfulness check.
- *TTS proofreading.* Every rendered clip is transcribed with Universal-3.5 Pro and scored against its text. This
  caught a phrasing ("uh...") that cut synthesis short.
- Word-level karaoke from TTS word boundaries, a radio FX voice, an off-book reveal, and a parser for
  screenplays and Gutenberg plays.

**Demo video:** `demo/scene-partner-demo.mp4` in the repo (3:05). All voices and narration are AssemblyAI TTS.
In the rehearsal, a stand-in TTS voice plays the actor through the real microphone pipeline.

**Built with:** AssemblyAI Streaming TTS, Universal-3.6 Pro streaming STT, LLM Gateway (qwen3.5-4b-32k-fast),
Universal-3.5 Pro (QA), Node.js, Web Audio / AudioWorklet, Playwright (demo recording), ffmpeg.

**What's next:** cloning your scene partner's voice (with consent) once voice cloning ships on the TTS
endpoint, multi-actor rooms where a human plays one part and joins remotely, and memorization drills
that hide progressively more of each line.
