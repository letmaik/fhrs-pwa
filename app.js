/* FHRS Map PWA - plain JS + Leaflet */
const API_BASE = "https://api.ratings.food.gov.uk/Establishments";
const API_HEADERS = {
  "x-api-version": "2",
  Accept: "application/json",
  "Accept-Language": "en-GB"
};

const filterFiveEl = document.getElementById("filterFive");
const locateBtn = document.getElementById("locateBtn");
const map = L.map("map", {
  attributionControl: false
});
const tiles = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
  minZoom: 9,
  maxZoom: 19
}).addTo(map);

L.control.attribution({
  position: 'bottomleft'
}).addTo(map);

const markers = L.layerGroup().addTo(map);
let lastFetchKey = "";

// Rating color mapping (covers FHRS and Scottish schemes)
function ratingColor(v) {
  const s = String(v || "").toLowerCase();
  if (["5", "pass"].includes(s)) return "#2e7d32";        // green
  if (s === "4") return "#66bb6a";                         // light green
  if (s === "3") return "#ffa000";                         // amber
  if (s === "2") return "#ff7043";                         // orange
  if (["1", "improvement required"].includes(s)) return "#f4511e"; // red/orange
  if (s === "0") return "#b71c1c";                         // deep red
  return "#9e9e9e";                                         // grey (awaiting/other)
}

// Map FHRS sub-scores to textual descriptors (per FSA Score Descriptors)
const SCORE_DESCRIPTORS = {
  Hygiene: {
    0: "Very good",
    5: "Good",
    10: "Generally satisfactory",
    15: "Improvement necessary",
    20: "Major improvement necessary",
    25: "Urgent improvement necessary"
  },
  Structural: {
    0: "Very good",
    5: "Good",
    10: "Generally satisfactory",
    15: "Improvement necessary",
    20: "Major improvement necessary",
    25: "Urgent improvement necessary"
  },
  Confidence: {
    0: "Very good",
    5: "Good",
    10: "Generally satisfactory",
    20: "Major improvement necessary",
    30: "Urgent improvement necessary"
  }
};
function scoreDescriptor(category, value) {
  const v = Number(value);
  if (!isFinite(v) || v < 0) return "N/A";
  const key = String(category || "").toLowerCase();
  const map = key.startsWith("hyg") ? SCORE_DESCRIPTORS.Hygiene
            : key.startsWith("str") ? SCORE_DESCRIPTORS.Structural
            : SCORE_DESCRIPTORS.Confidence; // Confidence in Management
  return map[v] ?? String(v);
}

function fmtAddress(e) {
  const parts = [e.AddressLine1, e.AddressLine2, e.AddressLine3, e.AddressLine4, e.PostCode].filter(Boolean);
  return parts.join(", ");
}

function debounce(fn, ms) {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function boundsRadiusMiles() {
  const c = map.getCenter();
  const ne = map.getBounds().getNorthEast();
  const meters = c.distanceTo(ne);
  return meters / 1609.344; // miles
}

async function fetchEstablishments() {
  // Do not fetch below zoom level 17
  const zoom = map.getZoom();
  if (zoom < 17) {
    markers.clearLayers();
    lastFetchKey = "";
    return;
  }

  const c = map.getCenter();
  const radius = Math.min(Math.max(boundsRadiusMiles(), 0.5), 25); // clamp 0.5–25 miles
  const onlyFive = !!(filterFiveEl && filterFiveEl.checked);

  // Avoid duplicate fetches for same view
  const fetchKey = `${c.lat.toFixed(4)},${c.lng.toFixed(4)}:${map.getZoom()}:five=${onlyFive}`;
  if (fetchKey === lastFetchKey) return; // skip redundant
  lastFetchKey = fetchKey;

  const params = new URLSearchParams({
    latitude: String(c.lat),
    longitude: String(c.lng),
    maxDistanceLimit: String(Math.round(radius)),
    sortOptionKey: "distance",
    pageSize: "200",
    pageNumber: "1"
  });

  if (onlyFive) {
    params.set("schemeTypeKey", "FHRS");
    params.set("ratingKey", "5");
  }

  const url = `${API_BASE}?${params.toString()}`;

  try {
    const res = await fetch(url, { headers: API_HEADERS, mode: "cors" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderEstablishments(data?.establishments || data?.Establishments || []);
  } catch (err) {
    console.error(err);
  }
}

function renderEstablishments(list) {
  markers.clearLayers();

  const seen = new Set();
  list.forEach(e => {
    const geo = e.geocode || e.Geocode || {};
    const lat = parseFloat(geo.latitude ?? geo.Latitude);
    const lng = parseFloat(geo.longitude ?? geo.Longitude);
    if (!isFinite(lat) || !isFinite(lng)) return;

    const id = e.FHRSID || e.FhrsId || e.id || `${lat},${lng}`;
    if (seen.has(id)) return; seen.add(id);

    const val = e.RatingValue || e.ratingValue || e.RatingKey || e.ratingKey || "";
    const color = ratingColor(val);

    // Use a divIcon marker to display the rating inside the circle
    const display = (() => {
      const n = parseInt(val, 10);
      if (!isNaN(n)) return String(n);
      const s = String(val || "").trim();
      return s ? s.charAt(0).toUpperCase() : "?";
    })();

    const icon = L.divIcon({
      className: "",
      html: `<div class="rating-marker" style="background:${color};border-color:${color}">${display}</div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
      popupAnchor: [0, -12]
    });

    const m = L.marker([lat, lng], { icon });

    const name = e.BusinessName || e.name || "Unknown";
    // address, scheme and rating removed from popup
    const date = e.RatingDate || e.ratingDate || "";

    // Extract detailed subratings
    const scores = e.scores || e.Scores || {};
    const hygiene = scores.Hygiene ?? scores.hygiene;
    const structural = scores.Structural ?? scores.structural;
    const confidence = scores.ConfidenceInManagement ?? scores.confidenceInManagement ?? scores.Confidence ?? scores.confidence;

    let detailsUrl = "";
    if (e.FHRSID) detailsUrl = `https://ratings.food.gov.uk/business/en-GB/${e.FHRSID}`;

    const popup = `
      <strong>${name}</strong><br/>
      ${date ? `Rated: ${new Date(date).toLocaleDateString()}<br/>` : ""}
      Hygiene: ${scoreDescriptor("Hygiene", hygiene)}<br/>
      Structural: ${scoreDescriptor("Structural", structural)}<br/>
      Confidence in Management: ${scoreDescriptor("Confidence", confidence)}<br/>
      ${detailsUrl ? `<a href="${detailsUrl}" target="_blank" rel="noopener">Details</a>` : ""}
    `;

    m.bindPopup(popup);
    markers.addLayer(m);
  });
}

// Setup map and geolocate
(function init() {
  const fallback = [51.5074, -0.1278]; // London
  map.setView(fallback, 14);

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        map.setView([latitude, longitude], 15);
        fetchEstablishments();
      },
      () => {
        fetchEstablishments();
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  } else {
    fetchEstablishments();
  }
})();

const debouncedFetch = debounce(fetchEstablishments, 500);
map.on("moveend", debouncedFetch);

if (filterFiveEl) {
  filterFiveEl.addEventListener("change", () => {
    // force a refetch even if position/zoom hasn't changed
    lastFetchKey = "";
    fetchEstablishments();
  });
}

if (locateBtn) {
  locateBtn.addEventListener("click", () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        map.setView([latitude, longitude], 18);
        fetchEstablishments();
      },
      () => {},
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });
}
