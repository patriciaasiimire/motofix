// Turns stored "lat,lng" location strings into readable place names. Results are
// cached and in-flight calls de-duplicated so tables do not overwhelm Nominatim.
const _cache = new Map<string, string>();
const _inflight = new Map<string, Promise<string>>();

const FALLBACK = 'Pinned location';

export function parseCoords(s?: string | null): [number, number] | null {
  if (!s) return null;
  const parts = s.split(',');
  if (parts.length !== 2) return null;
  const lat = parseFloat(parts[0].trim());
  const lng = parseFloat(parts[1].trim());
  if (isNaN(lat) || isNaN(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return [lat, lng];
}

export function isCoordLike(s?: string | null): boolean {
  return parseCoords(s) !== null;
}

function shorten(address: string): string {
  return address.split(',').slice(0, 3).join(',').trim();
}

export async function reverseGeocode(lat: number, lng: number): Promise<string> {
  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  const cached = _cache.get(key);
  if (cached) return cached;
  const flight = _inflight.get(key);
  if (flight) return flight;

  const task = (async (): Promise<string> => {
    try {
      const params = new URLSearchParams({
        lat: String(lat),
        lon: String(lng),
        format: 'jsonv2',
        addressdetails: '1',
      });
      const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`);
      if (!response.ok) return FALLBACK;
      const result = await response.json();
      if (typeof result?.display_name === 'string' && result.display_name) {
        const address = shorten(result.display_name);
        _cache.set(key, address);
        return address;
      }
    } catch {
      // Geocoding is optional; callers retain the selected coordinates on failure.
    }
    return FALLBACK;
  })();

  _inflight.set(key, task);
  try {
    return await task;
  } finally {
    _inflight.delete(key);
  }
}
