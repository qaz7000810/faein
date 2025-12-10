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
    setTyphoonStatus("已載入雅涵分業資料");
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
