const metricConfigs = {
  TX01: { label: "氣溫 (°C)", mode: "mean", color: "#5be4a8", index: 3 },
  PP01: { label: "降雨量 (mm)", mode: "sum", color: "#4ea3ff", index: 7 },
  RH01: { label: "相對濕度 (%)", mode: "mean", color: "#fcb97d", index: 4 },
  WD01: { label: "風速 (m/s)", mode: "mean", color: "#ff7eb6", index: 5 },
  SS01: { label: "日照時數 (hr)", mode: "sum", color: "#ffe066", index: 8 },
};

const dom = {
  countySelect: document.getElementById("countySelect"),
  stationSelect: document.getElementById("stationSelect"),
  rollupSelect: document.getElementById("rollupSelect"),
  rangeStart: document.getElementById("rangeStart"),
  rangeEnd: document.getElementById("rangeEnd"),
  rangeLabel: document.getElementById("rangeLabel"),
  status: document.getElementById("status"),
  chartTitle: document.getElementById("chartTitle"),
  loadBtn: document.getElementById("loadBtn"),
  clearBtn: document.getElementById("clearBtn"),
  tabs: Array.from(document.querySelectorAll("[data-tab-target]")),
  panels: Array.from(document.querySelectorAll(".tab-panel")),
  typhoonPathSelect: document.getElementById("typhoonPathSelect"),
  typhoonStatus: document.getElementById("typhoonStatus"),
  typhoonTable: document.getElementById("typhoonTable"),
  typhoonNameSelect: document.getElementById("typhoonNameSelect"),
  realtimeStatus: document.getElementById("realtimeStatus"),
  realtimeCounty: document.getElementById("realtimeCounty"),
  alertList: document.getElementById("alertList"),
  forecastSlots: document.getElementById("forecastSlots"),
  refreshRealtimeBtn: document.getElementById("refreshRealtimeBtn"),
  reloadAlertsBtn: document.getElementById("reloadAlertsBtn"),
  reloadForecastBtn: document.getElementById("reloadForecastBtn"),
  reloadLiveTyphoonBtn: document.getElementById("reloadLiveTyphoonBtn"),
  clearRealtimeBtn: document.getElementById("clearRealtimeBtn"),
  liveTyphoonMap: document.getElementById("liveTyphoonMap"),
  typhoonLiveList: document.getElementById("typhoonLiveList"),
};

let fileIndex = [];
let stationsMeta = [];
const charts = {};
const fileCache = new Map();
const dailyCache = new Map();

const typhoonState = {
  map: null,
  lineLayer: null,
  countyLayer: null,
  holiday: null,
  lines: {},
  nameMap: {},
  cityFlags: [],
  countiesGeo: null,
  selectedPath: null,
};

const realtimeState = {
  forecastCache: new Map(),
  alertCache: null,
  typhoonMap: null,
  typhoonLayer: null,
  countiesGeo: null,
};

const CWA_BASE = "https://faein.climate-quiz-yuchen.workers.dev/api/v1/rest/datastore";
const CWA_COUNTIES = [
  "基隆市",
  "臺北市",
  "新北市",
  "桃園市",
  "新竹縣",
  "新竹市",
  "苗栗縣",
  "臺中市",
  "彰化縣",
  "南投縣",
  "雲林縣",
  "嘉義縣",
  "嘉義市",
  "臺南市",
  "高雄市",
  "屏東縣",
  "宜蘭縣",
  "花蓮縣",
  "臺東縣",
  "澎湖縣",
  "金門縣",
  "連江縣",
];

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindTabs();
  bindEvents();
  await loadIndex();
  await loadStationsMeta();
  buildCountyOptions();
  updateRangeLabel();
  updateLoadButtonState();
  setStatus("請先選測站或縣市與時間區間，再點重新載入。");
  initTyphoonView();
  initRealtimeView();
}

function bindTabs() {
  dom.tabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tabTarget;
      dom.tabs.forEach((b) => b.classList.toggle("active", b === btn));
      dom.panels.forEach((p) => p.classList.toggle("active", p.dataset.tab === target));
      if (target === "typhoon") {
        // Leaflet needs a size refresh when container switches from display:none
        requestAnimationFrame(() => {
          ensureTyphoonMapSized();
        });
      } else if (target === "realtime") {
        requestAnimationFrame(() => {
          ensureRealtimeMapSized();
        });
      }
    });
  });
}

function bindEvents() {
  dom.rangeStart.addEventListener("input", syncRange);
  dom.rangeEnd.addEventListener("input", syncRange);
  dom.loadBtn.addEventListener("click", refreshChart);
  dom.clearBtn.addEventListener("click", clearChart);
  dom.countySelect.addEventListener("change", () => {
    buildStationOptions();
    updateRangeLabel();
    updateLoadButtonState();
  });
  dom.stationSelect.addEventListener("change", updateLoadButtonState);
  dom.rollupSelect.addEventListener("change", updateLoadButtonState);
  dom.typhoonPathSelect.addEventListener("change", () => {
    const pathVal = dom.typhoonPathSelect.value;
    buildTyphoonNameOptions(pathVal);
    renderTyphoonPath(pathVal, dom.typhoonNameSelect.value || null);
  });
  dom.typhoonNameSelect.addEventListener("change", () => {
    const pathVal = dom.typhoonPathSelect.value;
    renderTyphoonPath(pathVal, dom.typhoonNameSelect.value || null);
  });
  dom.realtimeCounty?.addEventListener("change", () => {
    loadForecast(dom.realtimeCounty.value);
  });
  dom.refreshRealtimeBtn?.addEventListener("click", refreshRealtimeAll);
  dom.reloadAlertsBtn?.addEventListener("click", loadWeatherAlerts);
  dom.reloadForecastBtn?.addEventListener("click", () => {
    if (dom.realtimeCounty?.value) {
      loadForecast(dom.realtimeCounty.value);
    }
  });
  dom.reloadLiveTyphoonBtn?.addEventListener("click", loadLiveTyphoon);
  dom.clearRealtimeBtn?.addEventListener("click", clearRealtimeDisplay);
}

async function loadIndex() {
  try {
    const res = await fetch("./data/fileIndex.json");
    fileIndex = await res.json();
    if (!Array.isArray(fileIndex) || !fileIndex.length) {
      setStatus("找不到索引檔，請先執行 scripts/build_file_index.js");
      return;
    }
    dom.rangeStart.max = fileIndex.length - 1;
    dom.rangeEnd.max = fileIndex.length - 1;
    dom.rangeStart.value = Math.max(0, fileIndex.length - 3);
    dom.rangeEnd.value = fileIndex.length - 1;
  } catch (err) {
    console.error(err);
    setStatus("讀取索引失敗");
  }
}

async function loadStationsMeta() {
  try {
    const res = await fetch("./data/stations_meta.json");
    if (!res.ok) return;
    stationsMeta = await res.json();
  } catch (err) {
    console.warn("stations_meta.json 讀取失敗，將不顯示縣市選單", err);
  } finally {
    buildStationOptions();
    updateLoadButtonState();
  }
}

function buildCountyOptions() {
  const counties = new Set(
    stationsMeta
      .filter((s) => !s.status || s.status === "existing")
      .map((s) => s.county)
      .filter(Boolean)
  );
  const options = ['<option value="*">全部縣市</option>'].concat(
    Array.from(counties)
      .sort()
      .map((c) => `<option value="${c}">${c}</option>`)
  );
  dom.countySelect.innerHTML = options.join("");
}

function buildStationOptions() {
  const county = dom.countySelect.value;
  let list = stationsMeta.filter((s) => !s.status || s.status === "existing");
  if (county && county !== "*") {
    list = list.filter((s) => s.county === county);
  }
  const options = ['<option value="*">全部測站（可能較慢）</option>'].concat(
    list
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((s) => `<option value="${s.id}">${s.id} ｜ ${s.name || ""}</option>`)
  );
  dom.stationSelect.innerHTML = options.join("");
}

function syncRange() {
  const start = Number(dom.rangeStart.value);
  const end = Number(dom.rangeEnd.value);
  if (start > end) {
    dom.rangeStart.value = end;
  }
  updateRangeLabel();
  updateLoadButtonState();
}

function updateRangeLabel() {
  if (!fileIndex.length) {
    dom.rangeLabel.textContent = "索引尚未載入";
    return;
  }
  const startIdx = Number(dom.rangeStart.value);
  const endIdx = Number(dom.rangeEnd.value);
  const start = fileIndex[startIdx];
  const end = fileIndex[endIdx];
  dom.rangeLabel.textContent = `${start.year}/${String(start.month).padStart(2, "0")} ~ ${end.year}/${String(end.month).padStart(2, "0")}`;
}

function setStatus(text) {
  dom.status.textContent = text;
}

function isSelectionReady() {
  if (!fileIndex.length) return false;
  const start = Number(dom.rangeStart.value);
  const end = Number(dom.rangeEnd.value);
  const hasValidRange = start <= end;
  const station = dom.stationSelect.value;
  const county = dom.countySelect.value;
  if (stationsMeta.length > 0) {
    const hasStation = station && station !== "*";
    const hasCounty = county && county !== "*";
    return hasValidRange && (hasStation || hasCounty);
  }
  return hasValidRange;
}

function updateLoadButtonState() {
  const ready = isSelectionReady();
  dom.loadBtn.disabled = !ready;
  if (!ready) {
    setStatus("請先選縣市或測站並設定時間範圍");
  }
}

async function refreshChart() {
  if (!isSelectionReady()) {
    setStatus("請先選測站/縣市與起迄範圍");
    updateLoadButtonState();
    return;
  }
  setStatus("載入中...");
  dom.loadBtn.disabled = true;
  try {
    const payload = await loadAllSeries();
    if (!payload.points || !payload.labels.length) {
      clearChart();
      setStatus("目前條件沒有有效資料（可能都是 -999x）");
      return;
    }
    renderCharts(payload);
    setStatus(`完成：${payload.points} 筆資料已匯總`);
  } catch (err) {
    console.error(err);
    setStatus("載入失敗，請檢查主控台與檔案路徑");
  } finally {
    dom.loadBtn.disabled = false;
  }
}

function clearChart() {
  Object.keys(charts).forEach((k) => {
    charts[k].destroy();
    delete charts[k];
  });
  dom.chartTitle.textContent = "已清空";
}

function resolveStations() {
  const pick = dom.stationSelect.value;
  if (pick && pick !== "*") {
    return new Set([pick]);
  }
  const county = dom.countySelect.value;
  if (!county || county === "*") return null;
  const ids = stationsMeta
    .filter((s) => (!s.status || s.status === "existing") && s.county === county)
    .map((s) => s.id);
  return ids.length ? new Set(ids) : null;
}

async function loadAllSeries() {
  const rollup = dom.rollupSelect.value;
  const metricKeys = Object.keys(metricConfigs);
  const bucketMap = new Map(metricKeys.map((k) => [k, new Map()]));
  const startIdx = Math.min(Number(dom.rangeStart.value), Number(dom.rangeEnd.value));
  const endIdx = Math.max(Number(dom.rangeStart.value), Number(dom.rangeEnd.value));
  const files = fileIndex.slice(startIdx, endIdx + 1);
  const allowedStations = resolveStations();
  let pointCount = 0;

  for (let i = 0; i < files.length; i += 1) {
    const f = files[i];
    setStatus(`讀取 ${f.file} (${i + 1}/${files.length})`);
    if (rollup === "day") {
      const ok = await tryParseDailyAll(f, metricKeys, allowedStations, bucketMap);
      if (ok) continue;
    }
    const url = resolveFileUrl(f.path);
    let text = fileCache.get(url);
    if (!text) {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`讀取失敗：${f.file} (${res.status})`);
      }
      text = await res.text();
      fileCache.set(url, text);
    }
    parseFileAll(text, metricKeys, rollup, allowedStations, bucketMap);
  }

  const keySet = new Set();
  for (const map of bucketMap.values()) {
    for (const key of map.keys()) keySet.add(key);
  }
  const sortedKeys = Array.from(keySet).sort();
  const labels = sortedKeys.map((k) => formatKey(k, rollup));

  const series = {};
  for (const metricKey of metricKeys) {
    const cfg = metricConfigs[metricKey];
    const map = bucketMap.get(metricKey);
    const data = sortedKeys.map((k) => {
      const b = map.get(k);
      if (!b || b.count === 0) return null;
      const val = cfg.mode === "sum" ? b.sum : b.sum / b.count;
      pointCount += b.count;
      return Number(val.toFixed(2));
    });
    series[metricKey] = {
      label: cfg.label,
      data,
      color: cfg.color,
      mode: cfg.mode,
    };
  }

  return {
    labels,
    series,
    points: pointCount,
  };
}

function parseFileAll(text, metricKeys, rollup, allowedStations, bucketMap) {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith("*") || line.startsWith("#")) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length <= 8) continue;
    const stno = parts[0];
    if (allowedStations && !allowedStations.has(stno)) continue;

    const rawTime = parts[1];
    const key = rollup === "hour" ? rawTime : rawTime.slice(0, 8);
    for (const metricKey of metricKeys) {
      const cfg = metricConfigs[metricKey];
      const value = Number(parts[cfg.index]);
      if (!Number.isFinite(value) || value <= -9000) continue;
      const bucket = bucketMap.get(metricKey).get(key) || { sum: 0, count: 0 };
      bucket.sum += value;
      bucket.count += 1;
      bucketMap.get(metricKey).set(key, bucket);
    }
  }
}

async function tryParseDailyAll(fileInfo, metricKeys, allowedStations, bucketMap) {
  const dailyPath = `./data/daily/${fileInfo.file.replace(".auto_hr.txt", ".daily.json")}`;
  let records = dailyCache.get(dailyPath);
  if (!records) {
    const res = await fetch(dailyPath);
    if (!res.ok) {
      return false;
    }
    records = await res.json();
    dailyCache.set(dailyPath, records);
  }
  for (const rec of records) {
    if (allowedStations && !allowedStations.has(rec.stno)) continue;
    for (const metricKey of metricKeys) {
      const cfg = metricConfigs[metricKey];
      const val = Number(rec[metricKey]);
      if (!Number.isFinite(val) || val <= -9000) continue;
      const key = rec.date;
      const bucket = bucketMap.get(metricKey).get(key) || { sum: 0, count: 0 };
      bucket.sum += val;
      bucket.count += 1;
      bucketMap.get(metricKey).set(key, bucket);
    }
  }
  return true;
}

function resolveFileUrl(rawPath) {
  try {
    return new URL(rawPath, window.location.origin + window.location.pathname).toString();
  } catch (_) {
    return rawPath;
  }
}

function formatKey(key, rollup) {
  if (rollup === "hour") {
    const year = key.slice(0, 4);
    const month = key.slice(4, 6);
    const day = key.slice(6, 8);
    const hour = key.slice(8, 10);
    return `${year}/${month}/${day} ${hour}:00`;
  }
  const year = key.slice(0, 4);
  const month = key.slice(4, 6);
  const day = key.slice(6, 8);
  return `${year}/${month}/${day}`;
}

function renderCharts(payload) {
  dom.chartTitle.textContent = `${payload.labels[0]} ~ ${payload.labels[payload.labels.length - 1]} ｜ 5 指標`;
  Object.entries(payload.series).forEach(([metricKey, ser]) => {
    const canvas = document.getElementById(`chart-${metricKey}`);
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dataset = {
      label: ser.label,
      data: ser.data,
      borderColor: ser.color,
      backgroundColor: hexToRgba(ser.color, 0.1),
      pointRadius: 0,
      pointHoverRadius: 3,
      tension: 0.15,
      fill: false,
    };
    if (charts[metricKey]) {
      charts[metricKey].data.labels = payload.labels;
      charts[metricKey].data.datasets = [dataset];
      charts[metricKey].update();
    } else {
      charts[metricKey] = new Chart(ctx, {
        type: "line",
        data: { labels: payload.labels, datasets: [dataset] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          interaction: { mode: "index", intersect: false },
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { maxRotation: 0, autoSkip: true }, grid: { color: "rgba(255,255,255,0.05)" } },
            y: { grid: { color: "rgba(255,255,255,0.08)" } },
          },
        },
      });
    }
  });
}

function hexToRgba(hex, alpha) {
  const parsed = hex.replace("#", "");
  const bigint = parseInt(parsed, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ----------------- 颱風視圖 -----------------

function colorByValue(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return "#ffffff";
  if (v <= 20) return "#1E90FF";
  if (v <= 40) return "#32CD32";
  if (v <= 60) return "#FFFF00";
  if (v <= 80) return "#FF8C00";
  return "#FF0000";
}

async function initTyphoonView() {
  typhoonState.map = L.map("typhoonMap", { zoomControl: true }).setView([23.5, 121], 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 10,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(typhoonState.map);

  try {
    await loadTyphoonAssets();
    buildTyphoonPathOptions();
    renderTyphoonPath("all");
    setTyphoonStatus("已載入颱風資料");
  } catch (err) {
    console.error(err);
    setTyphoonStatus("載入颱風資料失敗，請檢查 web/data/typhoon");
  }
}

async function loadTyphoonAssets() {
  const res = await fetch("./data/typhoon/holiday_paths.json");
  if (!res.ok) throw new Error("找不到 holiday_paths.json");
  typhoonState.holiday = await res.json();

  // optional: map English -> 中文名稱
  try {
    const r = await fetch("./data/typhoon/name_map.json");
    if (r.ok) {
      typhoonState.nameMap = await r.json();
    }
  } catch (_) {
    typhoonState.nameMap = {};
  }

  await Promise.all(
    typhoonState.holiday.paths.map(async (p) => {
      const resp = await fetch(`./data/typhoon/typhoon_lines_${p}.geojson`);
      if (!resp.ok) throw new Error(`缺少 typhoon_lines_${p}.geojson`);
      typhoonState.lines[p] = await resp.json();
    })
  );

  try {
    const r2 = await fetch("./data/typhoon/typhoon_cities.json");
    if (r2.ok) {
      typhoonState.cityFlags = await r2.json();
    }
  } catch (_) {
    typhoonState.cityFlags = [];
  }

  try {
    const r3 = await fetch("./data/typhoon/counties.geojson");
    if (r3.ok) {
      typhoonState.countiesGeo = await r3.json();
    }
  } catch (_) {
    typhoonState.countiesGeo = null;
  }
}

function buildTyphoonPathOptions() {
  const opts = ['<option value="all">全部路徑</option>'].concat(
    typhoonState.holiday.paths.map((p) => `<option value="${p}">路徑 ${p}</option>`)
  );
  dom.typhoonPathSelect.innerHTML = opts.join("");
  dom.typhoonPathSelect.value = "all";
  buildTyphoonNameOptions("all");
}

function buildTyphoonNameOptions(path) {
  const names = new Set();
  if (path === "all") {
    Object.values(typhoonState.lines).forEach((geo) => {
      geo.features.forEach((f) => {
        const name = f.properties?.TY_ID;
        if (name) names.add(name);
      });
    });
  } else {
    const geo = typhoonState.lines[path];
    if (geo && geo.features) {
      geo.features.forEach((f) => {
        const name = f.properties?.TY_ID;
        if (name) names.add(name);
      });
    }
  }
  const list = Array.from(names).sort();
  if (!list.length) {
    dom.typhoonNameSelect.innerHTML = '<option value="">此路徑無颱風名稱</option>';
    dom.typhoonNameSelect.disabled = true;
    return;
  }
  const options = ['<option value="">全部颱風</option>'].concat(
    list.map((n) => {
      const zh = typhoonState.nameMap[n] || n;
      return `<option value="${n}">${zh} (${n})</option>`;
    })
  );
  dom.typhoonNameSelect.innerHTML = options.join("");
  dom.typhoonNameSelect.disabled = false;
}

function renderTyphoonPath(path, typhoonName = null) {
  if (!typhoonState.map) return;
  const isAll = path === "all";
  if (!isAll && !typhoonState.lines[path]) return;
  typhoonState.selectedPath = path;

  if (typhoonState.lineLayer) {
    typhoonState.map.removeLayer(typhoonState.lineLayer);
  }

  let features = [];
  if (isAll) {
    typhoonState.holiday.paths.forEach((p) => {
      const geo = typhoonState.lines[p];
      if (!geo) return;
      features = features.concat(
        geo.features.filter((f) => {
          if (!typhoonName) return true;
          return (f.properties?.TY_ID || "").toString() === typhoonName;
        })
      );
    });
  } else {
    features = typhoonState.lines[path].features.filter((f) => {
      if (!typhoonName) return true;
      return (f.properties?.TY_ID || "").toString() === typhoonName;
    });
  }

  typhoonState.lineLayer = L.geoJSON(
    { type: "FeatureCollection", features },
    {
      style: (feature) => ({
        color: colorByValue(feature.properties?.Value),
        weight: 4,
        opacity: 0.85,
      }),
      onEachFeature: (feature, layer) => {
        const p = feature.properties || {};
        const zh = p.TY_ID ? typhoonState.nameMap[p.TY_ID] || p.TY_ID : "未知";
        const title = p.TY_ID ? `${zh} (${p.TY_ID})` : "未知";
        layer.bindTooltip(`<strong>${title} (${p.Year || ""})</strong><br/>放假機率：${p.Value ?? "N/A"}%`, {
          sticky: true,
        });
      },
    }
  ).addTo(typhoonState.map);

  try {
    const bounds = typhoonState.lineLayer.getBounds();
    if (bounds.isValid()) {
      typhoonState.map.fitBounds(bounds, { padding: [20, 20] });
    }
  } catch (_) {
    // ignore fit errors
  }

  renderTyphoonTable(path, typhoonName);
  const count = features.length;
  const displayName =
    typhoonName && typhoonState.nameMap[typhoonName]
      ? `${typhoonState.nameMap[typhoonName]} (${typhoonName})`
      : typhoonName || "";
  const pathLabel = isAll ? "全部路徑" : `路徑 ${path}`;
  setTyphoonStatus(`顯示${pathLabel}${displayName ? ` - ${displayName}` : ""}，共 ${count} 條軌跡`);
  ensureTyphoonMapSized();

  updateCountyLayer(path, typhoonName);
}

function renderTyphoonTable(path, typhoonName = null) {
  if (!typhoonState.holiday) return;
  const isAll = path === "all";
  const pathNum = isAll ? null : Number(path);
  let rows = [];

  if (typhoonName && typhoonState.cityFlags.length) {
    rows = typhoonState.cityFlags
      .filter((r) => (isAll || r.path === pathNum) && r.typhoon === typhoonName)
      .sort((a, b) => b.flag - a.flag)
      .map((r) => `<tr><td>${r.county}</td><td>${Number(r.flag).toFixed(1)}</td></tr>`);
  } else {
    if (isAll) {
      const byCounty = new Map();
      typhoonState.holiday.records.forEach((r) => {
        const prev = byCounty.get(r.county) || -Infinity;
        byCounty.set(r.county, Math.max(prev, Number(r.probability)));
      });
      rows = Array.from(byCounty.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([county, prob]) => `<tr><td>${county}</td><td>${prob.toFixed(1)}</td></tr>`);
    } else {
      rows = typhoonState.holiday.records
        .filter((r) => r.path === pathNum)
        .sort((a, b) => b.probability - a.probability)
        .slice(0, 20)
        .map(
          (r) =>
            `<tr><td>${r.county}</td><td>${Number(r.probability).toFixed(1)}</td></tr>`
        );
    }
  }

  dom.typhoonTable.innerHTML = rows.join("") || '<tr><td colspan="2">無資料</td></tr>';
}

function updateCountyLayer(path, typhoonName) {
  if (!typhoonState.countiesGeo || !typhoonState.map) return;
  if (typhoonState.countyLayer) {
    typhoonState.map.removeLayer(typhoonState.countyLayer);
  }
  const valueMap = new Map();
  const isAll = path === "all";
  const pathNum = isAll ? null : Number(path);

  if (typhoonName && typhoonState.cityFlags.length) {
    typhoonState.cityFlags.forEach((r) => {
      if (!isAll && r.path !== pathNum) return;
      if (r.typhoon !== typhoonName) return;
      // 標記有影響就給 100，沒有就跳過
      if (Number(r.flag) > 0) {
        valueMap.set(normalizeCountyName(r.county), 100);
      }
    });
  } else {
    if (isAll) {
      typhoonState.holiday.records.forEach((r) => {
        const prev = valueMap.get(r.county) || -Infinity;
        valueMap.set(normalizeCountyName(r.county), Math.max(prev, Number(r.probability)));
      });
    } else {
      typhoonState.holiday.records.forEach((r) => {
        if (r.path !== pathNum) return;
        valueMap.set(normalizeCountyName(r.county), Number(r.probability));
      });
    }
  }

  typhoonState.countyLayer = L.geoJSON(typhoonState.countiesGeo, {
    style: (feature) => {
      const name = feature.properties?.COUNTYNAME || feature.properties?.name;
      const val = valueMap.get(normalizeCountyName(name)) ?? 0;
      return {
        fillColor: colorByValue(val),
        color: "#4b5563",
        weight: 1,
        fillOpacity: 0.35,
      };
    },
    onEachFeature: (feature, layer) => {
      const name = feature.properties?.COUNTYNAME || feature.properties?.name;
      const val = valueMap.get(normalizeCountyName(name));
      const displayVal = val == null ? "無資料" : `${Number(val).toFixed(1)}%`;
      layer.bindTooltip(`${name}：${displayVal}`, { sticky: true });
    },
  }).addTo(typhoonState.map);
}

function normalizeCountyName(name) {
  if (!name) return "";
  let n = String(name).trim().replace(/臺/g, "台");
  const mapping = {
    台北縣: "新北市",
    臺北縣: "新北市",
    桃園市: "桃園縣",
    台中縣: "台中市",
    臺中縣: "台中市",
    台南縣: "台南市",
    臺南縣: "台南市",
    高雄縣: "高雄市",
  };
  return mapping[n] || n;
}

function setTyphoonStatus(text) {
  dom.typhoonStatus.textContent = text;
}

function ensureTyphoonMapSized() {
  if (!typhoonState.map) return;
  typhoonState.map.invalidateSize();
  if (typhoonState.lineLayer) {
    const bounds = typhoonState.lineLayer.getBounds();
    if (bounds && bounds.isValid()) {
      typhoonState.map.fitBounds(bounds, { padding: [20, 20] });
    }
  }
}

// ----------------- 定位並自動套用縣市 -----------------

function requestUserLocation() {
  if (!navigator.geolocation) {
    setRealtimeStatus("瀏覽器不支援定位，請手動選縣市。");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      setRealtimeStatus("定位成功，判斷所屬縣市中…");
      try {
        const county = await resolveCountyByPoint(longitude, latitude);
        if (county && dom.realtimeCounty) {
          dom.realtimeCounty.value = county;
          setRealtimeStatus(`已定位到 ${county}，自動載入資料。`);
          refreshRealtimeAll();
        } else {
          setRealtimeStatus("定位完成，但無法對應縣市，請手動選擇。");
        }
      } catch (err) {
        console.error(err);
        setRealtimeStatus("定位成功但對應縣市失敗，請手動選擇。");
      }
    },
    (err) => {
      console.warn("Geolocation error", err);
      setRealtimeStatus("無法取得定位，請手動選縣市。");
    },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
  );
}

async function ensureCountiesGeo() {
  if (realtimeState.countiesGeo) return realtimeState.countiesGeo;
  if (typhoonState.countiesGeo) {
    realtimeState.countiesGeo = typhoonState.countiesGeo;
    return realtimeState.countiesGeo;
  }
  const res = await fetch("./data/typhoon/counties.geojson");
  if (!res.ok) throw new Error("無法載入縣市邊界資料");
  realtimeState.countiesGeo = await res.json();
  return realtimeState.countiesGeo;
}

async function resolveCountyByPoint(lon, lat) {
  const geo = await ensureCountiesGeo();
  const features = geo.features || [];
  const pt = [Number(lon), Number(lat)];
  for (const f of features) {
    if (!f.geometry) continue;
    if (geometryContainsPoint(f.geometry, pt)) {
      const name = f.properties?.COUNTYNAME || f.properties?.name;
      if (name) return normalizeCountyName(name);
    }
  }
  return null;
}

function geometryContainsPoint(geom, pt) {
  if (!geom || !geom.type) return false;
  if (geom.type === "Polygon") {
    return polygonContainsPoint(geom.coordinates, pt);
  }
  if (geom.type === "MultiPolygon") {
    return geom.coordinates.some((poly) => polygonContainsPoint(poly, pt));
  }
  return false;
}

function polygonContainsPoint(rings, pt) {
  if (!rings || !rings.length) return false;
  const [x, y] = pt;
  const ring = rings[0];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// ----------------- 即時資料 -----------------

function initRealtimeView() {
  if (!dom.realtimeCounty) return;
  buildRealtimeCountyOptions();
  setRealtimeStatus("已使用 Cloudflare Proxy，直接點「更新全部」即可。");
  initRealtimeMap();
  requestUserLocation();
}

function buildRealtimeCountyOptions() {
  if (!dom.realtimeCounty) return;
  const opts = CWA_COUNTIES.map((c) => `<option value="${c}">${c}</option>`);
  dom.realtimeCounty.innerHTML = opts.join("");
  dom.realtimeCounty.value = "臺北市";
}

function setRealtimeStatus(text) {
  if (dom.realtimeStatus) {
    dom.realtimeStatus.textContent = text;
  }
}

function initRealtimeMap() {
  if (!dom.liveTyphoonMap || realtimeState.typhoonMap) return;
  realtimeState.typhoonMap = L.map("liveTyphoonMap", { zoomControl: true }).setView([23.5, 121], 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 10,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(realtimeState.typhoonMap);
}

function ensureRealtimeMapSized() {
  if (!realtimeState.typhoonMap) return;
  realtimeState.typhoonMap.invalidateSize();
  if (realtimeState.typhoonLayer) {
    const bounds = realtimeState.typhoonLayer.getBounds();
    if (bounds && bounds.isValid()) {
      realtimeState.typhoonMap.fitBounds(bounds, { padding: [20, 20] });
    }
  }
}

async function refreshRealtimeAll() {
  setRealtimeStatus("更新中...");
  const county = dom.realtimeCounty?.value || CWA_COUNTIES[0];
  try {
    await Promise.all([loadWeatherAlerts(), loadForecast(county), loadLiveTyphoon()]);
    setRealtimeStatus("已完成最新一次更新。");
  } catch (err) {
    console.error(err);
    setRealtimeStatus(err.message || "更新即時資料失敗");
  }
}

function clearRealtimeDisplay() {
  if (dom.alertList) dom.alertList.innerHTML = "";
  if (dom.forecastSlots) dom.forecastSlots.innerHTML = "";
  if (dom.typhoonLiveList) dom.typhoonLiveList.innerHTML = "";
  if (realtimeState.typhoonLayer && realtimeState.typhoonMap) {
    realtimeState.typhoonMap.removeLayer(realtimeState.typhoonLayer);
    realtimeState.typhoonLayer = null;
  }
  setRealtimeStatus("已清空資料。");
}

async function fetchCwaDataset(datasetId, params = {}) {
  const search = new URLSearchParams({ format: "JSON", ...params });
  const url = `${CWA_BASE}/${datasetId}?${search.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`無法取得 ${datasetId}（${res.status}）`);
  }
  const data = await res.json();
  if (data?.success === "false") {
    const msg = data?.result?.message || "CWA 回應錯誤";
    throw new Error(msg);
  }
  return data;
}

async function loadWeatherAlerts() {
  setRealtimeStatus("讀取天氣警特報...");
  try {
    const data = await fetchCwaDataset("W-C0033-001");
    const list = normalizeAlerts(data);
    renderAlerts(list);
    realtimeState.alertCache = list;
    setRealtimeStatus(list.length ? `已更新 ${list.length} 則警特報` : "目前無警特報。");
  } catch (err) {
    console.error(err);
    renderAlerts([]);
    setRealtimeStatus(err.message || "讀取警特報失敗");
  }
}

function normalizeAlerts(payload) {
  const records = payload?.records || payload?.Records || {};
  const list = [];
  const locs = records.location || records.locations || [];
  locs.forEach((loc) => {
    const hazards = loc.hazardConditions?.hazardCondition || loc.hazardCondition || loc.conditions || [];
    hazards.forEach((h) => {
      list.push({
        area: loc.locationName || loc.county || h.locationName || h.areaName || "全區",
        title: h.event || h.hazardDesc || h.hazardType || h.headline || "警特報",
        desc: h.description || h.hazardDesc || h.info || h.content || "",
        start: h.startTime || h.start || h.publishTime || h.time?.start,
        end: h.endTime || h.end || h.time?.end,
        severity: h.severity || h.significance || h.alertLevel,
      });
    });
  });
  const direct = records.alert || records.alerts;
  if (Array.isArray(direct)) {
    direct.forEach((h) => {
      list.push({
        area: h.areaName || h.locationName || "全區",
        title: h.title || h.headline || h.event || "警特報",
        desc: h.description || h.summary || "",
        start: h.startTime || h.publishTime,
        end: h.endTime,
        severity: h.severity || h.significance,
      });
    });
  }
  return list;
}

function renderAlerts(list) {
  if (!dom.alertList) return;
  if (!list.length) {
    dom.alertList.innerHTML = '<div class="alert-item">目前沒有警特報。</div>';
    dom.alertList.classList.add("ghost-status");
    return;
  }
  dom.alertList.classList.remove("ghost-status");
  dom.alertList.innerHTML = list
    .map((a) => {
      const range = formatTimeRange(a.start, a.end);
      return `<div class="alert-item">
        <h4 class="alert-title">${sanitizeText(a.title || "警特報")}</h4>
        <div class="alert-meta">
          ${a.area ? `<span class="badge">影響區：${sanitizeText(a.area)}</span>` : ""}
          ${a.severity ? `<span class="badge">${sanitizeText(a.severity)}</span>` : ""}
          ${range ? `<span>${sanitizeText(range)}</span>` : ""}
        </div>
        ${a.desc ? `<p class="alert-desc">${sanitizeText(a.desc)}</p>` : ""}
      </div>`;
    })
    .join("");
}

async function loadForecast(county) {
  if (!county) return;
  setRealtimeStatus(`讀取 ${county} 36 小時預報...`);
  try {
    const data = await fetchCwaDataset("F-C0032-001", { locationName: county });
    const slots = normalizeForecast(data, county);
    realtimeState.forecastCache.set(county, slots);
    renderForecast(slots, county);
    setRealtimeStatus(`已更新 ${county} 預報。`);
  } catch (err) {
    console.error(err);
    renderForecast([], county);
    setRealtimeStatus(err.message || `讀取 ${county} 預報失敗`);
  }
}

function normalizeForecast(payload, county) {
  const records = payload?.records || {};
  const locs = records.location || records.locations || [];
  const loc = locs.find((l) => l.locationName === county) || locs[0];
  if (!loc) return [];
  const elementMap = new Map();
  (loc.weatherElement || []).forEach((el) => {
    elementMap.set(el.elementName, el.time || []);
  });
  const lengths = Array.from(elementMap.values()).map((v) => v.length);
  const slotCount = lengths.length ? Math.max(...lengths) : 0;
  const slots = [];
  for (let i = 0; i < slotCount; i += 1) {
    slots.push({
      start: readElementTime(elementMap, i, "start"),
      end: readElementTime(elementMap, i, "end"),
      wx: readElementValue(elementMap, "Wx", i),
      pop: readElementValue(elementMap, "PoP12h", i) ?? readElementValue(elementMap, "PoP", i),
      minT: readElementValue(elementMap, "MinT", i) ?? readElementValue(elementMap, "T", i),
      maxT: readElementValue(elementMap, "MaxT", i),
      ci: readElementValue(elementMap, "CI", i),
      rh: readElementValue(elementMap, "RH", i),
      location: loc.locationName || county,
    });
  }
  return slots.filter((s) => s.start || s.wx || s.pop || s.minT || s.maxT);
}

function readElementTime(map, idx, key) {
  for (const arr of map.values()) {
    const slot = arr[idx];
    if (slot && (slot[`${key}Time`] || slot[`${key}time`] || slot[key] || slot.dataTime || slot.time)) {
      return slot[`${key}Time`] || slot[`${key}time`] || slot[key] || slot.dataTime || slot.time;
    }
  }
  return null;
}

function readElementValue(map, key, idx) {
  const arr = map.get(key);
  if (!arr || !arr[idx]) return null;
  const node = arr[idx];
  if (node.parameter) {
    return node.parameter.parameterName || node.parameter.parameterValue || node.parameter.value || null;
  }
  if (Array.isArray(node.elementValue) && node.elementValue.length) {
    const ev = node.elementValue[0];
    return ev.value ?? ev.elementValue ?? ev.measures ?? ev.parameterName ?? null;
  }
  if (node.value != null) return node.value;
  if (node.text) return node.text;
  return node.parameterName || null;
}

function renderForecast(slots, county) {
  if (!dom.forecastSlots) return;
  if (!slots.length) {
    dom.forecastSlots.innerHTML = '<div class="alert-item">找不到預報資料。</div>';
    dom.forecastSlots.classList.add("ghost-status");
    return;
  }
  dom.forecastSlots.classList.remove("ghost-status");
  dom.forecastSlots.innerHTML = slots
    .slice(0, 4)
    .map((s, idx) => {
      const range = formatTimeRange(s.start, s.end);
      return `<div class="forecast-card">
        <div class="forecast-header">
          <div>
            <div class="eyebrow">${sanitizeText(s.location || county)}</div>
            <div class="forecast-range">${sanitizeText(range || `時段 ${idx + 1}`)}</div>
          </div>
          ${s.wx ? `<span class="badge">${sanitizeText(s.wx)}</span>` : ""}
        </div>
        <div class="forecast-row"><span>降雨機率</span><span>${s.pop != null ? `${s.pop}%` : "—"}</span></div>
        <div class="forecast-row"><span>最高溫</span><span>${s.maxT != null ? `${s.maxT}°C` : "—"}</span></div>
        <div class="forecast-row"><span>最低溫</span><span>${s.minT != null ? `${s.minT}°C` : "—"}</span></div>
        <div class="forecast-row"><span>舒適度</span><span>${s.ci ?? "—"}</span></div>
        <div class="forecast-row"><span>相對濕度</span><span>${s.rh != null ? `${s.rh}%` : "—"}</span></div>
      </div>`;
    })
    .join("");
}

async function loadLiveTyphoon() {
  setRealtimeStatus("讀取即時颱風消息...");
  try {
    const data = await fetchCwaDataset("W-C0034-005");
    const typhoons = normalizeTyphoon(data);
    renderLiveTyphoon(typhoons);
    setRealtimeStatus(typhoons.length ? "已更新即時颱風資訊。" : "目前沒有最新颱風消息。");
  } catch (err) {
    console.error(err);
    renderLiveTyphoon([]);
    setRealtimeStatus(err.message || "讀取颱風資料失敗");
  }
}

function normalizeTyphoon(payload) {
  const records = payload?.records || {};
  const list = [];
  const arr = records.typhoon || records.typhoons || records.tropicalCyclone || records.cyclone || [];
  if (Array.isArray(arr)) {
    arr.forEach((item) => {
      const track = extractTrackPoints(item);
      list.push({
        name: item.cwaTyphoonName || item.typhoonName || item.name || item.title || item.id,
        id: item.typhoonId || item.no || item.serial || item.id,
        status: item.status || item.alertLevel || item.typhoonStatus,
        time: item.issueTime || item.publishTime || item.time || item.dataTime,
        text: item.description || item.summary || item.remark || item.text,
        track,
      });
    });
  }
  if (!list.length && Array.isArray(records.typhoonInfos)) {
    records.typhoonInfos.forEach((item) => {
      list.push({
        name: item.name || item.title || item.id,
        id: item.id,
        status: item.status,
        time: item.issueTime || item.publishTime,
        text: item.remark || item.description,
        track: extractTrackPoints(item),
      });
    });
  }
  return list;
}

function renderLiveTyphoon(list) {
  if (!dom.typhoonLiveList) return;
  if (realtimeState.typhoonLayer && realtimeState.typhoonMap) {
    realtimeState.typhoonMap.removeLayer(realtimeState.typhoonLayer);
    realtimeState.typhoonLayer = null;
  }
  if (!list.length) {
    dom.typhoonLiveList.innerHTML = '<div class="typhoon-live-item">目前沒有颱風警報或資料尚未提供。</div>';
    dom.typhoonLiveList.classList.add("ghost-status");
    return;
  }
  dom.typhoonLiveList.classList.remove("ghost-status");
  dom.typhoonLiveList.innerHTML = list
    .map((t) => {
      return `<div class="typhoon-live-item">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <strong>${sanitizeText(t.name || "未命名")}</strong>
          ${t.status ? `<span class="badge">${sanitizeText(t.status)}</span>` : ""}
          ${t.id ? `<span class="badge">#${sanitizeText(t.id)}</span>` : ""}
        </div>
        ${t.time ? `<div class="forecast-range">發布時間：${sanitizeText(t.time)}</div>` : ""}
        ${t.text ? `<p class="alert-desc">${sanitizeText(t.text)}</p>` : ""}
      </div>`;
    })
    .join("");

  // 繪製第一筆可用的路徑
  const track = list.find((t) => t.track && t.track.length)?.track;
  if (track && realtimeState.typhoonMap) {
    realtimeState.typhoonLayer = L.polyline(
      track.map((p) => [p.lat, p.lon]),
      { color: "#2563eb", weight: 4, opacity: 0.9 }
    ).addTo(realtimeState.typhoonMap);
    try {
      const bounds = realtimeState.typhoonLayer.getBounds();
      if (bounds.isValid()) {
        realtimeState.typhoonMap.fitBounds(bounds, { padding: [20, 20] });
      }
    } catch (_) {
      // ignore
    }
  }
}

function extractTrackPoints(obj) {
  if (!obj || typeof obj !== "object") return [];
  let found = null;
  function walk(node) {
    if (found) return;
    if (Array.isArray(node)) {
      const pts = node.map(parseTrackPoint).filter(Boolean);
      if (pts.length >= 2) {
        found = pts;
        return;
      }
      node.forEach(walk);
    } else if (node && typeof node === "object") {
      Object.values(node).forEach(walk);
    }
  }
  walk(obj);
  return found || [];
}

function parseTrackPoint(p) {
  if (!p || typeof p !== "object") return null;
  const lat =
    Number(p.lat ?? p.latitude ?? p.Latitude ?? p.LAT ?? p.latitute ?? p.Lat ?? p.緯度);
  const lon =
    Number(p.lon ?? p.longitude ?? p.Longitude ?? p.LON ?? p.lonitude ?? p.Lon ?? p.經度);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    lat,
    lon,
    time: p.time || p.dateTime || p.DateTime || p.datetime,
  };
}

function sanitizeText(text) {
  return String(text ?? "").replace(/[<>]/g, "");
}

function formatTimeRange(start, end) {
  if (!start && !end) return "";
  if (start && end) return `${start} ~ ${end}`;
  return start || end || "";
}
