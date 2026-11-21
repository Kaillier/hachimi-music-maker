import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as core from '../audio-core.js';

function harness() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      disabled: false, checked: false, value: '', textContent: '', innerHTML: '',
      classList: { remove() {}, toggle() {} }, dataset: {}, listeners: {},
      addEventListener(name, fn) { this.listeners[name] = fn; },
      querySelector() { return null; }, focus() {}, append() {}, remove() {},
      getBoundingClientRect() { return { width: 800, height: 80 }; },
      getContext() { return { clearRect() {}, fillRect() {} }; }
    });
    return elements.get(id);
  };
  const tools = new Map();
  const storage = new Map();
  const audioSources = [];
  const downloads = [];
  let fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST') return { ok: true, status: 202, json: async () => ({ id: 'default', status: 'completed', wavUrl: '/api/render/default/audio' }) };
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
  };
  const context = vm.createContext({
    ...core, console, AudioContext: class {
      currentTime = 0;
      resume() { return Promise.resolve(); }
      decodeAudioData() { return Promise.resolve({ duration: .5 }); }
      createBufferSource() {
        const source = { connect() {}, disconnect() {}, start() {}, stop() {}, onended: null };
        audioSources.push(source); return source;
      }
    },
    AudioBuffer: class {
      constructor({ length, sampleRate }) { this.duration = length / sampleRate; }
      copyToChannel() {}
    },
    document: { getElementById: element, querySelectorAll: () => [], baseURI: 'http://localhost/',
      createElement(tag) { return { tagName: tag.toUpperCase(), href: '', download: '', rel: '', click() { downloads.push(this.href); }, remove() {} }; },
      body: { append() {} }, modelContext: {
      registerTool(tool) { tools.set(tool.name, tool); }
    }},
    navigator: {},
    window: { addEventListener() {} },
    devicePixelRatio: 1,
    localStorage: { setItem: (k, v) => storage.set(k, v) },
    requestAnimationFrame() {}, ResizeObserver: class { observe() {} },
    fetch: (...args) => fetchImpl(...args), setTimeout, AbortController, DOMException, URL,
  });
  let code = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  code = code.replace(/^import .*?;\r?\n/, '');
  vm.runInContext(code, context);
  const project = { id: 'test-song', fingerprint: 'test', renderMode: 'openutau-native', sampleRate: 44100, duration: 2, waveform: [.2,.4,.6],
    units: [0,1,2,3].map(i => ({ id: i, start: i * .5, end: (i + 1) * .5 })),
    phrases: [{ id: 0, start: 0, end: 1, units: [0,1] }, { id: 1, start: 1, end: 2, units: [2,3] }] };
  context.fixture = project;
  vm.runInContext(`
    state.project = fixture; state.draft = emptyDraft(fixture); state.ready = true; state.audioReady = true;
    state.original = { duration: 2 };
    for (const id of SOUND_IDS) state.samples[id] = { duration: .2 };
    render();
  `, context);
  return { context, tools, storage, audioSources, element,
    downloads, setFetch: fn => { fetchImpl = fn; },
    run: code => vm.runInContext(code, context), snapshot: () => JSON.parse(vm.runInContext('JSON.stringify(state.draft)', context)) };
}

test('multiple presses stay on the same phrase; preview completion unlocks confirmation', async () => {
  const h = harness();
  await h.run('choose("ha")');
  await h.run('choose("ji")');
  assert.deepEqual(h.snapshot().sequences[0], ['ha', 'ji']);
  assert.equal(h.snapshot().current, 0);
  assert.equal(h.element('confirm').disabled, true);
  const calls = [];
  let polls = 0;
  h.setFetch(async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === 'POST') return { ok: true, status: 202, json: async () => ({ id: 'phrase-1', status: 'queued' }) };
    if (url.endsWith('/audio')) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
    polls++;
    return { ok: true, status: 200, json: async () => polls === 1
      ? { id: 'phrase-1', status: 'running' }
      : { id: 'phrase-1', status: 'completed', wavUrl: '/api/render/phrase-1/audio' } };
  });
  await h.run('preview()');
  assert.equal(calls[0].url, '/api/preview');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    songId: 'test-song', fingerprint: 'test', noteMode: 'game-vocal', timingMode: 'beat', pitchMode: 'default', phraseIndex: 0, sequence: ['ha', 'ji'], backingGain: 1, soundGain: 1,
  });
  assert.equal(h.element('confirm').disabled, true);
  h.audioSources.at(-1).onended();
  assert.equal(h.element('confirm').disabled, false);
  await h.run('confirm()');
  assert.equal(h.snapshot().confirmed[0], true);
  assert.equal(h.snapshot().current, 1);
  assert.equal(h.run('state.playback.kind'), 'original');
});

test('edit, undo, clear and repeat invalidate confirmation without losing neighboring phrases', async () => {
  const h = harness();
  await h.run('choose("man")');
  await h.element('repeat').listeners.click();
  assert.deepEqual(h.snapshot().sequences[0], ['man', 'man']);
  await h.element('undo').listeners.click();
  assert.deepEqual(h.snapshot().sequences[0], ['man', null]);
  await h.element('clear').listeners.click();
  assert.deepEqual(h.snapshot().sequences[0], [null, null]);
  assert.deepEqual(h.snapshot().sequences[1], [null, null]);
  assert.ok(h.storage.size > 0);
});

test('stopped previews cannot authorize confirmation; navigation cancels pending audio starts', async () => {
  const h = harness();
  h.run('changeSequence(["ha","mi"], -1)');
  await h.run('preview()');
  const ended = h.audioSources.at(-1).onended;
  h.run('stop()');
  ended();
  assert.equal(h.element('confirm').disabled, true);
  const pending = h.run('original()');
  h.run('stop()');
  await pending;
  assert.equal(h.run('state.source'), null);
});

test('last phrase unlocks full export only after completed preview and confirmation', async () => {
  const h = harness();
  for (let i = 0; i < 2; i++) {
    h.run('changeSequence(["ha","bo"], -1)');
    await h.run('preview()');
    h.audioSources.at(-1).onended();
    await h.run('confirm()');
  }
  assert.equal(h.element('export').disabled, false);
  assert.equal(h.element('full-play').disabled, false);
  h.run('state.selected = 0');
  await h.run('choose("ji")');
  assert.equal(h.element('export').disabled, true);
});

test('WebMCP tools share UI state and reject invalid sequences without changing it', async () => {
  const h = harness();
  await h.run('registerTools()');
  assert.deepEqual([...h.tools.keys()], ['get_arrangement', 'set_phrase_sequence']);
  const write = h.tools.get('set_phrase_sequence');
  await write.execute({ phraseIndex: 1, sounds: ['mi', 'bo'] });
  const data = JSON.parse((await h.tools.get('get_arrangement').execute({})).content[0].text);
  assert.equal(data.current, 1);
  assert.deepEqual(data.draft.sequences[1], ['mi', 'bo']);
  const before = h.snapshot();
  await assert.rejects(write.execute({ phraseIndex: 1, sounds: ['invalid'] }), /Invalid/);
  assert.deepEqual(h.snapshot(), before);
});

test('native export posts the exact snapshot, polls the server, and downloads only wavUrl', async () => {
  const h = harness();
  h.run(`state.project.renderMode = 'openutau-native';
    state.draft.sequences = [['ha', 'ji'], ['mi', 'bo']];
    state.draft.confirmed = [true, true];
    state.draft.backingGain = .8; state.draft.soundGain = .9; render();`);
  const calls = [];
  let polls = 0;
  const response = data => ({ ok: true, status: 200, json: async () => data });
  h.setFetch(async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === 'POST') return response({ id: 'job-1', status: 'queued' });
    polls++;
    return response(polls === 1
      ? { id: 'job-1', status: 'running' }
      : { id: 'job-1', status: 'completed', wavUrl: '/api/render/job-1.wav', ustxUrl: '/api/render/job-1.ustx' });
  });
  await h.run('requestNativeRender()');
  assert.equal(calls[0].url, '/api/render');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(Object.keys(JSON.parse(calls[0].options.body)).sort(),
    ['backingGain', 'confirmed', 'fingerprint', 'noteMode', 'pitchMode', 'sequences', 'songId', 'soundGain', 'timingMode']);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    songId: 'test-song', fingerprint: 'test', noteMode: 'game-vocal', pitchMode: 'default', timingMode: 'beat', sequences: [['ha', 'ji'], ['mi', 'bo']], confirmed: [true, true], backingGain: .8, soundGain: .9,
  });
  assert.deepEqual(calls.slice(1).map(call => call.url), ['/api/render/job-1', '/api/render/job-1']);
  assert.deepEqual(h.downloads, ['http://localhost/api/render/job-1.wav']);
  assert.equal(h.element('status').textContent, 'WAV 已生成并开始下载');
});

test('failed native export stays failed, exposes retry, and never falls back to browser mixing', async () => {
  const h = harness();
  h.run(`state.project.renderMode = 'openutau-native';
    state.draft.sequences = [['ha', 'ji'], ['mi', 'bo']];
    state.draft.confirmed = [true, true]; render();`);
  h.setFetch(async () => ({ ok: true, status: 200, json: async () => ({ id: 'job-2', status: 'failed', error: 'engine unavailable' }) }));
  await h.run('requestNativeRender()');
  assert.equal(h.downloads.length, 0);
  assert.match(h.element('export').innerHTML, /重试生成/);
  assert.match(h.element('export-status').textContent, /engine unavailable/);
  assert.match(h.element('error').textContent, /engine unavailable/);
});

test('full preview uses the same native renderer without requiring confirmation', async () => {
  const h = harness();
  h.run(`state.draft.sequences = [['ha', 'ji'], ['mi', 'bo']]; render();`);
  const calls = [];
  h.setFetch(async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === 'POST') return { ok: true, status: 202, json: async () => ({ id: 'full-1', status: 'completed', wavUrl: '/api/render/full-1/audio' }) };
    if (url.endsWith('/audio')) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
    throw new Error('unexpected poll');
  });
  await h.run('requestNativeAudio("/api/full-preview", nativeRenderPayload(state.project, state.draft), "full")');
  assert.equal(calls[0].url, '/api/full-preview');
  assert.deepEqual(JSON.parse(calls[0].options.body).sequences, [['ha', 'ji'], ['mi', 'bo']]);
  assert.equal(h.audioSources.length, 1);
});

test('Hachimi Manbo preset fills the whole project and exports through native rendering', async () => {
  const h = harness();
  const calls = [];
  h.setFetch(async (url, options = {}) => {
    calls.push({ url, options });
    return { ok: true, status: 202, json: async () => ({ id: 'manbo-1', status: 'completed', wavUrl: '/api/render/manbo-1/audio' }) };
  });
  await h.run('generateManbo()');
  assert.deepEqual(h.snapshot().sequences, [['ha', 'ji'], ['mi', 'man']]);
  assert.deepEqual(h.snapshot().confirmed, [true, true]);
  assert.equal(calls[0].url, '/api/render');
  assert.deepEqual(JSON.parse(calls[0].options.body).sequences, [['ha', 'ji'], ['mi', 'man']]);
  assert.equal(h.downloads[0], 'http://localhost/api/render/manbo-1/audio');
});
