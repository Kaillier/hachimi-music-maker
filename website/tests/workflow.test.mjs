import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as core from '../audio-core.js';

function harness(storage = new Map()) {
  const makeNode = tag => ({
    tagName: tag.toUpperCase(), textContent: '', dataset: {}, attributes: {}, children: [],
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
  });
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      ...makeNode('div'), disabled: false, checked: false, value: '', innerHTML: '',
      classList: { remove() {}, toggle() {} }, listeners: {},
      addEventListener(name, fn) { this.listeners[name] = fn; },
      querySelector() { return null; }, focus() {}, remove() {},
      getBoundingClientRect() { return { width: 800, height: 80 }; },
      getContext() { return { clearRect() {}, fillRect() {} }; }
    });
    return elements.get(id);
  };
  const tools = new Map();
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
      createElement(tag) { return { ...makeNode(tag), href: '', download: '', rel: '', click() { downloads.push(this.href); }, remove() {} }; },
      body: { append() {} }, modelContext: {
      registerTool(tool) { tools.set(tool.name, tool); }
    }},
    navigator: {},
    window: { addEventListener() {} },
    devicePixelRatio: 1,
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    requestAnimationFrame() {}, ResizeObserver: class { observe() {} },
    fetch: (...args) => fetchImpl(...args), setTimeout, AbortController, DOMException, URL,
  });
  let code = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  code = code.replace(/^import .*?;\r?\n/, '');
  vm.runInContext(code, context);
  const project = { id: 'test-song', fingerprint: 'test', renderMode: 'openutau-ustx', pipeline: 'vocal2midi-ustx-v1', sampleRate: 44100, duration: 2, waveform: [.2,.4,.6],
    units: [0,1,2,3].map(i => ({ id: i, start: i * .5, end: (i + 1) * .5 })),
    phrases: [{ id: 0, start: 0, end: 1, units: [0,1] }, { id: 1, start: 1, end: 2, units: [2,3] }] };
  context.fixture = project;
  vm.runInContext(`
    state.project = fixture; state.draft = emptyDraft(fixture); state.ready = true; state.audioReady = true;
    state.original = { duration: 2 };
    for (const id of SOUND_IDS) state.samples[id] = { duration: .2 };
    renderSoundPads();
    render();
  `, context);
  return { context, tools, storage, audioSources, element,
    downloads, setFetch: fn => { fetchImpl = fn; },
    run: code => vm.runInContext(code, context), snapshot: () => JSON.parse(vm.runInContext('JSON.stringify(state.draft)', context)) };
}

test('phrase navigation shows literal lyrics with the time, count and confirmation state', () => {
  const h = harness();
  h.run(`state.project.phrases[0].text = '东 船 与 西 舫 <b> & chorus';
    state.draft.confirmed[0] = true; render();`);
  const [first, second] = h.element('phrases').children;
  assert.equal(first.dataset.phrase, 0);
  assert.equal(first.attributes['aria-current'], 'true');
  assert.equal(first.children[0].textContent, '01');
  assert.equal(first.children[1].children[0].textContent, '东船与西舫 <b> & chorus');
  assert.equal(first.children[1].children[1].textContent, '00:00 · 2 单元');
  assert.equal(first.children[2].dataset.lucide, 'check');
  assert.equal(second.children[1].children[0].textContent, '第 2 段');
});

test('editing lyrics and excluding a unit updates the draft without changing source units', async () => {
  const h = harness();
  h.run(`state.project.phrases[0].text = '旧 歌词';
    changeSequence(['ha', 'ji'], 0); state.draft.confirmed[0] = true;
    editPhrase('修正的歌词', [false, true]);`);
  assert.match(h.element('phrase-title').textContent, /修正的歌词/);
  assert.doesNotMatch(h.element('slots').innerHTML, /data-index="1"/);
  assert.equal(h.element('confirm').disabled, false);
  assert.equal(h.run('fixture.phrases[0].text'), '旧 歌词');
  assert.deepEqual(h.snapshot().sequences[0], ['ha', 'ji']);
  assert.equal(h.snapshot().confirmed[0], false);
  const payload = JSON.parse(h.run('JSON.stringify(nativeRenderPayload(fixture, restoreDraft(fixture, state.draft)))'));
  assert.deepEqual(payload.sequences[0], ['ha', core.KEEP_ORIGINAL]);
  assert.equal('phraseEdits' in payload, false);
  await h.element('undo').listeners.click();
  assert.deepEqual(h.snapshot().sequences[0], ['ha', 'ji']);
  assert.equal(h.snapshot().confirmed[0], true);
  assert.match(h.element('phrase-title').textContent, /旧歌词/);
  assert.match(h.element('slots').innerHTML, /data-index="1"/);
});

test('keeping an entire phrase frees it from replacement and confirmation', async () => {
  const h = harness();
  h.run('editPhrase(null, [true, true]); state.draft.sequences[1] = ["ha", "ji"]; state.draft.confirmed[1] = true; render()');
  assert.equal(h.element('phase').textContent, '保留原声');
  assert.equal(h.run('state.selected'), -1);
  assert.equal(h.element('export').disabled, false);
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(nativeRenderPayload(fixture, state.draft))')).confirmed, [true, true]);
  h.run('editPhrase(null, [false, false])');
  assert.equal(h.element('export').disabled, true);
});

test('deleting a phrase removes it from navigation, skips its slots and can restore its prior edits', async () => {
  const h = harness();
  h.run(`state.project.phrases.push({ id: 2, start: 2, end: 3, units: [4, 5] });
    state.project.units.push({ id: 4, start: 2, end: 2.5 }, { id: 5, start: 2.5, end: 3 });
    state.draft = emptyDraft(state.project);
    state.draft.sequences = [['ha', 'ha'], ['ji', 'mi'], ['bo', 'bo']];
    state.draft.confirmed[1] = true;
    state.draft.current = 1;
    editPhrase('修正过的歌词', [false, false]);`);
  h.element('delete-phrase-dialog').returnValue = 'delete';
  h.element('delete-phrase-dialog').listeners.close();
  assert.deepEqual(h.element('phrases').children.map(node => node.dataset.phrase), [0, 2]);
  assert.equal(h.run('current()'), 2);
  await h.element('previous').listeners.click();
  assert.equal(h.run('current()'), 0);
  await h.run('confirm()');
  assert.equal(h.run('current()'), 2);
  h.run('state.draft = restoreDraft(fixture, state.draft); render();');
  const payload = JSON.parse(h.run('JSON.stringify(nativeRenderPayload(fixture, state.draft))'));
  assert.deepEqual(payload.sequences[1], [core.KEEP_ORIGINAL, core.KEEP_ORIGINAL]);
  assert.equal(payload.confirmed[1], true);
  h.run('setPhraseDeleted(1, false)');
  assert.equal(h.run('current()'), 1);
  assert.match(h.element('phrase-title').textContent, /修正过的歌词/);
  assert.deepEqual(h.snapshot().sequences[1], ['ji', 'mi']);
  assert.equal(h.snapshot().confirmed[1], true);
});

test('all deleted phrases leave a recoverable empty editor without blocking export', () => {
  const h = harness();
  h.run('setPhraseDeleted(0, true); setPhraseDeleted(1, true); state.draft = restoreDraft(fixture, state.draft); render()');
  assert.equal(h.element('phrases').children.length, 0);
  assert.equal(h.run('current()'), -1);
  assert.equal(h.element('active-phrase').hidden, true);
  assert.equal(h.element('show-deleted-phrases').hidden, false);
  assert.equal(h.element('export').disabled, false);
  h.run('setPhraseDeleted(0, false)');
  assert.equal(h.element('active-phrase').hidden, false);
  assert.equal(h.element('export').disabled, true);
});

test('multiple presses stay on the same phrase and a filled segment can be confirmed during playback', async () => {
  const h = harness();
  await h.run('choose("ha")');
  assert.equal(h.element('confirm').disabled, true);
  await h.run('choose("ji")');
  assert.deepEqual(h.snapshot().sequences[0], ['ha', 'ji']);
  assert.equal(h.snapshot().current, 0);
  assert.equal(h.element('confirm').disabled, false);
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
    songId: 'test-song', fingerprint: 'test', phraseIndex: 0, sequences: [['ha', 'ji'], [null, null]], confirmed: [false, false], backingGain: .5, soundGain: .5,
  });
  assert.equal(h.run('state.playback.kind'), 'preview');
  assert.equal(h.element('confirm').disabled, false);
  await h.run('confirm()');
  assert.equal(h.snapshot().confirmed[0], true);
  assert.equal(h.snapshot().current, 1);
  assert.equal(h.run('state.playback.kind'), 'original');
});

test('unchanged previews replay instantly or reuse their WAV across sections', async () => {
  const h = harness();
  const renders = [];
  const reads = [];
  h.setFetch(async (url, options = {}) => {
    if (options.method === 'POST') {
      renders.push(JSON.parse(options.body));
      const id = 'preview-' + renders.length;
      return { ok: true, status: 202, json: async () => ({ id, status: 'completed', wavUrl: '/api/render/' + id + '/audio' }) };
    }
    reads.push(url);
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
  });
  h.run('state.draft.sequences = [["ha", "ji"], ["mi", "bo"]]');
  await h.run('preview()');
  h.audioSources.at(-1).onended();
  h.run('state.draft.confirmed[0] = true');
  await h.run('preview()');
  assert.equal(renders.length, 1);
  assert.equal(reads.length, 1);
  assert.equal(h.audioSources.length, 2);

  await h.run('selectPhrase(1, false)');
  await h.run('preview()');
  await h.run('selectPhrase(0, false)');
  await h.run('preview()');
  assert.deepEqual(renders.map(payload => payload.phraseIndex), [0, 1]);
  assert.equal(reads.at(-1), '/api/render/preview-1/audio');

  h.run('state.draft.soundGain = .7');
  await h.run('preview()');
  h.run('changeSequence(["ha", "bo"], -1)');
  await h.run('preview()');
  assert.equal(renders.length, 4);
  assert.equal(renders[2].soundGain, .7);
  assert.deepEqual(renders[3].sequences[0], ['ha', 'bo']);
});

test('a second click during the first preview audio load does not submit another render', async () => {
  const h = harness();
  let submissions = 0;
  let notifyReading;
  const reading = new Promise(resolve => { notifyReading = resolve; });
  let releaseAudio;
  const audio = new Promise(resolve => { releaseAudio = resolve; });
  h.setFetch(async (_url, options = {}) => {
    if (options.method === 'POST') {
      submissions++;
      return { ok: true, status: 202, json: async () => ({ id: 'first', status: 'completed', wavUrl: '/api/render/first/audio' }) };
    }
    notifyReading();
    return { ok: true, status: 200, arrayBuffer: () => audio };
  });
  h.run('changeSequence(["ha", "mi"], -1)');
  const first = h.run('preview()');
  await reading;
  await h.run('preview()');
  assert.equal(submissions, 1);
  releaseAudio(new ArrayBuffer(8));
  await first;
  assert.equal(h.audioSources.length, 1);
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

test('editing a completed phrase advances to the adjacent filled slot and stops at the end', async () => {
  const h = harness();
  h.run('state.draft.sequences[0] = ["ha", "ji"]; state.draft.confirmed[0] = true');
  await h.run('selectPhrase(0, false)');
  assert.equal(h.run('state.selected'), 0);
  await h.run('choose("ha")');
  assert.equal(h.run('state.selected'), 1);
  assert.equal(h.snapshot().confirmed[0], true);
  await h.run('choose("clip_ding")');
  assert.deepEqual(h.snapshot().sequences[0], ['ha', 'clip_ding']);
  assert.equal(h.snapshot().confirmed[0], false);
  assert.equal(h.run('state.selected'), -1);
  await h.run('choose("bo")');
  assert.deepEqual(h.snapshot().sequences[0], ['ha', 'clip_ding']);
  await h.element('undo').listeners.click();
  assert.deepEqual(h.snapshot().sequences[0], ['ha', 'ji']);
  assert.equal(h.run('state.selected'), 1);
});

test('sample-only mode works without a selected slot and preserves the draft and cursor', async () => {
  const h = harness();
  h.run('changeSequence(["ha", "ji"], 1); state.draft.confirmed[0] = true');
  const before = h.snapshot();
  h.element('sound-mode-audition').checked = true;
  h.element('sound-mode-audition').listeners.change();
  assert.equal(h.element('audition').disabled, true);
  await h.run('choose("clip_ding")');
  assert.equal(h.run('state.selected'), 1);
  h.run('state.selected = -1');
  await h.run('choose("mi")');
  assert.equal(h.run('state.selected'), -1);
  assert.equal(h.run('state.playback.kind'), 'sample');
  assert.equal(h.audioSources.length, 2);
  assert.deepEqual(h.snapshot(), before);
  assert.equal(h.run('state.history[0].length'), 1);
});

test('stopped previews stay stopped and leave confirmation available', async () => {
  const h = harness();
  h.run('changeSequence(["ha","mi"], -1)');
  await h.run('preview()');
  const ended = h.audioSources.at(-1).onended;
  h.run('stop()');
  ended();
  assert.equal(h.element('confirm').disabled, false);
  const pending = h.run('original()');
  h.run('stop()');
  await pending;
  assert.equal(h.run('state.source'), null);
});

test('confirming every filled phrase without a preview unlocks full playback and export', async () => {
  const h = harness();
  let renderRequests = 0;
  h.setFetch(async () => { renderRequests++; throw Error('Unexpected rendering request'); });
  for (let i = 0; i < 2; i++) {
    h.run('changeSequence(["ha","bo"], -1)');
    assert.equal(h.element('export').disabled, true);
    assert.equal(h.element('confirm').disabled, false);
    await h.element('confirm').listeners.click();
  }
  assert.deepEqual(h.snapshot().confirmed, [true, true]);
  assert.equal(renderRequests, 0);
  assert.equal(h.element('export').disabled, false);
  assert.equal(h.element('full-play').disabled, false);
  h.run('state.selected = 0');
  await h.run('choose("ji")');
  assert.equal(h.element('export').disabled, true);
});

test('the saved autoplay preference applies to navigation and keeps manual playback available', async () => {
  const h = harness();
  const autoplay = h.element('phrase-autoplay');
  assert.equal(autoplay.checked, true);
  autoplay.checked = false;
  autoplay.listeners.change();
  assert.match(h.element('confirm').innerHTML, /确认并进入下一段/);

  h.run('changeSequence(["ha", "ji"], -1)');
  await h.element('confirm').listeners.click();
  assert.equal(h.snapshot().current, 1);
  await h.element('previous').listeners.click();
  assert.equal(h.snapshot().current, 0);
  await h.run('selectPhrase(1)');
  assert.equal(h.audioSources.length, 0);
  await h.element('original').listeners.click();
  assert.equal(h.audioSources.length, 1);

  const reopened = harness(h.storage);
  assert.equal(reopened.element('phrase-autoplay').checked, false);
  assert.match(reopened.element('confirm').innerHTML, /确认并进入下一段/);
  reopened.element('phrase-autoplay').checked = true;
  reopened.element('phrase-autoplay').listeners.change();
  await reopened.run('selectPhrase(1)');
  assert.equal(reopened.run('state.playback.kind'), 'original');
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
  h.run(`state.project.renderMode = 'openutau-ustx';
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
    ['backingGain', 'confirmed', 'fingerprint', 'sequences', 'songId', 'soundGain']);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    songId: 'test-song', fingerprint: 'test', sequences: [['ha', 'ji'], ['mi', 'bo']], confirmed: [true, true], backingGain: .8, soundGain: .9,
  });
  assert.deepEqual(calls.slice(1).map(call => call.url), ['/api/render/job-1', '/api/render/job-1']);
  assert.deepEqual(h.downloads, ['http://localhost/api/render/job-1.wav']);
  assert.equal(h.element('status').textContent, 'WAV 已生成并开始下载');
});

test('failed native export stays failed, exposes retry, and never falls back to browser mixing', async () => {
  const h = harness();
  h.run(`state.project.renderMode = 'openutau-ustx';
    state.draft.sequences = [['ha', 'ji'], ['mi', 'bo']];
    state.draft.confirmed = [true, true]; render();`);
  h.setFetch(async () => ({ ok: true, status: 200, json: async () => ({ id: 'job-2', status: 'failed', error: 'engine unavailable' }) }));
  await h.run('requestNativeRender()');
  assert.equal(h.downloads.length, 0);
  assert.match(h.element('export').innerHTML, /重试生成/);
  assert.match(h.element('export-status').textContent, /engine unavailable/);
  assert.match(h.element('error').textContent, /engine unavailable/);
});

test('full preview plays the server cache and replays the decoded file without another request', async () => {
  const h = harness();
  h.run(`state.draft.sequences = [['ha', 'ji'], ['mi', 'bo']]; state.draft.confirmed = [true, true]; render();`);
  const calls = [];
  h.setFetch(async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === 'POST') return { ok: true, status: 202, json: async () => ({ id: 'full-1', status: 'completed', cached: true, wavUrl: '/api/render/full-1/audio' }) };
    if (url.endsWith('/audio')) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
    throw new Error('unexpected poll');
  });
  await h.element('full-play').listeners.click();
  assert.equal(calls[0].url, '/api/full-preview');
  assert.deepEqual(JSON.parse(calls[0].options.body).sequences, [['ha', 'ji'], ['mi', 'bo']]);
  assert.equal(h.audioSources.length, 1);
  await h.element('full-play').listeners.click();
  assert.equal(calls.length, 2);
  assert.equal(h.audioSources.length, 2);
});

test('the shared loop button renders the full default five-sound cycle', async () => {
  const h = harness();
  h.run(`state.project.phrases.push({ id: 2, start: 2, end: 3, units: [4, 5] });
    state.project.units.push({ id: 4, start: 2, end: 2.5 }, { id: 5, start: 2.5, end: 3 });
    state.draft = emptyDraft(state.project); render();`);
  const expected = [['ha', 'ji'], ['mi', 'man'], ['bo', 'ha']];
  const calls = [];
  h.setFetch(async (url, options = {}) => {
    calls.push({ url, options });
    return { ok: true, status: 202, json: async () => ({ id: 'manbo-1', status: 'completed', wavUrl: '/api/render/manbo-1/audio' }) };
  });
  assert.equal(h.element('pack-render').disabled, false);
  await h.element('pack-render').listeners.click();
  assert.deepEqual(h.snapshot().sequences, expected);
  assert.deepEqual(h.snapshot().confirmed, [true, true, true]);
  assert.equal(calls[0].url, '/api/render');
  assert.deepEqual(JSON.parse(calls[0].options.body).sequences, expected);
  assert.equal(h.downloads[0], 'http://localhost/api/render/manbo-1/audio');
});

test('all active sounds stay visible while the selected pack keeps its exact native preset', async () => {
  const h = harness();
  let payload;
  h.setFetch(async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, status: 202, json: async () => ({ id: 'new-pack', status: 'completed', wavUrl: '/api/render/new-pack/audio' }) };
  });
  const originalPads = h.element('sounds').innerHTML;
  h.element('sound-pack').value = 'daishuji';
  h.element('sound-pack').listeners.change();
  const pads = h.element('sounds').innerHTML;
  assert.equal(pads, originalPads);
  const groups = [...pads.matchAll(/<section class="sound-group" aria-labelledby="sound-group-([^"]+)">(.*?)<\/section>/g)];
  const renderedPacks = new Map(groups.map(([, id, html]) =>
    [id, [...html.matchAll(/data-sound="([^"]+)"/g)].map(match => match[1])]));
  assert.equal(renderedPacks.size, core.SOUND_PACKS.length + 1);
  for (const pack of core.SOUND_PACKS.filter(pack => pack !== core.DEFAULT_SOUND_PACK))
    assert.deepEqual(renderedPacks.get(pack.id), [...new Set(pack.pattern)]);
  assert.deepEqual(renderedPacks.get('hachimi'), ['ha', 'ji', 'mi']);
  assert.deepEqual(renderedPacks.get('manbo'), ['man', 'bo']);
  assert.deepEqual([...renderedPacks.get('hachimi'), ...renderedPacks.get('manbo')], core.DEFAULT_SOUND_PACK.pattern);
  const families = [...pads.matchAll(/<section class="sound-family" id="sound-family-([^"]+)" aria-label="[^"]+">(.*?)<\/section>(?=<section class="sound-family"|<div class="sound-groups">|$)/g)];
  assert.doesNotMatch(pads, /系列/);
  assert.deepEqual(families.map(([, id, html]) => [id, [...html.matchAll(/<h4 id="sound-group-([^"]+)"/g)].map(match => match[1])]), [
    ['hachimi', ['hachimi', 'axiga', 'wonanbeiluduo', 'hayeguonailong']],
    ['manbo', ['manbo', 'omajili', 'wasai', 'youda', 'zabu']],
    ['dingdongji', ['dingdongji', 'dagoujiao', 'chuqujian', 'daixingfenji', 'daiyiduan', 'daishuji', 'hesuan']],
  ]);
  for (const [, id, html] of families)
    assert.equal(html.match(/<img class="sound-family-art" src="([^"]+)"/)?.[1], '/images/' + id + '.png');
  for (const [, id, label] of pads.matchAll(/data-sound="([^"]+)">(.*?)<\/button>/g))
    assert.equal(label, '<strong>' + core.LABELS[id] + '</strong>');
  assert.doesNotMatch(pads, /data-sound="clip_xiu"/);
  assert.equal(h.element('pack-render').disabled, false);
  await h.element('pack-render').listeners.click();
  const expected = [['clip_dai2_bag', 'clip_shu'], ['clip_ji2', 'clip_dai2_bag']];
  assert.deepEqual(payload.sequences, expected);
  const restored = h.run('restoreDraft(fixture, state.draft)');
  assert.deepEqual(JSON.parse(JSON.stringify(restored.sequences)), expected);
});

test('palette colors follow each sound into the sequence', async () => {
  const h = harness();
  const colors = [...h.element('sounds').innerHTML.matchAll(/data-tone="([^"]+)" data-sound="([^"]+)"/g)];
  assert.equal(new Set(colors.map(([, tone]) => tone)).size, 8);
  assert.deepEqual([...new Set(colors.filter(([, , id]) => id === 'clip_ji2').map(([, tone]) => tone))], ['blue']);
  assert.deepEqual([...new Set(colors.filter(([, tone]) => tone === 'yellow').map(([, , id]) => id))],
    ['clip_dong', ...core.SOUND_PACKS.find(pack => pack.id === 'daixingfenji').pattern]);
  const dingdongPack = h.element('sounds').innerHTML.match(/aria-labelledby="sound-group-dingdongji">(.*?)<\/section>/)[1];
  assert.deepEqual([...dingdongPack.matchAll(/data-tone="([^"]+)"/g)].map(([, tone]) => tone), ['coral', 'yellow', 'blue']);
  const purplePack = h.element('sounds').innerHTML.match(/aria-labelledby="sound-group-daiyiduan">(.*?)<\/section>/)[1];
  assert.deepEqual([...purplePack.matchAll(/data-tone="([^"]+)"/g)].map(([, tone]) => tone),
    ['violet', 'violet', 'violet']);
  await h.run('choose("clip_ding")');
  assert.match(h.element('slots').innerHTML, /data-tone="coral" data-sound="clip_ding"/);
});
