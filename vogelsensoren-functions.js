/***********************************************************************
 * IFRAME COMMUNICATION CONFIG
 ***********************************************************************/
const ALLOWED_PARENT_ORIGINS = [
  "https://alkmaar.digitaletweeling.nl",
  "https://dtp-alkmaar.azurewebsites.net",
  "https://dtp-alkmaar-accept.azurewebsites.net",
  "https://dtp-alkmaar-dev.azurewebsites.net",
  "http://localhost:5000"
];

// To do: Add API URL
const VS_API_BASE_URL = "https://vogelsensoren.178-105-33-246.sslip.io";

const VS_PERIOD_MAP = {
  'dag': 'day',
  'week': 'week',
  'maand': 'month',
  'jaar': 'year'
};

const ALLOWED_IFRAME_FUNCTIONS = ["mapClickEvent"];

let _parentOrigin = null;
let _parentWindow = null;

function isAllowedOrigin(origin) {
  return ALLOWED_PARENT_ORIGINS.includes(origin);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidMessageShape(data) {
  if (!isObject(data)) return false;
  if (data.type !== "functionCall") return false;
  if (typeof data.functionName !== "string") return false;
  if (!isObject(data.args)) return false;
  return true;
}

function replyToParent(payload) {
  if (!_parentWindow || !_parentOrigin) return;
  _parentWindow.postMessage(payload, _parentOrigin);
}

function sendToParent(payload) {
  replyToParent(payload);
}

/* Incoming message handler */
function mapClickEvent(args) {
  if (typeof args.x !== "number" || typeof args.y !== "number") {
    throw new Error("mapClickEvent vereist numerieke velden x en y.");
  }
  // If a sensorId is provided, filter to that sensor
  if (args.featureId) {
    vsSelectSensor(args.featureId);
  }
  return { ok: true, message: "mapClickEvent verwerkt.", received: args };
}

function executeAllowedFunction(functionName, args) {
  if (!ALLOWED_IFRAME_FUNCTIONS.includes(functionName)) {
    throw new Error("Functie niet toegestaan: " + functionName);
  }
  switch (functionName) {
    case "mapClickEvent": return mapClickEvent(args);
    default: throw new Error("Onbekende functie: " + functionName);
  }
}

window.addEventListener("message", (event) => {
  if (!isAllowedOrigin(event.origin)) return;
  _parentOrigin = event.origin;
  _parentWindow = event.source;

  const data = event.data;
  if (!isValidMessageShape(data)) {
    replyToParent({ type: "error", error: "Ongeldige berichtstructuur." });
    return;
  }
  if (!ALLOWED_IFRAME_FUNCTIONS.includes(data.functionName)) {
    replyToParent({ type: "error", error: "Functie niet toegestaan: " + data.functionName });
    return;
  }

  try {
    const result = executeAllowedFunction(data.functionName, data.args);
    replyToParent({ type: "functionResult", functionName: data.functionName, ok: true, result });
  } catch (error) {
    replyToParent({ type: "functionResult", functionName: data.functionName, ok: false, error: error.message });
  }
});


/***********************************************************************
 * API CLIENT
 ***********************************************************************/

async function vsApiFetch(path, params = {}) {
  const url = new URL(path, VS_API_BASE_URL);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, v);
    }
  }
  const headers = { 'ngrok-skip-browser-warning': 'true' };
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}

function vsApiGetPucStations() {
  return vsApiFetch('/stations/puc');
}

function vsApiGetDetectionsBySpecies(period = 'day') {
  return vsApiFetch('/detections/by-species', { period });
}

function vsApiGetDetectionsTimeseries({ period = 'year', bucket = 'month', species = null, stationId = null } = {}) {
  return vsApiFetch('/detections/timeseries', { period, bucket, species, station_id: stationId });
}


/***********************************************************************
 * BIRD SPECIES REFERENCE DATA (from bird_species.json)
 ***********************************************************************/

async function vsLoadBirdSpecies() {
  const res = await fetch('static/bird_species.json');
  if (!res.ok) throw new Error(`HTTP ${res.status} for static/bird_species.json`);
  const data = await res.json();
  const map = {};
  // Key by every name variant we might receive from the API,
  // since /detections/by-species returns BirdWeather's common name
  // (typically English, e.g. "Great Cormorant").
  for (const s of (data.species || [])) {
    for (const key of [s.common_name_en, s.bird_species_name, s.common_name_nl, s.scientific_name]) {
      if (key) map[key.toLowerCase()] = s;
    }
  }
  return map;
}


/***********************************************************************
 * VOGELSENSOREN PANEL FUNCTIONS
 * (from vogelsensoren-functions.js — adapted for iframe)
 ***********************************************************************/

document.addEventListener('DOMContentLoaded', async () => {
  window.vs = {};
  window.vs.currentTimePeriod = 'maand';
  window.vs.currentChartDuration = 'jaar';
  window.vs.currentSensor = null;
  window.vs.currentCategory = 'all';
  window.vs.previousPageNumber = 1;
  window.vs.previousPageId = 'vs_overview';
  window.vs.cameFromCategory = false;
  window.vs.currentBird = null;
  window.vs.chart = null;
  window.vs.sensors = [];
  window.vs.speciesByName = {};

  // Fetch bird species reference data from bird_species.json
  try {
    window.vs.speciesByName = await vsLoadBirdSpecies();
    console.log(`Loaded ${Object.keys(window.vs.speciesByName).length} species from bird_species.json.`);
  } catch (err) {
    console.warn('Failed to load bird_species.json:', err.message);
  }

  // Fetch live station data from API
  try {
    const json = await vsApiGetPucStations();
    window.vs.sensors = (json.stations || []).map(s => ({
      id: s.station_id,
      thing_id: s.id,
      name: s.name,
      type: 'BirdWeather PUC',
      lat: s.coordinates.lat,
      lng: s.coordinates.lon
    }));
    console.log(`Loaded ${window.vs.sensors.length} stations from API.`);
  } catch (err) {
    console.warn('Failed to fetch stations from API:', err.message);
  }

  vsUpdateOverview();
  console.log("Vogelsensoren iframe geladen en klaar.");
});


/* ============================================================
   PAGE NAVIGATION
   ============================================================ */

function vsShowPage({ pageId = null, pageNumber = null }) {
  const previousPage = document.getElementById(window.vs.previousPageId);

  if (window.vs.previousPageNumber < pageNumber) {
    previousPage.classList.remove('translate-x-100p');
    previousPage.classList.add('-translate-x-100p');
  } else if (window.vs.previousPageNumber > pageNumber) {
    previousPage.classList.remove('-translate-x-100p');
    previousPage.classList.add('translate-x-100p');
  }

  document.querySelectorAll('#vogelsensoren_panel .vs_page').forEach(page => {
    page.classList.remove('active');
  });

  if (pageId) {
    const page = document.getElementById(pageId);
    page?.classList.remove('translate-x-100p');
    page?.classList.remove('-translate-x-100p');
    page?.classList.add('active');
  }

  if (!pageNumber) {
    console.error('vsShowPage: no pageNumber provided, defaulting to 1');
    pageNumber = 1;
  }

  window.vs.previousPageNumber = pageNumber;
  window.vs.previousPageId = pageId;
}


/* ============================================================
   PANEL HEADER HELPERS
   ============================================================ */

function vsUpdatePanelHeader() {
  const titleEl = document.getElementById('vs_panel_title');
  const subtitleEl = document.getElementById('vs_panel_subtitle');

  if (window.vs.currentSensor) {
    const sensor = window.vs.sensors.find(s => s.id === window.vs.currentSensor);
    titleEl.textContent = sensor ? sensor.name : 'Sensor';
    subtitleEl.textContent = sensor ? sensor.type : '';
  } else {
    titleEl.textContent = 'Vogelsensoren';
    subtitleEl.textContent = window.vs.sensors.length + ' sensoren';
  }
}


/* ============================================================
   TIME PERIOD SELECTOR
   ============================================================ */

function vsSetTimePeriod(button, period) {
  window.vs.currentTimePeriod = period;

  document.querySelectorAll('.vs-time-btn').forEach(btn => {
    btn.classList.remove('active', 'bg-primary', 'text-white', 'border-primary');
    btn.classList.add('border-[#C6C6C6]');
  });
  button.classList.add('active', 'bg-primary', 'text-white', 'border-primary');
  button.classList.remove('border-[#C6C6C6]');

  vsUpdateOverview();
}


/* ============================================================
   OVERVIEW PAGE
   ============================================================ */

async function vsFetchDetections() {
  const apiPeriod = VS_PERIOD_MAP[window.vs.currentTimePeriod] || 'month';
  try {
    const data = await vsApiGetDetectionsBySpecies(apiPeriod);
    console.log(`Fetched ${data.species?.length || 0} species detections from API (${apiPeriod}).`);
    return data;
  } catch (err) {
    console.warn('Failed to fetch detections from API:', err.message);
    return null;
  }
}

function vsBuildMergedSpecies(apiSpecies) {
  const speciesByName = window.vs.speciesByName || {};

  return apiSpecies.map(apiItem => {
    const ref = speciesByName[apiItem.species.toLowerCase()] || {};
    return {
      name: ref.bird_species_name || apiItem.species,
      api_name: apiItem.species,
      scientific_name: ref.scientific_name || '',
      conservation_status: (!ref.red_list || ref.red_list === '-') ? 'Niet bedreigd' : ref.red_list,
      thumbnail: ref.image_url || '',
      image: ref.image_url || '',
      image_credit: ref.image_credit || '',
      image_license: ref.image_license || '',
      description: ref.description || '',
      habitat: ref.safety || '-',
      diet: ref.food || '-',
      size: ref.size || '-',
      external_url: ref.link || '',
      _liveCount: apiItem.count,
    };
  });
}

async function vsUpdateOverview() {
  vsUpdatePanelHeader();

  // Fetch live detection data from API
  const apiData = await vsFetchDetections();

  if (apiData && apiData.species) {
    window.vs.mergedSpecies = vsBuildMergedSpecies(apiData.species);
    window.vs.totalDetections = apiData.total_detections || 0;
  }

  const species = window.vs.mergedSpecies || [];
  const totalSpecies = species.length;
  const totalDetections = window.vs.totalDetections || species.reduce((sum, s) => sum + (s._liveCount || 0), 0);
  const redListSpecies = species.filter(s => s.conservation_status && s.conservation_status !== 'Niet bedreigd');

  document.getElementById('vs_stat_total_species').textContent = totalSpecies;
  document.getElementById('vs_stat_total_detections').textContent = totalDetections.toLocaleString('nl-NL');
  document.getElementById('vs_stat_red_species').textContent = redListSpecies.length;

  const sorted = [...species].sort((a, b) => (b._liveCount || 0) - (a._liveCount || 0));
  const top5 = sorted.slice(0, 5);
  const container = document.getElementById('vs_top5_list');
  container.innerHTML = '';
  top5.forEach(bird => {
    container.appendChild(vsCreateBirdRow(bird, false));
  });
}

function vsGetFilteredSpecies() {
  const allSpecies = window.vs.mergedSpecies || [];
  if (!window.vs.currentSensor) return allSpecies;
  return allSpecies.filter(s => s.sensors && s.sensors.includes(window.vs.currentSensor));
}

function vsGetDetectionCount(species) {
  return species._liveCount ?? 0;
}


/* ============================================================
   BIRD ROW COMPONENT
   ============================================================ */

function vsCreateBirdRow(bird, fromCategory) {
  const count = vsGetDetectionCount(bird);
  const statusLabel = vsGetStatusLabel(bird.conservation_status);
  const statusClass = vsGetStatusColorClass(bird.conservation_status);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.onclick = () => {
    window.vs.cameFromCategory = fromCategory;
    vsShowBirdDetail(bird);
  };
  btn.className = 'group flex items-center gap-12 p-12 shadow-[0_0_4px_rgba(0,0,0,0.15)] rounded-md w-full text-left hover:shadow-[0_0_8px_rgba(0,0,0,0.25)] transition-shadow duration-300';

  btn.innerHTML = `
    <img src="${bird.thumbnail || ''}" alt="${bird.name}"
      class="w-[64px] h-[64px] rounded-md object-cover flex-shrink-0 bg-[#f3f3f3]"
      onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 64 64%22><rect fill=%22%23f3f3f3%22 width=%2264%22 height=%2264%22/><text x=%2232%22 y=%2236%22 text-anchor=%22middle%22 font-size=%2224%22>&#x1F426;</text></svg>'">
    <div class="flex flex-col gap-2 flex-1 min-w-0">
      <span class="text-14 font-semibold truncate">${bird.name}</span>
      <span class="text-12 text-[#777777] italic truncate">${bird.scientific_name || ''}</span>
      <span class="text-10 px-6 py-2 rounded-full inline-block w-fit ${statusClass}">${statusLabel}</span>
    </div>
    <div class="flex items-center gap-8 flex-shrink-0">
      <span class="text-20 font-semibold">${count.toLocaleString('nl-NL')}</span>
      <i class="fa-solid fa-chevron-right text-14 text-[#777777] group-hover:text-primary transition-colors"></i>
    </div>
  `;

  return btn;
}

function vsFormatExternalUrl(url) {
  const name = url
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\..*$/, '');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function vsGetStatusLabel(status) {
  const labels = {
    'rode_lijst': 'Rode Lijst',
    'oranje_lijst': 'Oranje Lijst',
    'niet_bedreigd': 'Niet bedreigd',
    'kwetsbaar': 'Kwetsbaar',
    'bedreigd': 'Bedreigd',
    'ernstig_bedreigd': 'Ernstig bedreigd'
  };
  return labels[status] || status || 'Onbekend';
}

function vsGetStatusColorClass(status) {
  if (!status) return 'bg-[#9E9E9E1A] text-[#9E9E9E]';
  if (status === 'Niet bedreigd') return 'bg-[#2E7D321A] text-[#2E7D32]';
  return 'bg-[#CF0C121A] text-[#CF0C12]';
}


/* ============================================================
   CATEGORY LIST PAGE
   ============================================================ */

function vsShowCategoryList(category) {
  window.vs.currentCategory = category;

  const titles = {
    'all': 'Alle gedetecteerde soorten',
    'rode_lijst': 'Rode Lijst soorten',
    'oranje_lijst': 'Oranje Lijst soorten'
  };

  document.getElementById('vs_category_title').textContent = titles[category] || 'Soorten';

  const sensorLabel = window.vs.currentSensor
    ? (window.vs.sensors.find(s => s.id === window.vs.currentSensor)?.name || 'Sensor')
    : 'Alle Sensoren';
  document.getElementById('vs_category_subtitle').textContent = sensorLabel;

  let species = vsGetFilteredSpecies();
  if (category === 'rode_lijst') {
    species = species.filter(s => s.conservation_status && s.conservation_status !== 'Niet bedreigd');
  }

  species.sort((a, b) => vsGetDetectionCount(b) - vsGetDetectionCount(a));

  const container = document.getElementById('vs_category_species_list');
  container.innerHTML = '';
  species.forEach(bird => {
    container.appendChild(vsCreateBirdRow(bird, true));
  });

  vsShowPage({ pageId: 'vs_category_list', pageNumber: 2 });
}


/* ============================================================
   BIRD DETAIL PAGE
   ============================================================ */

function vsShowBirdDetail(bird) {
  window.vs.currentBird = bird;

  const backLabel = window.vs.cameFromCategory ? 'Terug naar soortenlijst' : 'Terug naar overzicht';
  document.getElementById('vs_detail_back_label').textContent = backLabel;

  document.getElementById('vs_detail_name').textContent = bird.name || '';
  document.getElementById('vs_detail_scientific_name').textContent = bird.scientific_name || '';
  document.getElementById('vs_detail_image').src = bird.image || bird.thumbnail || '';
  document.getElementById('vs_detail_image').alt = bird.name || '';

  const attrEl = document.getElementById('vs_image_attribution');
  const creditEl = document.getElementById('vs_image_credit');
  if (attrEl && creditEl) {
    if (bird.image_credit || bird.image_license) {
      const license = bird.image_license ? ` — ${bird.image_license}` : '';
      creditEl.innerHTML = `${bird.image_credit || ''}${license}`;
      attrEl.style.display = 'block';
    } else {
      creditEl.innerHTML = '';
      attrEl.style.display = 'none';
    }
  }

  document.getElementById('vs_detail_detection_count').textContent = vsGetDetectionCount(bird).toLocaleString('nl-NL');

  const periodLabels = { dag: 'dag', week: 'week', maand: 'maand', jaar: 'jaar' };
  document.getElementById('vs_detail_period_label').textContent = periodLabels[window.vs.currentTimePeriod] || 'maand';

  document.getElementById('vs_detail_description').textContent = bird.description || '';
  document.getElementById('vs_detail_habitat').textContent = bird.habitat || '-';
  document.getElementById('vs_detail_diet').textContent = bird.diet || '-';
  document.getElementById('vs_detail_size').textContent = bird.size || '-';
  document.getElementById('vs_detail_status').textContent = vsGetStatusLabel(bird.conservation_status);

  const linkEl = document.getElementById('vs_detail_external_link');
  const linkLabelEl = document.getElementById('vs_detail_external_link_label');
  if (bird.external_url) {
    linkEl.href = bird.external_url;
    if (linkLabelEl) {
      linkLabelEl.textContent = 'Meer informatie op ' + vsFormatExternalUrl(bird.external_url);
    }
    linkEl.classList.remove('!hidden');
    linkEl.style.display = 'flex';
  } else {
    linkEl.classList.add('!hidden');
    linkEl.style.display = 'none';
  }

  const sensorLabel = window.vs.currentSensor
    ? (window.vs.sensors.find(s => s.id === window.vs.currentSensor)?.name || 'Sensor')
    : 'Alle Sensoren';
  document.getElementById('vs_detail_datasource').textContent = sensorLabel;

  vsRenderChart(bird);
  vsShowPage({ pageId: 'vs_bird_detail', pageNumber: 3 });
}

function vsGoBackFromDetail() {
  if (window.vs.cameFromCategory) {
    vsShowPage({ pageId: 'vs_category_list', pageNumber: 2 });
  } else {
    vsShowPage({ pageId: 'vs_overview', pageNumber: 1 });
  }
}


/* ============================================================
   CHART (ApexCharts)
   ============================================================ */

function vsSetChartDuration(button, duration) {
  window.vs.currentChartDuration = duration;

  document.querySelectorAll('.vs-chart-btn').forEach(btn => {
    btn.classList.remove('active', 'bg-primary', 'text-white', 'border-primary');
    btn.classList.add('border-[#C6C6C6]');
  });
  button.classList.add('active', 'bg-primary', 'text-white', 'border-primary');
  button.classList.remove('border-[#C6C6C6]');

  if (window.vs.currentBird) {
    vsRenderChart(window.vs.currentBird);
  }
}

const VS_CHART_DURATION_MAP = {
  'week':  { period: 'week',       bucket: 'day' },
  'maand': { period: 'four_weeks', bucket: 'week' },
  'jaar':  { period: 'year',       bucket: 'month' },
};

const VS_BUCKET_LABEL_FORMATS = {
  hour:  { day: '2-digit', month: 'short', hour: '2-digit' },
  day:   { day: '2-digit', month: 'short' },
  week:  { day: '2-digit', month: 'short' },
  month: { month: 'short', year: '2-digit' },
};

function vsFormatBucketLabel(timestamp, bucket) {
  if (!timestamp) return '';
  const fmt = VS_BUCKET_LABEL_FORMATS[bucket] || VS_BUCKET_LABEL_FORMATS.day;
  return new Date(timestamp).toLocaleDateString('nl-NL', fmt);
}

async function vsFetchTimeseries(bird) {
  const duration = window.vs.currentChartDuration;
  const { period, bucket } = VS_CHART_DURATION_MAP[duration] || VS_CHART_DURATION_MAP.jaar;
  const sensor = window.vs.currentSensor
    ? window.vs.sensors.find(s => s.id === window.vs.currentSensor)
    : null;
  try {
    const data = await vsApiGetDetectionsTimeseries({
      period,
      bucket,
      species: bird.api_name || bird.name,
      stationId: sensor?.thing_id ?? null,
    });
    return {
      labels: (data.timeseries || []).map(p => vsFormatBucketLabel(p.timestamp, bucket)),
      values: (data.timeseries || []).map(p => p.detection_count),
    };
  } catch (err) {
    console.warn('Failed to fetch timeseries from API:', err.message);
    return null;
  }
}

async function vsRenderChart(bird) {
  const duration = window.vs.currentChartDuration;
  const live = await vsFetchTimeseries(bird);
  const categories = live?.labels ?? [];
  const values = live?.values ?? [];

  const titleMap = {
    'week':  'Detecties per dag \u2013 ' + bird.name,
    'maand': 'Detecties per week \u2013 ' + bird.name,
    'jaar':  'Detecties per maand \u2013 ' + bird.name
  };

  const options = {
    series: [{ name: 'Detecties', data: values }],
    chart: {
      height: 200,
      type: 'line',
      zoom: { enabled: false },
      toolbar: { show: false }
    },
    colors: ['#CF0C12'],
    dataLabels: { enabled: false },
    stroke: { curve: 'smooth', width: 2 },
    title: {
      text: titleMap[duration] || 'Detecties',
      align: 'left',
      style: { fontSize: '12px', fontWeight: 600 }
    },
    grid: {
      row: { colors: ['#f3f3f3', 'transparent'], opacity: 0.5 }
    },
    xaxis: {
      categories: categories,
      labels: { style: { fontSize: '10px' } }
    },
    yaxis: {
      title: { text: 'Aantal detecties', style: { fontSize: '10px' } },
      labels: { style: { fontSize: '10px' } }
    }
  };

  if (window.vs.chart) {
    window.vs.chart.destroy();
  }

  const chartContainer = document.getElementById('vs_detail_chart');
  chartContainer.innerHTML = '';

  if (typeof ApexCharts !== 'undefined') {
    window.vs.chart = new ApexCharts(chartContainer, options);
    window.vs.chart.render();
  } else {
    chartContainer.innerHTML = '<div class="text-12 text-[#777777] p-16 text-center">Grafiek niet beschikbaar</div>';
  }
}


/* ============================================================
   BIRD SOUND
   ============================================================ */

function vsPlayBirdSound() {
  const bird = window.vs.currentBird;
  if (!bird) return;

  if (bird.sound_url) {
    const audio = new Audio(bird.sound_url);
    audio.play().catch(() => {
      alert('Vogelroep kan niet worden afgespeeld.');
    });
  } else {
    alert('Vogelroep is niet beschikbaar voor deze soort.');
  }
}


/* ============================================================
   SENSOR SELECTION (called from map interaction)
   ============================================================ */

function vsSelectSensor(sensorId) {
  window.vs.currentSensor = sensorId || null;
  vsUpdateOverview();
  vsShowPage({ pageId: 'vs_overview', pageNumber: 1 });
}


/* ============================================================
   BIRD SOUND PLAYBACK
   ============================================================ */

(function () {
  const SOUNDS_DIR = 'bird_sounds';
  const PLAYABLE_STATUSES = new Set(['downloaded', 'exists']);
  const DEFAULT_LABEL = 'Vogelroep afspelen';
  const TRANSIENT_MS = 2000;

  let soundMap = {};
  let els = null;

  fetch(`${SOUNDS_DIR}/bird_sounds.json`)
    .then(r => r.json())
    .then(data => {
      soundMap = data;
      console.log('[BirdSounds] Loaded mapping for', Object.keys(data).length, 'species');
    })
    .catch(err => console.warn('[BirdSounds] Could not load bird_sounds.json:', err));

  function getEls() {
    if (els) return els;
    els = {
      audio: document.getElementById('vs_bird_audio'),
      icon: document.getElementById('vs_bird_sound_icon'),
      label: document.getElementById('vs_bird_sound_label'),
      attribution: document.getElementById('vs_bird_sound_attribution'),
      credit: document.getElementById('vs_bird_sound_credit'),
      scientificName: document.getElementById('vs_detail_scientific_name'),
    };
    els.audio.addEventListener('ended', resetButton);
    return els;
  }

  function resetButton() {
    const { icon, label } = getEls();
    icon.className = 'fa-solid fa-volume-high';
    label.textContent = DEFAULT_LABEL;
  }

  function flashLabel(text) {
    const { label } = getEls();
    label.textContent = text;
    setTimeout(() => { label.textContent = DEFAULT_LABEL; }, TRANSIENT_MS);
  }

  function showAttribution(entry) {
    const { attribution, credit } = getEls();
    const recordist = entry.recordist || 'unknown';
    const license = entry.license || 'unknown';
    const xcId = entry.xeno_canto_id || '';
    credit.textContent = `${recordist}, XC${xcId}, xeno-canto.org — ${license}`;
    attribution.style.display = 'block';
  }

  window.vsPlayBirdSound = function () {
    const { audio, icon, label, scientificName } = getEls();

    if (!audio.paused) {
      audio.pause();
      audio.currentTime = 0;
      resetButton();
      return;
    }

    const name = (scientificName?.textContent || '').trim();
    if (!name) return flashLabel('Geen soort geselecteerd');

    const entry = soundMap[name];
    if (!entry?.filename || !PLAYABLE_STATUSES.has(entry.status)) {
      return flashLabel('Geen geluid beschikbaar');
    }

    audio.src = `${SOUNDS_DIR}/${entry.filename}`;
    audio.play()
      .then(() => {
        icon.className = 'fa-solid fa-stop';
        label.textContent = 'Stoppen';
        showAttribution(entry);
      })
      .catch(err => {
        console.warn('[BirdSounds] Playback error:', err);
        flashLabel('Afspelen mislukt');
      });
  };

  // Reset audio and hide attribution when navigating to a new bird
  function resetBirdSound() {
    const { audio, attribution } = getEls();
    if (audio) { audio.pause(); audio.currentTime = 0; }
    resetButton();
    if (attribution) attribution.style.display = 'none';
  }

  const nameEl = document.getElementById('vs_detail_scientific_name');
  if (nameEl) {
    new MutationObserver(resetBirdSound)
      .observe(nameEl, { childList: true, characterData: true, subtree: true });
  }
})();