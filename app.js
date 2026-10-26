'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const COLORS = {
  "Belady's OPT": '#ab8cff',
  'AI Predictor': '#09d7e8',
  LRU: '#38d996',
  FIFO: '#ffbf5f',
  LFU: '#64a5ff',
  Random: '#ff6582'
};
const POLICIES = ["Belady's OPT", 'AI Predictor', 'LRU', 'FIFO', 'LFU', 'Random'];
const PRESETS = {
  loop: { label: 'Tight loop', description: "A small loop body re-referenced over and over — LRU's dream.", body: 8, count: 512, pattern: 'loop' },
  sequential: { label: 'Sequential scan', description: 'A streaming pass through memory with little temporal locality.', body: 256, count: 1024, pattern: 'sequential' },
  stride: { label: 'Strided access', description: 'Repeated jumps through an array reveal how the working set maps to cache sets.', body: 32, count: 768, pattern: 'stride' },
  thrash: { label: 'Conflict thrash', description: 'Blocks mapping to the same set compete for a small number of cache lines.', body: 12, count: 768, pattern: 'thrash' },
  working: { label: 'Hot and cold set', description: 'A compact hot set is mixed with occasional cold references.', body: 20, count: 1024, pattern: 'working' },
  random: { label: 'Random workload', description: 'Deterministic pseudo-random accesses across a broad memory region.', body: 256, count: 1024, pattern: 'random' }
};

let trace = generateTrace('loop', 1024, 8, getGeometry().blockBytes);
let results = null;
let activeTraceTab = 'presets';
let activeResultTab = 'comparison';
let selectedPolicy = 'AI Predictor';
let selectedStep = 0;
let zoom = 1;
let selectedAccess = -1;
let currentPreset = 'loop';

function getGeometry() {
  const cacheKB = Number($('#cache-size-number')?.value || 16);
  const blockBytes = Number($('#block-size-number')?.value || 64);
  const selectedWays = $('#associativity')?.value || '4';
  const totalLines = Math.floor(cacheKB * 1024 / blockBytes);
  const ways = selectedWays === 'fully' ? totalLines : Number($('#ways-number')?.value || selectedWays);
  const sets = Math.floor(totalLines / ways);
  return { cacheKB, blockBytes, selectedWays, totalLines, ways, sets };
}

function isPowerOfTwo(value) {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

function updateGeometry() {
  const geometry = getGeometry();
  const error = $('#geometry-error');
  if (results && Object.keys(geometry).some((key) => geometry[key] !== results.geometry[key])) {
    results = null;
    $('#results').classList.add('hidden');
    $('#empty-state').classList.remove('hidden');
    $('#export-button').disabled = true;
    $('#ask-ai').disabled = true;
    showToast('Cache geometry changed — rerun the benchmark to compare policies.');
  }
  const valid = Number.isFinite(geometry.cacheKB) && geometry.cacheKB > 0
    && Number.isFinite(geometry.blockBytes) && geometry.blockBytes > 0
    && Number.isInteger(geometry.cacheKB) && Number.isInteger(geometry.blockBytes)
    && Number.isInteger(geometry.ways)
    && geometry.totalLines <= 65536
    && isPowerOfTwo(geometry.blockBytes)
    && geometry.totalLines % geometry.ways === 0
    && isPowerOfTwo(geometry.sets)
    && geometry.totalLines >= 1 && geometry.ways >= 1 && geometry.ways <= geometry.totalLines;
  error.textContent = valid ? '' : geometry.totalLines > 65536
    ? 'Cache geometry is limited to 65,536 lines for responsive local simulation.'
    : 'Use a power-of-two block size and a whole-line geometry with power-of-two sets.';
  $('#run-benchmark').disabled = !valid || trace.length === 0;
  if (!valid) return false;
  $('#ways-number').disabled = geometry.selectedWays === 'fully';
  if (geometry.selectedWays === 'fully') $('#ways-number').value = geometry.totalLines;

  const offsetBits = Math.floor(Math.log2(geometry.blockBytes));
  const indexBits = Math.floor(Math.log2(Math.max(1, geometry.sets)));
  $('#offset-bits').textContent = `${offsetBits} b`;
  $('#index-bits').textContent = `${indexBits} b`;
  $('#tag-bits').textContent = `${Math.max(0, 32 - offsetBits - indexBits)} b`;
  $('#set-count').textContent = geometry.sets.toLocaleString();
  $('#ways-count').textContent = geometry.ways.toLocaleString();
  $('#line-count').textContent = (geometry.sets * geometry.ways).toLocaleString();
  updateRunCaption();
  return true;
}

function setGeometryValue(selectId, inputId, value) {
  $(selectId).value = value;
  $(inputId).value = value;
  updateGeometry();
}

function updateTraceCount() {
  $('#trace-count').textContent = `${trace.length.toLocaleString()} ${trace.length === 1 ? 'address' : 'addresses'}`;
  updateRunCaption();
  $('#run-benchmark').disabled = !trace.length || Boolean($('#geometry-error').textContent);
  if (results) {
    results = null;
    $('#results').classList.add('hidden');
    $('#empty-state').classList.remove('hidden');
    $('#export-button').disabled = true;
    $('#ask-ai').disabled = true;
  }
}

function updateRunCaption() {
  const count = trace.length.toLocaleString();
  $('#run-caption').textContent = `LRU · FIFO · LFU · Random · Belady OPT · AI — on ${count} ${trace.length === 1 ? 'access' : 'accesses'}`;
  $('#timeline-caption').textContent = `${count} accesses · click to inspect`;
}

function generateTrace(pattern, count, body, blockBytes) {
  const safeCount = Math.max(1, Math.min(50000, Math.floor(Number(count) || 1)));
  const safeBody = Math.max(1, Math.min(10000, Math.floor(Number(body) || 1)));
  let seed = 78321;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const addresses = [];
  for (let i = 0; i < safeCount; i++) {
    let block;
    switch (pattern) {
      case 'loop': block = i % safeBody; break;
      case 'sequential': block = i; break;
      case 'stride': block = (i % safeBody) * 16; break;
      case 'thrash': block = (i % safeBody) * 64; break;
      case 'working':
        block = random() < 0.8 ? Math.floor(random() * Math.max(1, Math.ceil(safeBody / 4))) : safeBody + Math.floor(random() * safeBody * 5);
        break;
      case 'random': block = Math.floor(random() * safeBody * 2); break;
      default: block = i % safeBody;
    }
    addresses.push((block * blockBytes) >>> 0);
  }
  return addresses;
}

function renderTraceTab() {
  const target = $('#trace-content');
  if (activeTraceTab === 'presets') {
    const preset = PRESETS[currentPreset];
    const isLoop = currentPreset === 'loop';
    target.innerHTML = `
      <select class="trace-select" id="preset-select" aria-label="Trace preset">
        ${Object.entries(PRESETS).map(([key, item]) => `<option value="${key}" ${key === currentPreset ? 'selected' : ''}>${escapeHTML(item.label)}</option>`).join('')}
      </select>
      <p class="trace-description">${escapeHTML(preset.description)}</p>
      <div class="trace-options">
        <label>COUNT<input id="preset-count" type="number" min="1" max="50000" value="${isLoop ? 512 : preset.count}"></label>
        <label>BODY (BLOCKS)<input id="preset-body" type="number" min="1" max="10000" value="${preset.body}"></label>
        <label>PASSES<input id="preset-passes" type="number" value="${Math.ceil((isLoop ? 512 : preset.count) / preset.body)}" disabled></label>
      </div>
      <div class="trace-row">
        <button class="button button-quiet generate-button" id="generate-trace">↻ <span>Generate trace</span></button>
        <button class="button button-quiet generate-button" id="save-current-trace">＋ <span>Save trace</span></button>
      </div>`;
    $('#preset-select').addEventListener('change', (event) => {
      currentPreset = event.target.value;
      renderTraceTab();
    });
    const updatePassCount = () => {
      const count = Math.max(1, Number($('#preset-count').value) || 1);
      const body = Math.max(1, Number($('#preset-body').value) || 1);
      $('#preset-passes').value = Math.ceil(count / body);
    };
    $('#preset-count').addEventListener('input', updatePassCount);
    $('#preset-body').addEventListener('input', updatePassCount);
    $('#generate-trace').addEventListener('click', () => {
      const count = Number($('#preset-count').value);
      const body = Number($('#preset-body').value);
      if (!Number.isInteger(count) || count < 1 || count > 50000 || !Number.isInteger(body) || body < 1 || body > 10000) {
        showToast('Enter a count from 1–50,000 and a body size from 1–10,000 blocks.', true);
        return;
      }
      trace = generateTrace(PRESETS[currentPreset].pattern, count, body, getGeometry().blockBytes);
      updateTraceCount();
      showToast(`${trace.length.toLocaleString()} address trace generated.`);
    });
    $('#save-current-trace').addEventListener('click', () => saveTrace(PRESETS[currentPreset].label));
  } else if (activeTraceTab === 'paste') {
    target.innerHTML = `
      <textarea class="trace-textarea" id="paste-addresses" placeholder="0x1000, 0x1040, 4160, …" aria-label="Paste memory addresses"></textarea>
      <p class="trace-help">Separate decimal or 0x-prefixed hexadecimal addresses with spaces, commas, or new lines. Maximum 50,000.</p>
      <div class="trace-row"><button class="button button-quiet" id="load-pasted">Load addresses</button><button class="button button-quiet" id="save-pasted" disabled>Save trace</button></div>`;
    $('#load-pasted').addEventListener('click', loadPastedTrace);
    $('#save-pasted').addEventListener('click', () => saveTrace('Pasted trace'));
    $('#paste-addresses').addEventListener('input', () => {
      $('#save-pasted').disabled = true;
    });
  } else {
    const saved = readSavedTraces();
    target.innerHTML = saved.length
      ? saved.map((item, index) => `<div class="saved-item"><div><strong>${escapeHTML(item.name)}</strong><small>${item.addresses.length.toLocaleString()} addresses</small></div><div><button class="small-button" data-load-saved="${index}">Load</button> <button class="small-button" data-delete-saved="${index}" aria-label="Delete ${escapeHTML(item.name)}">×</button></div></div>`).join('')
      : '<div class="saved-empty">No saved traces yet. Generate a pattern or paste addresses and save it here.</div>';
    $$('[data-load-saved]', target).forEach((button) => button.addEventListener('click', () => {
      const item = readSavedTraces()[Number(button.dataset.loadSaved)];
      if (item) { trace = item.addresses; updateTraceCount(); showToast(`Loaded ${item.name}.`); }
    }));
    $$('[data-delete-saved]', target).forEach((button) => button.addEventListener('click', () => {
      const list = readSavedTraces();
      list.splice(Number(button.dataset.deleteSaved), 1);
      writeSavedTraces(list);
      renderTraceTab();
    }));
  }
}

function loadPastedTrace() {
  const raw = $('#paste-addresses').value.trim();
  if (!raw) { showToast('Paste at least one memory address.', true); return; }
  const tokens = raw.split(/[\s,;]+/).filter(Boolean);
  if (tokens.length > 50000) { showToast('A trace can contain at most 50,000 addresses.', true); return; }
  const parsed = [];
  for (const token of tokens) {
    if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(token)) { showToast(`Invalid address: ${token}`, true); return; }
    const value = Number(token);
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) { showToast(`Address is outside the 32-bit address space: ${token}`, true); return; }
    parsed.push(value);
  }
  trace = parsed;
  updateTraceCount();
  $('#save-pasted').disabled = false;
  showToast(`${trace.length.toLocaleString()} addresses loaded.`);
}

function readSavedTraces() {
  try {
    const data = JSON.parse(localStorage.getItem('cacheoracle-traces') || '[]');
    return Array.isArray(data) ? data.filter((item) => item && typeof item.name === 'string' && Array.isArray(item.addresses)) : [];
  } catch (error) {
    console.warn('Unable to read saved traces.', error);
    showToast(`Unable to read saved traces: ${error.message}`, true);
    return [];
  }
}

function writeSavedTraces(items) {
  try {
    localStorage.setItem('cacheoracle-traces', JSON.stringify(items));
    return true;
  } catch (error) {
    showToast(`Could not save trace: ${error.message}`, true);
    return false;
  }
}

function saveTrace(defaultName = PRESETS[currentPreset]?.label || 'Custom trace') {
  const name = window.prompt('Name this trace:', defaultName);
  if (name === null) return;
  const cleanName = name.trim().slice(0, 60);
  if (!cleanName) { showToast('A saved trace needs a name.', true); return; }
  const saved = readSavedTraces();
  if (saved.length >= 20) { showToast('You can save up to 20 traces. Delete one before saving another.', true); return; }
  saved.push({ name: cleanName, addresses: [...trace] });
  if (writeSavedTraces(saved)) showToast(`Saved “${cleanName}”.`);
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function makeFutureLookup(blocks) {
  const positions = new Map();
  blocks.forEach((block, index) => {
    if (!positions.has(block)) positions.set(block, []);
    positions.get(block).push(index);
  });
  return (block, from) => {
    const hits = positions.get(block);
    if (!hits) return Infinity;
    let low = 0, high = hits.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (hits[mid] <= from) low = mid + 1;
      else high = mid;
    }
    return hits[low] ?? Infinity;
  };
}

function simulatePolicy(policy, addresses, geometry, stopAt = addresses.length - 1) {
  const { blockBytes, ways, sets } = geometry;
  const blocks = addresses.map((address) => Math.floor(address / blockBytes));
  const futureLookup = policy === "Belady's OPT" ? makeFutureLookup(blocks) : null;
  const cache = Array.from({ length: sets }, () => []);
  const transitions = new Map();
  const seen = new Set();
  let previousBlock = null;
  let seed = 4199;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const events = [];
  const total = Math.min(addresses.length, stopAt + 1);
  const faCache = new Map();
  const fullyAssociativeMisses = new Uint8Array(total);

  for (let i = 0; i < total; i++) {
    const block = blocks[i];
    if (faCache.has(block)) {
      faCache.delete(block);
      faCache.set(block, true);
    } else {
      fullyAssociativeMisses[i] = 1;
      faCache.set(block, true);
      if (faCache.size > geometry.totalLines) faCache.delete(faCache.keys().next().value);
    }
  }
  for (let i = 0; i < total; i++) {
    const block = blocks[i];
    const setIndex = sets > 0 ? block % sets : 0;
    const lines = cache[setIndex];
    const hitAt = lines.findIndex((line) => line.block === block);
    const hit = hitAt >= 0;
    const firstTouch = !seen.has(block);
    const optWouldMiss = fullyAssociativeMisses[i] === 1;
    let victim = null;
    let missType = '';
    if (!hit) {
      if (firstTouch) missType = 'compulsory';
      else if (optWouldMiss) missType = 'capacity';
      else missType = 'conflict';
      if (lines.length >= ways) {
        let victimAt = 0;
        if (policy === 'LRU') victimAt = lines.reduce((best, line, index) => line.last < lines[best].last ? index : best, 0);
        else if (policy === 'FIFO') victimAt = lines.reduce((best, line, index) => line.inserted < lines[best].inserted ? index : best, 0);
        else if (policy === 'LFU') victimAt = lines.reduce((best, line, index) => line.frequency < lines[best].frequency || (line.frequency === lines[best].frequency && line.last < lines[best].last) ? index : best, 0);
        else if (policy === "Belady's OPT") victimAt = lines.reduce((best, line, index) => futureLookup(line.block, i) > futureLookup(lines[best].block, i) ? index : best, 0);
        else if (policy === 'Random') victimAt = Math.floor(random() * lines.length);
        else if (policy === 'AI Predictor') {
          const outgoing = previousBlock === null ? null : transitions.get(previousBlock);
          const totalTransitions = outgoing ? [...outgoing.values()].reduce((sum, value) => sum + value, 0) : 0;
          const probability = (candidate) => totalTransitions ? (outgoing.get(candidate) || 0) / totalTransitions : 0;
          victimAt = lines.reduce((best, line, index) => {
            const score = probability(line.block);
            const bestScore = probability(lines[best].block);
            return score < bestScore || (score === bestScore && line.last < lines[best].last) ? index : best;
          }, 0);
        }
        victim = lines[victimAt].block;
        lines.splice(victimAt, 1);
      }
      lines.push({ block, inserted: i, last: i, frequency: 0 });
    } else if (policy === 'LRU') {
      const [line] = lines.splice(hitAt, 1);
      line.last = i;
      lines.push(line);
    }
    if (hit) {
      const line = lines.find((item) => item.block === block);
      line.frequency += 1;
      line.last = i;
    }
    if (previousBlock !== null) {
      if (!transitions.has(previousBlock)) transitions.set(previousBlock, new Map());
      const targets = transitions.get(previousBlock);
      targets.set(block, (targets.get(block) || 0) + 1);
    }
    previousBlock = block;
    seen.add(block);
    events.push({
      index: i, address: addresses[i], block, set: setIndex, hit, victim, missType,
      capacityMiss: optWouldMiss
    });
  }
  return { events, hits: events.filter((event) => event.hit).length, misses: events.filter((event) => !event.hit).length };
}

function runBenchmark() {
  if (!updateGeometry() || trace.length === 0) return;
  const geometry = getGeometry();
  $('#run-benchmark').disabled = true;
  $('#run-benchmark').innerHTML = '◌ <span>Running benchmark…</span>';
  window.setTimeout(() => {
    try {
      const policyResults = {};
      for (const policy of POLICIES) policyResults[policy] = simulatePolicy(policy, trace, geometry);
      const optimalEvents = policyResults["Belady's OPT"].events;
      for (const policy of POLICIES) {
        policyResults[policy].events.forEach((event, index) => { event.optWouldMiss = !optimalEvents[index].hit; });
      }
      results = { policies: policyResults, geometry, accesses: trace.length };
      selectedStep = 0;
      selectedAccess = -1;
      $('#empty-state').classList.add('hidden');
      $('#results').classList.remove('hidden');
      $('#export-button').disabled = false;
      $('#ask-ai').disabled = false;
      renderResults();
      $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
      showToast(`Benchmark complete — ${trace.length.toLocaleString()} accesses.`);
    } catch (error) {
      console.error('Benchmark failed.', error);
      showToast(`Benchmark failed: ${error.message}`, true);
    } finally {
      $('#run-benchmark').disabled = false;
      $('#run-benchmark').innerHTML = '▶ <span>Run benchmark</span>';
    }
  }, 35);
}

function renderResults() {
  if (!results) return;
  renderTimeline();
  $('#result-content').innerHTML = '';
  if (activeResultTab === 'comparison') renderComparison();
  else if (activeResultTab === 'step') renderStepThrough();
  else renderInsights();
  $$('.results-tabs .tab').forEach((tab) => {
    const active = tab.dataset.resultTab === activeResultTab;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
}

function renderTimeline() {
  const eventList = results.policies[selectedPolicy].events;
  const visible = Math.max(1, Math.ceil(eventList.length / zoom));
  const width = 1200;
  const height = 104;
  let rects = '';
  const plotCount = Math.min(visible, eventList.length);
  const bins = Math.min(plotCount, width);
  for (let bin = 0; bin < bins; bin++) {
    const start = Math.floor(bin * plotCount / bins);
    const end = Math.max(start + 1, Math.floor((bin + 1) * plotCount / bins));
    const group = eventList.slice(start, end);
    const hits = group.filter((item) => item.hit).length;
    const evictions = group.filter((item) => item.victim !== null).length;
    const optMisses = group.filter((item) => item.optWouldMiss).length;
    const x = bin * width / bins;
    const barWidth = Math.max(.65, width / bins - .45);
    const color = hits > group.length / 2 ? COLORS.LRU : (evictions ? '#ffbf5f' : COLORS[selectedPolicy]);
    const y = hits > group.length / 2 ? 37 : 20;
    const barHeight = hits > group.length / 2 ? 49 : 66;
    rects += `<rect x="${x.toFixed(2)}" y="${y}" width="${barWidth.toFixed(2)}" height="${barHeight}" rx=".7" fill="${color}" opacity="${hits > group.length / 2 ? '.74' : '.85'}"/>`;
    if (optMisses) rects += `<rect x="${x.toFixed(2)}" y="12" width="${barWidth.toFixed(2)}" height="4" fill="${COLORS["Belady's OPT"]}" opacity=".75"/>`;
  }
  const playIndex = selectedAccess >= 0 ? selectedAccess : selectedStep;
  const playX = (playIndex / visible) * width;
  const playhead = playIndex < visible ? `<line x1="${playX}" y1="5" x2="${playX}" y2="98" stroke="#09d7e8" stroke-width="2"/><circle cx="${playX}" cy="5" r="3" fill="#09d7e8"/>` : '';
  $('#timeline').innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Timeline of ${visible} cache accesses">${[20, 45, 70, 95].map((y) => `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="rgba(120,150,180,.12)" stroke-width="1"/>`).join('')}${rects}${playhead}</svg>`;
  $('#timeline-policy').textContent = selectedPolicy;
  $('#timeline-caption').textContent = `${visible.toLocaleString()} of ${eventList.length.toLocaleString()} accesses · click to inspect`;
  $('#timeline').onclick = (event) => {
    const bounds = $('#timeline').getBoundingClientRect();
    const index = Math.min(visible - 1, Math.max(0, Math.floor(((event.clientX - bounds.left) / bounds.width) * visible)));
    selectedAccess = index;
    selectedStep = index;
    const row = eventList[index];
    const description = row.hit
      ? `Access ${index + 1} · address 0x${row.address.toString(16).toUpperCase()} · HIT in set ${row.set}.`
      : `Access ${index + 1} · address 0x${row.address.toString(16).toUpperCase()} · MISS (${row.missType})${row.victim === null ? '' : ` · evicted block ${formatBlock(row.victim)}`}.`;
    $('#timeline-inspector').textContent = description;
    $('#timeline-inspector').classList.remove('hidden');
    renderTimeline();
  };
  $$('.zoom-control button').forEach((button) => {
    button.classList.toggle('active', Number(button.dataset.zoom) === zoom);
    button.onclick = () => { zoom = Number(button.dataset.zoom); renderTimeline(); };
  });
}

function renderComparison() {
  const cards = POLICIES.map((policy) => {
    const result = results.policies[policy];
    const rate = result.hits / results.accesses * 100;
    const evictions = result.events.filter((event) => event.victim !== null).length;
    const missTypes = countMisses(result.events);
    const optRate = results.policies["Belady's OPT"].hits / results.accesses * 100;
    const convergence = optRate ? Math.min(100, Math.round(rate / optRate * 100)) : 100;
    const tag = policy === "Belady's OPT" ? 'UPPER BOUND' : policy === 'AI Predictor' ? 'ML MODEL' : '';
    return `<button class="policy-card ${policy === selectedPolicy ? 'selected' : ''}" data-policy="${escapeHTML(policy)}">
      <div class="policy-top"><span class="policy-name">${escapeHTML(policy)}</span><span class="policy-badge">${tag}</span></div>
      <div class="policy-hit">${rate.toFixed(1)}<small>% hit</small></div>
      <div class="policy-stats">${result.hits.toLocaleString()} hits / ${result.misses.toLocaleString()} misses · ${evictions.toLocaleString()} evictions</div>
      <div class="convergence"><span>OPT CONVERGENCE</span><strong>${convergence}%</strong></div>
      <div class="miss-types"><span>C1 ${missTypes.compulsory}</span><span>C2 ${missTypes.capacity}</span><span>C3 ${missTypes.conflict}</span></div>
    </button>`;
  }).join('');
  $('#result-content').innerHTML = `
    <div class="policy-grid">${cards}</div>
    <div class="chart-grid">
      <section class="chart-card"><h3 class="chart-title">Hit rate by policy</h3><p class="chart-subtitle">Higher is better. Belady's OPT is the theoretical ceiling.</p><div class="chart" id="hit-rate-chart"></div></section>
      <section class="chart-card"><h3 class="chart-title">Miss anatomy (3C)</h3><p class="chart-subtitle">Compulsory first-touch, capacity and conflict misses per policy.</p><div class="chart" id="miss-chart"></div></section>
    </div>`;
  $$('[data-policy]').forEach((card) => card.addEventListener('click', () => {
    selectedPolicy = card.dataset.policy;
    renderResults();
  }));
  drawHitRateChart();
  drawMissChart();
}

function countMisses(events) {
  return events.reduce((total, event) => {
    if (!event.hit && event.missType) total[event.missType] += 1;
    return total;
  }, { compulsory: 0, capacity: 0, conflict: 0 });
}

function drawHitRateChart() {
  const width = 540, rowHeight = 31, top = 12, left = 112;
  const chartHeight = top + POLICIES.length * rowHeight + 15;
  let content = '';
  for (let tick = 0; tick <= 100; tick += 25) {
    const x = left + (width - left - 12) * tick / 100;
    content += `<line class="grid-line" x1="${x}" y1="${top - 3}" x2="${x}" y2="${chartHeight - 9}"/><text class="chart-tick" x="${x}" y="${chartHeight + 4}" text-anchor="middle">${tick}</text>`;
  }
  POLICIES.forEach((policy, index) => {
    const rate = results.policies[policy].hits / results.accesses * 100;
    const y = top + index * rowHeight;
    const barWidth = (width - left - 12) * rate / 100;
    content += `<text class="chart-label" x="${left - 8}" y="${y + 13}" text-anchor="end">${escapeHTML(policy)}</text><rect x="${left}" y="${y}" width="${barWidth}" height="17" rx="4" fill="${COLORS[policy]}" opacity=".86"/><text class="chart-label" x="${left + barWidth + 6}" y="${y + 13}">${rate.toFixed(1)}%</text>`;
  });
  $('#hit-rate-chart').innerHTML = `<svg viewBox="0 0 ${width} ${chartHeight + 10}" role="img" aria-label="Hit rate comparison chart">${content}</svg>`;
}

function drawMissChart() {
  const width = 540, rowHeight = 31, top = 12, left = 112;
  const chartHeight = top + POLICIES.length * rowHeight + 15;
  const misses = POLICIES.map((policy) => countMisses(results.policies[policy].events));
  const maximum = Math.max(1, ...misses.map((item) => item.compulsory + item.capacity + item.conflict));
  let content = '';
  for (let tick = 0; tick <= 4; tick++) {
    const value = maximum * tick / 4;
    const x = left + (width - left - 12) * tick / 4;
    content += `<line class="grid-line" x1="${x}" y1="${top - 3}" x2="${x}" y2="${chartHeight - 9}"/><text class="chart-tick" x="${x}" y="${chartHeight + 4}" text-anchor="middle">${Math.round(value)}</text>`;
  }
  POLICIES.forEach((policy, index) => {
    const item = misses[index];
    const y = top + index * rowHeight;
    const factor = (width - left - 12) / maximum;
    const compulsory = item.compulsory * factor, capacity = item.capacity * factor, conflict = item.conflict * factor;
    content += `<text class="chart-label" x="${left - 8}" y="${y + 13}" text-anchor="end">${escapeHTML(policy)}</text><rect x="${left}" y="${y}" width="${compulsory}" height="17" rx="3" fill="#09d7e8"/><rect x="${left + compulsory}" y="${y}" width="${capacity}" height="17" fill="#ffbf5f"/><rect x="${left + compulsory + capacity}" y="${y}" width="${conflict}" height="17" rx="3" fill="#ab8cff"/>`;
  });
  $('#miss-chart').innerHTML = `<svg viewBox="0 0 ${width} ${chartHeight + 10}" role="img" aria-label="Compulsory, capacity, conflict miss chart">${content}</svg><div class="miss-types"><span style="color:#09d7e8">■ Compulsory</span><span style="color:#ffbf5f">■ Capacity</span><span style="color:#ab8cff">■ Conflict</span></div>`;
}

function renderStepThrough() {
  const result = results.policies[selectedPolicy];
  selectedStep = Math.min(selectedStep, result.events.length - 1);
  const event = result.events[selectedStep];
  const setLines = simulateSnapshot(selectedPolicy, selectedStep);
  const outcome = event.hit ? '<span style="color:var(--green)">HIT</span>' : '<span style="color:var(--red)">MISS</span>';
  const cause = event.hit ? 'The requested block was already resident in this set.' : `${event.missType[0].toUpperCase()}${event.missType.slice(1)} miss — the block was not present in this set.`;
  const victimText = event.victim === null ? 'No eviction' : `Block ${formatBlock(event.victim)} evicted`;
  $('#result-content').innerHTML = `
    <section class="step-card">
      <div class="step-head"><div><p class="eyebrow">ACCESS ${String(selectedStep + 1).padStart(4, '0')}</p><h3>${outcome} <span class="subtle">· ${escapeHTML(selectedPolicy)}</span></h3><div class="step-position">of ${result.events.length.toLocaleString()} memory references</div></div>
        <div class="step-controls"><button id="step-first" aria-label="First access" title="First access">|‹</button><button id="step-prev" aria-label="Previous access" title="Previous access">‹</button><button id="step-next" aria-label="Next access" title="Next access">›</button><button id="step-last" aria-label="Last access" title="Last access">›|</button></div>
      </div>
      <div class="trace-row"><label class="field-label" for="step-policy">POLICY</label><select class="trace-select" id="step-policy">${POLICIES.map((name) => `<option ${name === selectedPolicy ? 'selected' : ''}>${escapeHTML(name)}</option>`).join('')}</select></div>
      <div class="step-address"><small>MEMORY ADDRESS</small><strong>0x${event.address.toString(16).toUpperCase().padStart(8, '0')}</strong></div>
      <div class="step-detail-grid">
        <div class="detail-box"><span>BLOCK</span><strong>${formatBlock(event.block)}</strong></div><div class="detail-box"><span>SET INDEX</span><strong>${event.set}</strong></div>
        <div class="detail-box"><span>RESULT</span><strong>${event.hit ? 'Cache hit' : 'Cache miss'}</strong></div><div class="detail-box"><span>EVICTION</span><strong>${victimText}</strong></div>
      </div>
      <p class="step-narrative">${cause} ${event.optWouldMiss ? "Belady's OPT also misses at this access." : "Belady's OPT has this block available at this access."}</p>
      <div class="cache-state"><h4>SET ${event.set} · RESIDENT BLOCKS (${setLines.length}/${results.geometry.ways})</h4>
        ${setLines.length ? `<table class="cache-table"><thead><tr><th>WAY</th><th>BLOCK</th><th>STATUS</th></tr></thead><tbody>${setLines.map((line, index) => `<tr><td>${index}</td><td class="cache-line">${formatBlock(line.block)}</td><td>${line.block === event.block ? 'Referenced' : 'Resident'}</td></tr>`).join('')}</tbody></table>` : '<p class="trace-help">No blocks are resident in this set yet.</p>'}
      </div>
    </section>`;
  $('#step-policy').addEventListener('change', (change) => {
    selectedPolicy = change.target.value;
    renderResults();
  });
  $('#step-first').onclick = () => moveStep(0);
  $('#step-prev').onclick = () => moveStep(Math.max(0, selectedStep - 1));
  $('#step-next').onclick = () => moveStep(Math.min(result.events.length - 1, selectedStep + 1));
  $('#step-last').onclick = () => moveStep(result.events.length - 1);
}

function simulateSnapshot(policy, atIndex) {
  const { blockBytes, ways, sets } = results.geometry;
  const cache = Array.from({ length: sets }, () => []);
  const transitions = new Map();
  const blocks = trace.slice(0, atIndex + 1).map((address) => Math.floor(address / blockBytes));
  const futureLookup = policy === "Belady's OPT" ? makeFutureLookup(blocks) : null;
  let previous = null;
  let seed = 4199;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const lines = cache[block % sets];
    let hit = lines.findIndex((line) => line.block === block);
    if (hit < 0) {
      if (lines.length >= ways) {
        let victimAt = 0;
        if (policy === 'LRU') victimAt = lines.reduce((best, line, index) => line.last < lines[best].last ? index : best, 0);
        else if (policy === 'FIFO') victimAt = lines.reduce((best, line, index) => line.inserted < lines[best].inserted ? index : best, 0);
        else if (policy === 'LFU') victimAt = lines.reduce((best, line, index) => line.frequency < lines[best].frequency || (line.frequency === lines[best].frequency && line.last < lines[best].last) ? index : best, 0);
        else if (policy === "Belady's OPT") victimAt = lines.reduce((best, line, index) => futureLookup(line.block, i) > futureLookup(lines[best].block, i) ? index : best, 0);
        else if (policy === 'Random') victimAt = Math.floor(random() * lines.length);
        else if (policy === 'AI Predictor') {
          const outgoing = previous === null ? null : transitions.get(previous);
          const total = outgoing ? [...outgoing.values()].reduce((sum, value) => sum + value, 0) : 0;
          const probability = (candidate) => total ? (outgoing.get(candidate) || 0) / total : 0;
          victimAt = lines.reduce((best, line, index) => probability(line.block) < probability(lines[best].block) || (probability(line.block) === probability(lines[best].block) && line.last < lines[best].last) ? index : best, 0);
        }
        lines.splice(victimAt, 1);
      }
      lines.push({ block, inserted: i, last: i, frequency: 0 });
    } else if (policy === 'LRU') {
      const [line] = lines.splice(hit, 1); line.last = i; lines.push(line);
    }
    if (hit >= 0 || lines.some((line) => line.block === block && line.frequency > 0)) {
      const line = lines.find((item) => item.block === block);
      line.frequency += 1; line.last = i;
    }
    if (previous !== null) {
      if (!transitions.has(previous)) transitions.set(previous, new Map());
      const map = transitions.get(previous); map.set(block, (map.get(block) || 0) + 1);
    }
    previous = block;
  }
  return cache[Math.floor(trace[atIndex] / blockBytes) % sets].map((line) => ({ ...line }));
}

function buildInsightsHTML() {
  const ai = results.policies['AI Predictor'];
  const opt = results.policies["Belady's OPT"];
  const lru = results.policies.LRU;
  const rate = (item) => item.hits / results.accesses * 100;
  const gap = Math.max(0, rate(opt) - rate(ai));
  const bestPractical = POLICIES.filter((name) => name !== "Belady's OPT").sort((a, b) => results.policies[b].hits - results.policies[a].hits)[0];
  const best = results.policies[bestPractical];
  const aiMisses = countMisses(ai.events);
  const compulsoryPct = ai.misses ? aiMisses.compulsory / ai.misses * 100 : 0;
  const geometry = results.geometry;
  const cards = [
    ['↗', 'Predictor vs. optimal', `The online Markov predictor achieved <span class="insight-highlight">${rate(ai).toFixed(1)}%</span> hit rate, ${gap.toFixed(1)} percentage points below Belady's offline upper bound (${rate(opt).toFixed(1)}%). It makes decisions using observed transitions, not future knowledge.`],
    ['◈', 'Best practical policy', `<span class="insight-highlight">${bestPractical}</span> leads the implementable policies with ${rate(best).toFixed(1)}% hits (${best.hits.toLocaleString()} of ${results.accesses.toLocaleString()} accesses).`],
    ['⌗', 'Why misses happen', `${compulsoryPct.toFixed(1)}% of AI predictor misses are compulsory first touches. ${aiMisses.capacity} are capacity misses and ${aiMisses.conflict} are conflict misses under the configured mapping.`],
    ['▤', 'Geometry check', `This cache has ${geometry.totalLines.toLocaleString()} lines across ${geometry.sets.toLocaleString()} sets (${geometry.ways}-way, ${geometry.blockBytes}-byte blocks). The selected trace references ${new Set(trace.map((address) => Math.floor(address / geometry.blockBytes))).size.toLocaleString()} unique blocks.`],
    ['⌁', 'Locality signal', `LRU recorded ${lru.hits.toLocaleString()} hits. A large sequential trace may benefit from scan-resistant policies; repeated short loops generally reward strong temporal locality.`],
    ['◎', 'Experiment tip', `Try changing associativity or block size and rerunning the same trace. Compare the miss anatomy to separate mapping conflicts from a cache that is simply too small.`]
  ];
  return `<div class="insight-grid">${cards.map(([icon, title, copy]) => `<article class="insight-card"><span class="insight-icon">${icon}</span><h3>${title}</h3><p>${copy}</p></article>`).join('')}</div>`;
}

function renderInsights() {
  $('#result-content').innerHTML = buildInsightsHTML();
}

function moveStep(index) {
  selectedStep = index;
  selectedAccess = index;
  renderResults();
}

function formatBlock(block) { return `0x${block.toString(16).toUpperCase()}`; }

function exportCSV() {
  if (!results) return;
  const rows = [['policy', 'accesses', 'hits', 'misses', 'hit_rate_percent', 'evictions', 'compulsory_misses', 'capacity_misses', 'conflict_misses']];
  for (const policy of POLICIES) {
    const result = results.policies[policy];
    const categories = countMisses(result.events);
    rows.push([policy, results.accesses, result.hits, result.misses, (result.hits / results.accesses * 100).toFixed(2), result.events.filter((event) => event.victim !== null).length, categories.compulsory, categories.capacity, categories.conflict]);
  }
  downloadFile('cacheoracle-benchmark.csv', rows.map((row) => row.map(csvCell).join(',')).join('\r\n'), 'text/csv');
  showToast('Benchmark exported as CSV.');
}

function csvCell(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showAIReadout() {
  if (!results) return;
  $('#ai-dialog-content').innerHTML = buildInsightsHTML();
  $('#ai-dialog').showModal();
}

function showToast(message, isError = false) {
  const toast = document.createElement('div');
  toast.className = `toast${isError ? ' error' : ''}`;
  toast.textContent = message;
  $('#toast-region').append(toast);
  window.setTimeout(() => toast.remove(), 3600);
}

function initialise() {
  const savedTheme = localStorage.getItem('cacheoracle-theme');
  if (savedTheme === 'light') document.body.classList.add('light');
  $('#theme-toggle').addEventListener('click', () => {
    document.body.classList.toggle('light');
    localStorage.setItem('cacheoracle-theme', document.body.classList.contains('light') ? 'light' : 'dark');
  });
  $('#cache-size').addEventListener('change', (event) => setGeometryValue('#cache-size', '#cache-size-number', event.target.value));
  $('#cache-size-number').addEventListener('change', (event) => setGeometryValue('#cache-size', '#cache-size-number', event.target.value));
  $('#block-size').addEventListener('change', (event) => setGeometryValue('#block-size', '#block-size-number', event.target.value));
  $('#block-size-number').addEventListener('change', (event) => setGeometryValue('#block-size', '#block-size-number', event.target.value));
  $('#associativity').addEventListener('change', (event) => {
    $('#ways-number').disabled = event.target.value === 'fully';
    if (event.target.value !== 'fully') $('#ways-number').value = event.target.value;
    updateGeometry();
  });
  $('#ways-number').addEventListener('change', updateGeometry);
  $$('[data-trace-tab]').forEach((tab) => tab.addEventListener('click', () => {
    activeTraceTab = tab.dataset.traceTab;
    $$('[data-trace-tab]').forEach((item) => {
      const active = item === tab;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', String(active));
    });
    renderTraceTab();
  }));
  $$('[data-result-tab]').forEach((tab) => tab.addEventListener('click', () => {
    activeResultTab = tab.dataset.resultTab;
    renderResults();
  }));
  $('#run-benchmark').addEventListener('click', runBenchmark);
  $('#load-demo').addEventListener('click', runBenchmark);
  $('#export-button').addEventListener('click', exportCSV);
  $('#ask-ai').addEventListener('click', showAIReadout);
  $('.close-dialog').addEventListener('click', () => $('#ai-dialog').close());
  $('#ai-dialog').addEventListener('click', (event) => { if (event.target === $('#ai-dialog')) $('#ai-dialog').close(); });
  renderTraceTab();
  updateGeometry();
  updateTraceCount();
}

initialise();
