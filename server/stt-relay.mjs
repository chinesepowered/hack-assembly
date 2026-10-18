// Browser <-> AssemblyAI Universal-3.6 Pro streaming STT relay.
// Keeps the API key on the server; the browser speaks the same v3 protocol
// (binary PCM16 frames up, JSON Turn/SpeechStarted messages down).
import WebSocket, { WebSocketServer } from 'ws';
import { API_KEY, wsAgent } from './env.mjs';

const STT_URL = 'wss://streaming.assemblyai.com/v3/ws';
const PASSTHROUGH = ['keyterms_prompt', 'prompt', 'min_turn_silence', 'max_turn_silence', 'vad_threshold', 'mode', 'interruption_delay'];

export function attachSttRelay(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/stt') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (client) => relay(client, url.searchParams));
  });
}

function relay(client, params) {
  const qs = new URLSearchParams({ speech_model: 'universal-3-6-pro', sample_rate: '16000', encoding: 'pcm_s16le' });
  for (const k of PASSTHROUGH) if (params.has(k)) qs.set(k, params.get(k));

  const upstream = new WebSocket(`${STT_URL}?${qs}`, { headers: { Authorization: API_KEY }, agent: wsAgent });
  const backlog = [];

  upstream.on('open', () => { for (const [d, bin] of backlog.splice(0)) upstream.send(d, { binary: bin }); });
  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on('close', (code, reason) => {
    if (client.readyState === WebSocket.OPEN) client.close(code === 1005 ? 1000 : code, reason.toString().slice(0, 120));
  });
  upstream.on('error', (e) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'Error', error: `upstream: ${e.message}` }));
      client.close(1011);
    }
  });

  client.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    else if (upstream.readyState === WebSocket.CONNECTING) backlog.push([data, isBinary]);
  });
  client.on('close', () => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(JSON.stringify({ type: 'Terminate' }));
      setTimeout(() => upstream.terminate(), 2000);
    } else upstream.terminate();
  });
  client.on('error', () => upstream.terminate());
}
