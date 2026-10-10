// LocationPicker.tsx — a Google Map the driver uses to set exactly where they are.
// They can drag the pin or use "find my location"; it then reverse-geocodes the spot
// to a readable address and reports lat/lng + address back via onLocationChange.
// Defaults to central Kampala until a real position is chosen.

import { useState, useCallback, useRef } from 'react';
import { MapPin, Crosshair, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { useLoadScript, GoogleMap, Marker } from '@react-google-maps/api';

const DEFAULT_LAT = 0.3476;
const DEFAULT_LNG = 32.5825; // Kampala

interface LocationPickerProps {
  onLocationChange: (lat: number, lng: number, address: string) => void;
}

type DetectState = 'idle' | 'detecting' | 'done' | 'error';

const MAP_CONTAINER_STYLE = { width: '100%', height: 200 };

const MAP_OPTIONS: google.maps.MapOptions = {
  disableDefaultUI: true,
  gestureHandling: 'none',
  clickableIcons: false,
  zoomControl: true,
};

export function LocationPicker({ onLocationChange }: LocationPickerProps) {
  const [manualText,   setManualText]   = useState('');
  const [detectState,  setDetectState]  = useState<DetectState>('idle');
  const [detectedAddr, setDetectedAddr] = useState('');
  const [markerPos,    setMarkerPos]    = useState<{ lat: number; lng: number } | null>(null);
  const [errMsg,       setErrMsg]       = useState('');
  const mapRef = useRef<google.maps.Map | null>(null);

  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY?.trim();
  const { isLoaded, loadError } = useLoadScript({
    googleMapsApiKey: apiKey ?? '',
  });
  const [mapsAuthFailed, setMapsAuthFailed] = useState(false);

  useEffect(() => {
    const onMapsAuthFailure = () => setMapsAuthFailed(true);
    window.addEventListener('motofix:google-maps-auth-failure', onMapsAuthFailure);
    return () => window.removeEventListener('motofix:google-maps-auth-failure', onMapsAuthFailure);
  }, []);

  const reverseGeocode = useCallback((lat: number, lng: number, cb: (addr: string) => void) => {
    if (!window.google?.maps?.Geocoder) {
      cb(`${lat.toFixed(5)}, ${lng.toFixed(5)}`);
      return;
    }
    new google.maps.Geocoder().geocode({ location: { lat, lng } }, (results, status) => {
      cb(status === 'OK' && results?.[0]
        ? results[0].formatted_address
        : `${lat.toFixed(5)}, ${lng.toFixed(5)}`);
    });
  }, []);

  const detectLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setErrMsg('Geolocation not supported on this device.');
      setDetectState('error');
      return;
    }
    setDetectState('detecting');
    setErrMsg('');

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        reverseGeocode(lat, lng, (addr) => {
          setDetectedAddr(addr);
          setManualText(addr);
          setMarkerPos({ lat, lng });
          if (mapRef.current) {
            mapRef.current.panTo({ lat, lng });
            mapRef.current.setZoom(16);
          }
          setDetectState('done');
          onLocationChange(lat, lng, addr);
        });
      },
      (err) => {
        const msg =
          err.code === 1 ? 'Location permission denied. Please type your location below.' :
          err.code === 2 ? 'Unable to determine your position.' :
                           'Location request timed out.';
        setErrMsg(msg);
        setDetectState('error');
      },
      { enableHighAccuracy: true, timeout: 12000 }
    );
  }, [reverseGeocode, onLocationChange]);

  const handleManualChange = (val: string) => {
    setManualText(val);
    onLocationChange(DEFAULT_LAT, DEFAULT_LNG, val);
  };

  return (
    <div className="space-y-3">

      {/* Auto-detect button */}
      <button
        type="button"
        onClick={detectLocation}
        disabled={detectState === 'detecting'}
        className="w-full flex items-center justify-center gap-2.5 rounded-xl py-3 text-sm font-semibold transition-all active:scale-95 disabled:opacity-60"
        style={{
          background: detectState === 'done'
            ? 'rgba(34,197,94,0.12)'
            : 'rgba(59,130,246,0.12)',
          border: detectState === 'done'
            ? '1.5px solid rgba(34,197,94,0.4)'
            : '1.5px solid rgba(59,130,246,0.3)',
          color: detectState === 'done' ? '#86efac' : '#93c5fd',
        }}
      >
        {detectState === 'detecting' ? (
          <><Loader2 className="w-4 h-4 animate-spin" /> Detecting location…</>
        ) : detectState === 'done' ? (
          <><CheckCircle2 className="w-4 h-4" /> Location detected — tap to refresh</>
        ) : (
          <><Crosshair className="w-4 h-4" /> Detect my location automatically</>
        )}
      </button>

      {/* Error state */}
      {detectState === 'error' && errMsg && (
        <div className="flex items-start gap-2 rounded-xl p-3 text-xs text-red-300"
          style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          {errMsg}
        </div>
      )}

      {/* Google Map after detection */}
      {markerPos && (!apiKey || loadError || mapsAuthFailed) && (
        <div role="alert" className="rounded-xl border border-border bg-muted p-3 text-xs text-muted-foreground">
          {!apiKey
            ? <>Set <code>VITE_GOOGLE_MAPS_API_KEY</code> in the driver app&apos;s <code>.env.local</code> and restart Vite to show the map.</>
            : 'Google Maps could not load. Check the API key, billing, enabled APIs, and HTTP referrer restrictions.'}
        </div>
      )}
      {markerPos && isLoaded && apiKey && !loadError && !mapsAuthFailed && (
        <div className="rounded-xl overflow-hidden" style={{ border: '1.5px solid var(--border-2)' }}>
          <GoogleMap
            mapContainerStyle={MAP_CONTAINER_STYLE}
            center={markerPos}
            zoom={16}
            onLoad={map => { mapRef.current = map; }}
            options={MAP_OPTIONS}
          >
            <Marker position={markerPos} />
          </GoogleMap>
          <div className="flex items-center gap-2 px-3 py-2" style={{ background: 'var(--surface-1)' }}>
            <MapPin className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />
            <p className="text-xs text-muted-foreground line-clamp-2">{detectedAddr}</p>
          </div>
        </div>
      )}

      {/* Divider */}
      <div className="flex items-center gap-2">
        <div className="h-px flex-1" style={{ background: 'var(--surface-3)' }} />
        <span className="text-xs text-muted-foreground/50">or type it manually</span>
        <div className="h-px flex-1" style={{ background: 'var(--surface-3)' }} />
      </div>

      {/* Manual text input */}
      <div className="relative">
        <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-blue-400" />
        <input
          type="text"
          value={manualText}
          onChange={e => handleManualChange(e.target.value)}
          placeholder="e.g. Wandegeya, Kampala or a landmark"
          className="w-full rounded-xl pl-10 pr-4 py-3 text-sm outline-none transition-all"
          style={{
            background: 'var(--surface-2)',
            border: '1.5px solid rgba(59,130,246,0.2)',
            color: 'hsl(var(--foreground))',
          }}
          onFocus={e => (e.currentTarget.style.borderColor = 'rgba(59,130,246,0.5)')}
          onBlur={e => (e.currentTarget.style.borderColor = 'rgba(59,130,246,0.2)')}
        />
      </div>
    </div>
  );
}
