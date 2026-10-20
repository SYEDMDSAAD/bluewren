/** Major US airports Bluewren flies to: code, name, city, time zone and position. */
export interface Airport {
  code: string;
  name: string;
  short: string; // how people say it: "O'Hare", "Midway"
  city: string;
  tz: string;
  lat: number;
  lon: number;
}

const LIST: [string, string, string, string, string, number, number][] = [
  ["AUS", "Austin-Bergstrom International", "Austin", "Austin", "America/Chicago", 30.194, -97.67],
  ["ORD", "O'Hare International", "O'Hare", "Chicago", "America/Chicago", 41.979, -87.904],
  ["MDW", "Midway International", "Midway", "Chicago", "America/Chicago", 41.786, -87.752],
  ["DFW", "Dallas/Fort Worth International", "DFW", "Dallas", "America/Chicago", 32.897, -97.038],
  ["IAH", "George Bush Intercontinental", "Bush Intercontinental", "Houston", "America/Chicago", 29.984, -95.341],
  ["DEN", "Denver International", "Denver", "Denver", "America/Denver", 39.856, -104.674],
  ["ATL", "Hartsfield-Jackson Atlanta International", "Atlanta", "Atlanta", "America/New_York", 33.64, -84.427],
  ["JFK", "John F. Kennedy International", "JFK", "New York", "America/New_York", 40.64, -73.779],
  ["LGA", "LaGuardia", "LaGuardia", "New York", "America/New_York", 40.777, -73.873],
  ["EWR", "Newark Liberty International", "Newark", "New York", "America/New_York", 40.69, -74.174],
  ["BOS", "Logan International", "Logan", "Boston", "America/New_York", 42.366, -71.01],
  ["SEA", "Seattle-Tacoma International", "Sea-Tac", "Seattle", "America/Los_Angeles", 47.45, -122.309],
  ["SFO", "San Francisco International", "SFO", "San Francisco", "America/Los_Angeles", 37.619, -122.375],
  ["LAX", "Los Angeles International", "LAX", "Los Angeles", "America/Los_Angeles", 33.942, -118.408],
  ["SAN", "San Diego International", "San Diego", "San Diego", "America/Los_Angeles", 32.734, -117.19],
  ["PHX", "Phoenix Sky Harbor International", "Sky Harbor", "Phoenix", "America/Phoenix", 33.437, -112.008],
  ["LAS", "Harry Reid International", "Las Vegas", "Las Vegas", "America/Los_Angeles", 36.084, -115.154],
  ["MIA", "Miami International", "Miami", "Miami", "America/New_York", 25.796, -80.287],
  ["MCO", "Orlando International", "Orlando", "Orlando", "America/New_York", 28.431, -81.308],
  ["MSP", "Minneapolis-Saint Paul International", "MSP", "Minneapolis", "America/Chicago", 44.885, -93.222],
  ["DTW", "Detroit Metropolitan Wayne County", "Detroit", "Detroit", "America/Detroit", 42.212, -83.353],
  ["PHL", "Philadelphia International", "Philadelphia", "Philadelphia", "America/New_York", 39.874, -75.243],
  ["DCA", "Ronald Reagan Washington National", "Reagan National", "Washington", "America/New_York", 38.852, -77.038],
  ["IAD", "Washington Dulles International", "Dulles", "Washington", "America/New_York", 38.953, -77.457],
  ["CLT", "Charlotte Douglas International", "Charlotte", "Charlotte", "America/New_York", 35.214, -80.943],
  ["BNA", "Nashville International", "Nashville", "Nashville", "America/Chicago", 36.126, -86.678],
  ["SLC", "Salt Lake City International", "Salt Lake City", "Salt Lake City", "America/Denver", 40.788, -111.978],
  ["MSY", "Louis Armstrong New Orleans International", "New Orleans", "New Orleans", "America/Chicago", 29.993, -90.258],
];

export const AIRPORTS = new Map<string, Airport>(LIST.map(([code, name, short, city, tz, lat, lon]) => [code, { code, name, short, city, tz, lat, lon }]));

export function airport(code: string): Airport {
  const a = AIRPORTS.get(code);
  if (!a) throw new Error(`Unknown airport ${code}`);
  return a;
}

/** The airports a place name means: a code, a city (all its airports) or an airport's name. */
export function findAirports(query: string): Airport[] {
  const q = query.trim().toLowerCase().replace(/\b(airport|international|intl)\b/g, "").replace(/\s+/g, " ").trim();
  if (!q) return [];
  const code = AIRPORTS.get(q.toUpperCase());
  if (code) return [code];
  const all = [...AIRPORTS.values()];
  const byShort = all.filter((a) => a.short.toLowerCase() === q || a.name.toLowerCase().startsWith(q));
  if (byShort.length) return byShort;
  return all.filter((a) => a.city.toLowerCase() === q || a.city.toLowerCase().startsWith(q));
}

/** Other airports in the same city ("Chicago" has O'Hare and Midway). */
export function sameCity(code: string): string[] {
  const city = airport(code).city;
  return [...AIRPORTS.values()].filter((a) => a.city === city).map((a) => a.code);
}

export function distanceKm(a: Airport, b: Airport): number {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
