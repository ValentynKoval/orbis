/** Source dictionary. `uk.ts` must match its shape; TypeScript enforces it. */
export const en = {
  meta: {
    title: "Orbis — the planet, live",
    description:
      "A real-time 3D Earth: every tracked satellite and the ISS, earthquakes, wildfires, clouds and city lights, computed live in your browser.",
  },
  nav: {
    live: "Live globe",
    sources: "Sources",
    language: "Мова: українська",
    languageShort: "UA",
    home: "Orbis home",
  },
  loading: {
    label: "Loading the Earth",
    webgl: "This device can't draw the 3D globe: WebGL is turned off or not supported. Try a recent Chrome, Safari or Firefox.",
  },
  hero: {
    title: "The planet, live.",
    lead: "Every tracked satellite, today's earthquakes and wildfires, yesterday's clouds and tonight's city lights, on one Earth that moves in real time.",
    cta: "Open the live globe",
    scroll: "Scroll to fly around",
  },
  readout: {
    satellites: "satellites in orbit",
    quakes: "earthquakes in 24 h",
    fires: "fire hotspots in 24 h",
  },
  chapters: {
    orbit: {
      title: "Up there, right now",
      body: "{count} satellites, each one placed by the same orbital model mission controllers use and recomputed in your browser while you watch. The gold one is the International Space Station.",
      iss: "ISS: {alt} km up, {speed} km/s, now over {pos}",
    },
    ground: {
      title: "The ground is never still",
      body: "{count} earthquakes were recorded in the last 24 hours. Rings ripple from every epicentre; the newest ones pulse brightest.",
      strongest: "Strongest: M{mag}, {place}, {ago}",
    },
    heat: {
      title: "Fire, seen from orbit",
      body: "The NOAA-20 satellite picked up {count} heat sources in the past day: wildfires, burning fields and gas flares. Brighter means hotter.",
    },
    night: {
      title: "Where the lights are",
      body: "The line between day and night sweeps across the equator at 1,670 km/h. On the dark side, cities glow where people live.",
    },
    final: {
      title: "Take the controls",
      body: "Spin the Earth, zoom into a coastline, tap any satellite, quake or fire to see what it is. No account, no ads.",
    },
  },
  hud: {
    utc: "UTC",
    live: "Live",
    layers: "Layers",
    closePanel: "Close layers",
    openPanel: "Show layers",
    resetView: "Reset view",
    clouds: "Clouds from {date}",
    cloudsArchive: "Clouds: NASA composite",
    hint: "Drag to rotate, scroll or pinch to zoom, tap an object to inspect it.",
    status: {
      loading: "loading",
      error: "unavailable, retrying",
    },
  },
  layers: {
    satellites: "Satellites",
    quakes: "Earthquakes",
    fires: "Fires",
    clouds: "Clouds",
    lights: "City lights",
    borders: "Borders",
  },
  groups: ["Space station", "Starlink", "OneWeb", "Navigation", "Geostationary", "Earth observation", "Other"],
  card: {
    close: "Close",
    focus: "Centre on it",
    altitude: "Altitude",
    speed: "Speed",
    position: "Position",
    inclination: "Inclination",
    period: "Orbit period",
    norad: "NORAD ID",
    magnitude: "Magnitude",
    depth: "Depth",
    time: "Time",
    tsunami: "Tsunami warning issued",
    usgs: "Open on USGS",
    fire: "Heat source",
    power: "Radiative power",
    detected: "Last detected",
    quake: "Earthquake",
    fireNote: "Merged detections within ~4 km by the VIIRS sensor on NOAA-20.",
    n2yo: "Track on N2YO",
  },
  units: {
    km: "km",
    kms: "km/s",
    min: "min",
    mw: "MW",
  },
  sources: {
    title: "Sources and credits",
    lead: "Orbis is a non-commercial project. It shows open data from the organisations below, fetched by our server and cached so their services see one client, not every visitor.",
    back: "Back to the globe",
    items: [
      {
        name: "Satellites: CelesTrak",
        text: "General perturbations element sets (GROUP=active), mirrored every two hours. Positions computed with satellite.js (SGP4).",
        url: "https://celestrak.org",
      },
      {
        name: "Earthquakes: USGS",
        text: "Earthquake Hazards Program real-time GeoJSON feeds: all events of the past day and M4.5+ of the past week.",
        url: "https://earthquake.usgs.gov/earthquakes/feed/",
      },
      {
        name: "Fires: NASA FIRMS",
        text: "VIIRS NOAA-20 active fire detections, last 24 hours. We acknowledge the use of data and imagery from LANCE FIRMS operated by NASA's Earth Science Data and Information System (ESDIS).",
        url: "https://firms.modaps.eosdis.nasa.gov",
      },
      {
        name: "Clouds: NASA GIBS",
        text: "VIIRS NOAA-20 Corrected Reflectance (True Color) daily mosaic, turned into a cloud mask on our server.",
        url: "https://nasa-gibs.github.io/gibs-api-docs/",
      },
      {
        name: "Earth imagery: NASA Visible Earth",
        text: "Blue Marble Next Generation (a different month for each season) and Black Marble 2016 night lights. NASA Earth Observatory, public domain.",
        url: "https://visibleearth.nasa.gov",
      },
      {
        name: "Borders and coastlines: Natural Earth",
        text: "1:50m cultural and physical vectors, public domain.",
        url: "https://www.naturalearthdata.com",
      },
    ],
    note: "Data can be delayed or incomplete. Do not use Orbis for navigation, safety or emergency decisions.",
  },
  time: {
    justNow: "just now",
  },
};

export type Dictionary = typeof en;
