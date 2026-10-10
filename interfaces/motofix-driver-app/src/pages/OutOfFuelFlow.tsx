// OutOfFuelFlow.tsx — the dedicated flow for "I've run out of fuel". It finds nearby fuel
// stations (from OpenStreetMap) on a map with directions, includes the AI fuel advisor
// (is this fuel safe for my car?), and can request fuel delivery help.

import { useState, useEffect, useRef, useCallback, useMemo, type CSSProperties, type ReactNode, type MutableRefObject } from 'react';
import { type LL } from '@/utils/routeFollow';
import { createPortal } from 'react-dom';
import { MapContainer, Marker, Polyline, Popup, useMap } from 'react-leaflet';
import OpenFreeMapLayer from '@/components/OpenFreeMapLayer';
import { Icon, type Map as LeafletMap } from 'leaflet';
import {
  X, XCircle, ChevronRight, AlertTriangle, CheckCircle2,
  Navigation2, Loader2, MapPin, Star, Phone, Fuel, Maximize2, Minimize2,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { fuelAdvisorService, requestsService, type FuelAnalysis } from '@/config/api';
import { generateSimStations, enrichStation, fmtUGX, type SimStation } from '@/lib/simStations';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';

// ── Car brands commonly driven in Uganda ──────────────────────────────────────
const UGANDA_CARS = [
  'Toyota', 'Nissan', 'Honda', 'Subaru', 'Mitsubishi',
  'Isuzu',  'Mazda',  'Suzuki', 'Ford',  'Volkswagen',
  'Mercedes', 'BMW',  'Hyundai', 'Kia',  'Land Rover',
  'Other',
];

// ── Fuel types ────────────────────────────────────────────────────────────────
const FUEL_TYPES = [
  { id: 'regular_petrol', emoji: '⛽', label: 'Regular Petrol',  sub: 'Unleaded · RON 87–91'  },
  { id: 'super_petrol',   emoji: '⭐', label: 'Super / Premium', sub: 'High Octane · RON 95–98'},
  { id: 'diesel',         emoji: '🛢️', label: 'Diesel',          sub: 'Automotive Diesel'      },
  { id: 'kerosene',       emoji: '🕯️', label: 'Kerosene',        sub: 'Paraffin / Lamp oil'    },
];

type Step = 'confirm' | 'urgency' | 'info' | 'analyzing' | 'result' | 'fuel_switch' | 'station_scan' | 'stations';

// Scan steps shown before the stations map (reflect the real lookup pipeline)
const SCAN_STEPS = [
  'Pinning your GPS location',
  'Scanning within a 20 km radius',
  'Querying live station data',
  'Matching fuel brands & prices',
  'Checking opening hours',
  'Sorting by nearest distance',
];

// Which fuels are safe for each engine type (best option first)
const COMPATIBLE_FUELS: Record<string, string[]> = {
  petrol_standard: ['regular_petrol', 'super_petrol'],
  petrol_turbo:    ['super_petrol', 'regular_petrol'],
  diesel:          ['diesel'],
  hybrid:          ['regular_petrol', 'super_petrol'],
};

// Per engine+fuel badge: null = no badge, 'recommended' | 'caution'
function fuelBadge(engineType: string, fuelId: string): 'recommended' | 'caution' | null {
  if (engineType === 'petrol_turbo' && fuelId === 'super_petrol') return 'recommended';
  if (engineType === 'petrol_turbo' && fuelId === 'regular_petrol') return 'caution';
  if (engineType === 'diesel' && fuelId === 'diesel') return 'recommended';
  return null;
}

const KAMPALA: LL = { lat: 0.3476, lng: 32.5825 };
const LEAFLET_BASE_CSS = `
  .leaflet-container{position:relative;overflow:hidden;background:#e5e7eb;outline:0;font-family:Arial,sans-serif}
  .leaflet-pane,.leaflet-tile,.leaflet-marker-icon,.leaflet-marker-shadow,.leaflet-tile-container,.leaflet-pane>svg,.leaflet-pane>canvas{position:absolute;left:0;top:0}
  .leaflet-pane{z-index:400}.leaflet-tile-pane{z-index:200}.leaflet-overlay-pane{z-index:400}.leaflet-shadow-pane{z-index:500}.leaflet-marker-pane{z-index:600}.leaflet-tooltip-pane{z-index:650}.leaflet-popup-pane{z-index:700}
  .leaflet-tile{visibility:hidden;max-width:none!important}.leaflet-tile-loaded{visibility:inherit}.leaflet-container img{max-width:none!important;max-height:none!important}
  .leaflet-control-container{position:absolute;inset:0;pointer-events:none}.leaflet-top,.leaflet-bottom{position:absolute;z-index:1000;pointer-events:none}.leaflet-top{top:0}.leaflet-bottom{bottom:0}.leaflet-left{left:0}.leaflet-right{right:0}.leaflet-control{position:relative;pointer-events:auto}
  .leaflet-control-attribution{background:#ffffffd9;padding:2px 5px;font:11px Arial,sans-serif}.leaflet-popup-content-wrapper{border-radius:10px}.leaflet-popup-content{margin:10px 12px}
`;

// Directional car icon for navigation mode (heading in degrees)
const NAV_CAR_SVG = (heading: number) => `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44">` +
  `<circle cx="22" cy="22" r="20" fill="#3B82F6" fill-opacity="0.18" stroke="#3B82F6" stroke-width="1.5"/>` +
  `<g transform="rotate(${heading} 22 22)">` +
  `<polygon points="22,5 30,34 22,28 14,34" fill="#3B82F6" stroke="white" stroke-width="2" stroke-linejoin="round"/>` +
  `</g></svg>`
)}`;

// Amber fuel-station pin
const STATION_PIN_SVG = (active: boolean) => `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="44" viewBox="0 0 36 44">` +
  `<path d="M18 1C8.61 1 1 8.61 1 18C1 29.5 18 43 18 43C18 43 35 29.5 35 18C35 8.61 27.39 1 18 1Z" fill="${active ? '#DC2626' : '#F59E0B'}" stroke="white" stroke-width="2"/>` +
  `<text x="18" y="24" text-anchor="middle" font-size="16" fill="white">⛽</text>` +
  `</svg>`
)}`;

function MapViewport({ mapRef, center, points, zoom = 13 }: {
  mapRef: MutableRefObject<LeafletMap | null>;
  center: LL;
  points?: LL[];
  zoom?: number;
}) {
  const map = useMap();
  const pointsKey = points?.map(({ lat, lng }) => `${lat},${lng}`).join(';') ?? '';
  useEffect(() => {
    mapRef.current = map;
    return () => {
      if (mapRef.current === map) mapRef.current = null;
    };
  }, [map, mapRef]);
  useEffect(() => {
    if (points && points.length > 1) {
      map.fitBounds(points.map(({ lat, lng }) => [lat, lng]) as [number, number][], { padding: [36, 36], maxZoom: 16 });
    } else {
      map.setView(center, zoom);
    }
    // pointsKey tracks coordinate changes without refitting on unrelated renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, pointsKey, center.lat, center.lng, zoom]);
  return null;
}

interface Props {
  onClose: () => void;
}

export default function OutOfFuelFlow({ onClose }: Props) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [step, setStep]           = useState<Step>('confirm');
  const [animKey, setAnimKey]     = useState(0);
  const [carModel, setCarModel]   = useState('');
  const [otherCar, setOtherCar]   = useState('');
  const [fuelType, setFuelType]   = useState('');
  const [analysis, setAnalysis]   = useState<FuelAnalysis | null>(null);
  const [stations, setStations]   = useState<SimStation[]>([]);
  const [selected, setSelected]   = useState<SimStation | null>(null);
  const [driverPos, setDriverPos] = useState<{ lat: number; lng: number } | null>(null);
  const [loadingDelivery, setLoadingDelivery] = useState(false);
  const [mapHeight, setMapHeight]             = useState(240);
  const [directions, setDirections]           = useState<LL[] | null>(null);
  const [routeInfo, setRouteInfo]             = useState<{ duration: string; distance: string } | null>(null);
  const [detailStation, setDetailStation]     = useState<SimStation | null>(null);
  const [profileStation, setProfileStation]   = useState<SimStation | null>(null);
  const [gpsError, setGpsError]               = useState(false);
  const [navigating, setNavigating]           = useState(false);
  const [userHeading, setUserHeading]         = useState(0);
  const watchIdRef                            = useRef<number | null>(null);
  const MAP_MIN = 140;
  const MAP_MAX = 420;
  const MAP_STEP = 80;
  const [skipAnalysis, setSkipAnalysis]       = useState(false);
  const [analyzeMsgIdx, setAnalyzeMsgIdx]     = useState(0);
  const [scanStep, setScanStep]               = useState(0);

  const goTo = useCallback((next: Step) => {
    setStep(next);
    setAnimKey(k => k + 1);
  }, []);

  useEffect(() => {
    if (step !== 'analyzing') return;
    setAnalyzeMsgIdx(0);
    const t = setInterval(() => setAnalyzeMsgIdx(i => i + 1), 2200);
    return () => clearInterval(t);
  }, [step]);

  const mapRef       = useRef<LeafletMap | null>(null);
  const stationsFetchRef = useRef<Promise<SimStation[]> | null>(null);
  const sheetRef     = useRef<HTMLDivElement>(null);
  const dragRef      = useRef<{ startY: number; baseOffset: number } | null>(null);
  const minimizedRef = useRef(false);
  const PEEK         = 60; // px of sheet visible when minimized

  const onDragMove = useCallback((e: PointerEvent) => {
    if (!dragRef.current || !sheetRef.current) return;
    const newOffset = Math.max(0, dragRef.current.baseOffset + (e.clientY - dragRef.current.startY));
    sheetRef.current.style.transform = `translateY(${newOffset}px)`;
    sheetRef.current.style.transition = 'none';
  }, []);

  const onDragEnd = useCallback((e: PointerEvent) => {
    if (!dragRef.current || !sheetRef.current) return;
    const rawDelta = e.clientY - dragRef.current.startY;
    dragRef.current = null;
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
    const height = sheetRef.current.offsetHeight;
    sheetRef.current.style.transition = 'transform 0.35s cubic-bezier(0.22,0.68,0,1.2)';
    if (minimizedRef.current) {
      if (rawDelta < -60) {
        minimizedRef.current = false;
        sheetRef.current.style.transform = 'translateY(0)';
      } else {
        sheetRef.current.style.transform = `translateY(${height - PEEK}px)`;
      }
    } else {
      if (rawDelta > 100) {
        minimizedRef.current = true;
        sheetRef.current.style.transform = `translateY(${height - PEEK}px)`;
      } else {
        sheetRef.current.style.transform = 'translateY(0)';
      }
    }
  }, [onDragMove]);

  const onHandleDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    if (!sheetRef.current) return;
    const baseOffset = minimizedRef.current ? sheetRef.current.offsetHeight - PEEK : 0;
    dragRef.current = { startY: e.clientY, baseOffset };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
  }, [onDragMove, onDragEnd]);

  useEffect(() => () => {
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
  }, [onDragMove, onDragEnd]);

  // Get driver GPS on mount
  useEffect(() => {
    navigator.geolocation.getCurrentPosition(
      (pos) => { setDriverPos({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setGpsError(false); },
      () => setGpsError(true),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }, []);

  // ── Resolve GPS — uses cached driverPos or waits up to 15 s for a fresh fix ──
  const resolvePos = useCallback((): Promise<{ lat: number; lng: number } | null> => {
    if (driverPos) return Promise.resolve(driverPos);
    return new Promise(resolve => {
      navigator.geolocation.getCurrentPosition(
        p => {
          const pos = { lat: p.coords.latitude, lng: p.coords.longitude };
          setDriverPos(pos);
          setGpsError(false);
          resolve(pos);
        },
        () => { setGpsError(true); resolve(null); },
        { enableHighAccuracy: true, timeout: 15000 },
      );
    });
  }, [driverPos]);

  // ── Fetch GPS + nearby stations. Stores the in-flight promise so the scan
  //    animation can wait for it before showing the (possibly empty) list. ──────
  const prefetchStations = useCallback((force = false): Promise<SimStation[]> => {
    if (!force && stationsFetchRef.current) return stationsFetchRef.current;
    const p = (async (): Promise<SimStation[]> => {
      let pos: { lat: number; lng: number } | null = null;
      try { pos = await resolvePos(); } catch { pos = null; }
      try {
        if (pos) {
          // Real stations from the backend (OpenStreetMap / Overpass), then
          // layer on brand styling, artwork and prices for the listing.
          const res = await fuelAdvisorService.nearbyStations(pos.lat, pos.lng);
          const raw = res.data.stations ?? [];
          const list = raw.length
            ? raw.map(enrichStation).sort((a, b) => a.distance_km - b.distance_km)
            : generateSimStations(pos);   // backend empty → synthetic fallback
          setStations(list);
          return list;
        }
      } catch (err) {
        console.warn('[fuel] live station lookup failed — using fallback', err);
      }
      // Never throw: always resolve with something usable so the scan advances.
      try {
        const list = pos ? generateSimStations(pos) : [];
        setStations(list);
        return list;
      } catch (err) {
        console.warn('[fuel] fallback generation failed', err);
        setStations([]);
        return [];
      }
    })();
    stationsFetchRef.current = p;
    return p;
  }, [resolvePos]);

  // ── Station scan: animate the steps while the real fetch resolves ─────────────
  useEffect(() => {
    if (step !== 'station_scan') return;
    setScanStep(0);
    const startedAt = Date.now();
    const MIN_SCAN_MS = 7000;    // always run long enough to feel like real work
    const MAX_SCAN_MS = 13000;   // …but never hang
    let finished = false;
    let idx = 0;
    const timer = setInterval(() => {
      idx = Math.min(idx + 1, SCAN_STEPS.length - 1);
      setScanStep(idx);
    }, 1150);

    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      setScanStep(SCAN_STEPS.length);   // all ticked
      setTimeout(() => goTo('stations'), 400);
    };

    // Hard ceiling so it can never hang.
    const hardStop = window.setTimeout(finish, MAX_SCAN_MS);

    // Wait for the fetch (errors swallowed so a rejection can NEVER hang it),
    // then hold until the minimum scan time has elapsed so all the checks read.
    Promise.resolve(stationsFetchRef.current ?? prefetchStations(true))
      .catch(() => {})
      .then(() => {
        const remaining = Math.max(0, MIN_SCAN_MS - (Date.now() - startedAt));
        setTimeout(finish, remaining);
      });

    return () => { finished = true; clearInterval(timer); clearTimeout(hardStop); };
  }, [step, prefetchStations, goTo]);

  // ── AI analysis — fast; stations load in the background ───────────────────────
  // The AI compatibility check is a nice-to-have. We never let it strand a
  // stranded driver: if it takes longer than ~9 s it's abandoned and we go
  // straight to the stations (which are already prefetching).
  const runAnalysis = useCallback(async () => {
    const effectiveCar = carModel === 'Other' ? otherCar.trim() : carModel;
    if (!effectiveCar || !fuelType) return;
    goTo('analyzing');
    prefetchStations(); // fire-and-forget — stations load while the AI thinks

    let settled = false;
    const skip = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      goTo('station_scan');   // AI too slow → don't make them wait, show stations
    }, 9000);

    try {
      const analysisRes = await fuelAdvisorService.analyze(effectiveCar, fuelType);
      if (settled) return;            // already skipped to stations
      settled = true; clearTimeout(skip);
      setAnalysis(analysisRes.data);
      goTo('result');
    } catch (err: any) {
      if (settled) return;
      settled = true; clearTimeout(skip);
      console.error('[fuel-advisor] analysis failed:', err?.response?.data ?? err?.message ?? err);
      const status = err?.response?.status;
      const detail = err?.response?.data?.detail;
      if (detail) toast.error(`Analysis error: ${detail}`);
      else if (status === 404) toast.error('Fuel advisor not found (404) — rebuild the diagnosis service container.');
      else if (status === 401) toast.error('Not authorised (401) — please log out and back in.');
      else if (status === 503) toast.error('AI not configured on server (503) — check GROQ_API_KEY.');
      else if (!status) toast.error('Cannot reach diagnosis service — is Docker running on port 8007?');
      else toast.error(`AI analysis failed (${status}) — please try again.`);
      goTo('station_scan');   // on error, still take them to stations
    }
  }, [carModel, otherCar, fuelType, prefetchStations, goTo]);

  // ── Fast path: skip AI, go straight to the station scan (fetch in background) ──
  const findStations = useCallback(() => {
    prefetchStations(); // background — scan animation covers the load
    goTo('station_scan');
  }, [prefetchStations, goTo]);

  // ── Fuel delivery request ────────────────────────────────────────────────────
  const requestDelivery = useCallback(async () => {
    if (!driverPos) {
      toast.error('Could not detect your location. Please enable GPS and retry.');
      return;
    }
    setLoadingDelivery(true);
    try {
      const res = await requestsService.create({
        customer_name: user?.full_name || 'Driver',
        service_type: 'Out of Fuel',
        location: `${driverPos.lat},${driverPos.lng}`,
        description: `Out of fuel – needs fuel delivery · Car: ${carModel} · Fuel: ${FUEL_TYPES.find(f => f.id === fuelType)?.label ?? fuelType}`,
      });
      const newId = String(res.data?.id ?? '');
      toast.success('Fuel delivery requested! A provider will respond shortly.');
      onClose();
      navigate(newId ? `/requests/${newId}` : '/requests', { replace: true });
    } catch {
      toast.error('Could not submit request. Please try again.');
    } finally {
      setLoadingDelivery(false);
    }
  }, [driverPos, carModel, fuelType, user, onClose, navigate]);

  const selectedFuelLabel = FUEL_TYPES.find(f => f.id === fuelType)?.label ?? fuelType;

  const stationMarkerIcon = useCallback((s: SimStation) => new Icon({
    iconUrl: STATION_PIN_SVG(selected?.place_id === s.place_id),
    iconSize: [36, 44],
    iconAnchor: [18, 44],
  }), [selected]);

  const beginNavigation = useCallback((s: SimStation) => {
    setNavigating(true);
    setMapHeight(MAP_MAX);
    setTimeout(() => {
      mapRef.current?.setZoom(16);
      mapRef.current?.panTo({ lat: s.lat, lng: s.lng });
    }, 100);
    if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
    watchIdRef.current = navigator.geolocation.watchPosition(
      pos => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setDriverPos(p);
        if (pos.coords.heading != null) setUserHeading(pos.coords.heading);
        mapRef.current?.panTo(p);
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 500, timeout: 10000 },
    );
  }, []);

  const stopNavigation = useCallback(() => {
    if (watchIdRef.current !== null) { navigator.geolocation.clearWatch(watchIdRef.current); watchIdRef.current = null; }
    setNavigating(false);
  }, []);

  useEffect(() => () => {
    if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
  }, []);

  const retryLocation = useCallback(() => {
    setGpsError(false);
    setStations([]);
    stationsFetchRef.current = null;   // discard the previous (empty) result
    prefetchStations(true);            // fresh search — backend widens 5→10→15→20 km
    goTo('station_scan');              // scan animation waits for it to resolve
  }, [prefetchStations, goTo]);

  const handleStationClick = useCallback((s: SimStation) => {
    const isSame = selected?.place_id === s.place_id;
    if (isSame) {
      setSelected(null);
      setDirections(null);
      setRouteInfo(null);
      setDetailStation(null);
      return;
    }
    setSelected(s);
    setDetailStation(s);
    setDirections(null);
    setRouteInfo(null);
    if (driverPos) {
      const destination = { lat: s.lat, lng: s.lng };
      const distanceKm = Math.max(haversineM(driverPos, destination) / 1000, s.distance_km || 0);
      const durationMinutes = Math.max(1, Math.round((distanceKm / 25) * 60));
      setDirections([driverPos, destination]);
      setRouteInfo({
        distance: `${distanceKm.toFixed(1)} km`,
        duration: durationMinutes < 60
          ? `${durationMinutes} min`
          : `${Math.floor(durationMinutes / 60)} hr ${durationMinutes % 60} min`,
      });
    }
  }, [selected, driverPos]);

  // ── Render ───────────────────────────────────────────────────────────────────
  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.65)',
      backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    }}>
      <style>{`
        @keyframes oofSlideUp {
          from { opacity: 0; transform: translateY(32px); }
          to   { opacity: 1; transform: translateY(0);    }
        }
        .oof-step { animation: oofSlideUp 0.35s cubic-bezier(.22,.68,0,1.2) both; }
        .oof-car-pill { transition: all 0.15s ease; }
        .oof-car-pill:active { transform: scale(0.95); }
        .oof-fuel-card { transition: all 0.2s ease; }
        .oof-station-card { transition: background 0.15s ease; }
        .oof-station-card:active { transform: scale(0.98); }
        @keyframes spin     { to { transform: rotate(360deg);  } }
        @keyframes spin-ccw { to { transform: rotate(-360deg); } }
        @keyframes oof-badge-pulse {
          0%,100% { box-shadow: 0 0 0 1px rgba(34,197,94,0.3), 0 0 28px rgba(34,197,94,0.45); }
          50%     { box-shadow: 0 0 0 1px rgba(34,197,94,0.5), 0 0 42px rgba(34,197,94,0.65); }
        }
        @keyframes oof-msg-in {
          from { opacity:0; transform:translateY(6px); }
          to   { opacity:1; transform:translateY(0);   }
        }
      `}</style>

      {/* Sheet */}
      <div
        ref={sheetRef}
        style={{
          width: '100%', maxWidth: 480,
          background: 'var(--oof-sheet)',
          borderRadius: '24px 24px 0 0',
          maxHeight: '92vh',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 -8px 48px rgba(0,0,0,0.30)',
        }}
      >
        {/* Handle + close */}
        <div
          onPointerDown={onHandleDown}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '14px 16px 10px', flexShrink: 0, position: 'relative',
            cursor: 'grab', userSelect: 'none', touchAction: 'none',
          }}
        >
          {/* Drag handle */}
          <div style={{ width: 48, height: 5, borderRadius: 3, background: 'var(--oof-text-lo)' }} />

          {/* Close button — dark fill */}
          <button
            onPointerDown={e => e.stopPropagation()}
            onClick={onClose}
            style={{
              position: 'absolute', right: 16, top: 8,
              width: 32, height: 32, borderRadius: '50%',
              background: 'var(--oof-text-ghost)',
              border: '1.5px solid var(--oof-text-faint)',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <X style={{ width: 16, height: 16, color: 'var(--oof-text-hi)', strokeWidth: 2.5 }} />
          </button>
        </div>

        {/* Step content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 32px' }}>
          <div key={animKey} className="oof-step">

            {/* ══ STEP 1: CONFIRM ══════════════════════════════════════════════ */}
            {step === 'confirm' && (
              <div style={{ textAlign: 'center', paddingTop: 32 }}>
                <div style={{ fontSize: 72, marginBottom: 20, lineHeight: 1 }}>⛽</div>
                <h2 style={{ fontSize: 22, fontWeight: 800, color: 'var(--oof-text-hi)', marginBottom: 8 }}>
                  Are you out of fuel?
                </h2>
                <p style={{ fontSize: 14, color: 'var(--oof-text-lo)', marginBottom: 36, lineHeight: 1.6 }}>
                  Let's get you sorted — we'll find nearby stations and make sure you get the right fuel.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <button
                    onClick={() => goTo('urgency')}
                    style={{
                      width: '100%', padding: '16px 20px', borderRadius: 16,
                      border: '2px solid #22C55E', background: 'rgba(34,197,94,0.12)',
                      color: '#22C55E', fontWeight: 800, fontSize: 16, cursor: 'pointer',
                      textAlign: 'center',
                    }}
                  >
                    ⛽ Yes, I need a refill
                  </button>
                  <button
                    onClick={onClose}
                    style={{
                      width: '100%', padding: '16px 20px', borderRadius: 16,
                      border: '2px solid #EF4444', background: 'rgba(239,68,68,0.12)',
                      color: '#EF4444', fontWeight: 700, fontSize: 15, cursor: 'pointer',
                      textAlign: 'center',
                    }}
                  >
                    ✋ No, I don't
                  </button>
                </div>
              </div>
            )}

            {/* ══ STEP 2: URGENCY ══════════════════════════════════════════════ */}
            {step === 'urgency' && (
              <div style={{ textAlign: 'center', paddingTop: 32 }}>
                <div style={{ fontSize: 64, marginBottom: 20 }}>🚨</div>
                <h2 style={{ fontSize: 22, fontWeight: 800, color: 'var(--oof-text-hi)', marginBottom: 8 }}>
                  Do you need a refill right away?
                </h2>
                <p style={{ fontSize: 14, color: 'var(--oof-text-lo)', marginBottom: 36, lineHeight: 1.6 }}>
                  We'll locate the nearest stations and make sure your engine gets the right fuel.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <button
                    onClick={() => { setSkipAnalysis(false); goTo('info'); }}
                    style={{
                      width: '100%', padding: '16px 20px', borderRadius: 16,
                      border: '2px solid #22C55E', background: 'rgba(34,197,94,0.12)',
                      color: '#22C55E', fontWeight: 800, fontSize: 16, cursor: 'pointer',
                      textAlign: 'center',
                    }}
                  >
                    🚗 Yes, right away
                  </button>
                  <button
                    onClick={() => { setSkipAnalysis(true); findStations(); }}
                    style={{
                      width: '100%', padding: '16px 20px', borderRadius: 16,
                      border: '2px solid #EF4444', background: 'rgba(239,68,68,0.12)',
                      color: '#EF4444', fontWeight: 700, fontSize: 15, cursor: 'pointer',
                      textAlign: 'center',
                    }}
                  >
                    🗺️ No thanks, I can make it to a station
                  </button>
                </div>
              </div>
            )}

            {/* ══ STEP 3: INFO ═════════════════════════════════════════════════ */}
            {step === 'info' && (
              <div style={{ paddingTop: 28 }}>
                <div style={{ textAlign: 'center', marginBottom: 28 }}>
                  <div style={{ fontSize: 48, marginBottom: 12 }}>{skipAnalysis ? '🗺️' : '🤖'}</div>
                  <h2 style={{ fontSize: 20, fontWeight: 800, color: 'var(--oof-text-hi)', marginBottom: 6 }}>
                    {skipAnalysis ? 'Find a Nearby Station' : 'Before we get you fueled up…'}
                  </h2>
                  <p style={{ fontSize: 13, color: 'var(--oof-text-faint)', lineHeight: 1.5 }}>
                    {skipAnalysis
                      ? 'Select your fuel type and we\'ll show you the closest stations right away.'
                      : 'We need a little info so our AI can verify fuel compatibility and find the right stations for you.'}
                  </p>
                </div>

                {/* Car brand — only shown for full AI path */}
                {!skipAnalysis && (
                  <div style={{ marginBottom: 24 }}>
                    <p style={{ fontSize: 11, fontWeight: 700, color: '#22C55E', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 12 }}>
                      What car do you drive?
                    </p>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                      {UGANDA_CARS.map(car => {
                        const active = carModel === car;
                        return (
                          <button
                            key={car}
                            className="oof-car-pill"
                            onClick={() => { setCarModel(active ? '' : car); if (car !== 'Other') setOtherCar(''); }}
                            style={{
                              padding: '9px 6px', borderRadius: 12, fontSize: 11, fontWeight: 600,
                              textAlign: 'center', lineHeight: 1.3, cursor: 'pointer',
                              border: active ? '2px solid #22C55E' : '1.5px solid var(--oof-border)',
                              background: active ? 'rgba(34,197,94,0.15)' : 'var(--oof-surface)',
                              color: active ? '#22C55E' : 'var(--oof-text-md)',
                              boxShadow: active ? '0 0 12px rgba(34,197,94,0.20)' : 'none',
                            }}
                          >
                            {car === 'Other' ? '✏️ Other' : car}
                          </button>
                        );
                      })}
                    </div>
                    {/* Free-text input shown only when Other is selected */}
                    {carModel === 'Other' && (
                      <input
                        autoFocus
                        type="text"
                        placeholder="Enter your car make e.g. Lexus, UAZ…"
                        value={otherCar}
                        onChange={e => setOtherCar(e.target.value)}
                        style={{
                          marginTop: 10, width: '100%', padding: '12px 14px',
                          borderRadius: 12, fontSize: 13, outline: 'none',
                          border: '2px solid #22C55E',
                          background: 'var(--oof-surface)',
                          color: 'var(--oof-text-hi)',
                          boxSizing: 'border-box',
                        }}
                      />
                    )}
                  </div>
                )}

                {/* Fuel type */}
                <div style={{ marginBottom: 28 }}>
                  <p style={{ fontSize: 11, fontWeight: 700, color: '#22C55E', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 12 }}>
                    What fuel do you need?
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {FUEL_TYPES.map(ft => {
                      const active = fuelType === ft.id;
                      return (
                        <button
                          key={ft.id}
                          className="oof-fuel-card"
                          onClick={() => setFuelType(active ? '' : ft.id)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 14,
                            padding: '13px 16px', borderRadius: 14, cursor: 'pointer',
                            border: active ? '2px solid #22C55E' : '1.5px solid var(--oof-border)',
                            background: active ? 'rgba(34,197,94,0.12)' : 'var(--oof-surface)',
                          }}
                        >
                          {/* Radio dot */}
                          <div style={{
                            width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
                            border: active ? '2px solid #22C55E' : '2px solid var(--oof-border)',
                            background: active ? '#22C55E' : 'transparent',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                          }}>
                            {active && <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#fff' }} />}
                          </div>
                          <span style={{ fontSize: 22 }}>{ft.emoji}</span>
                          <div style={{ textAlign: 'left' }}>
                            <p style={{ fontSize: 14, fontWeight: 700, color: active ? 'var(--oof-text-hi)' : 'var(--oof-text-md)', margin: 0 }}>{ft.label}</p>
                            <p style={{ fontSize: 11, color: 'var(--oof-text-faint)', margin: 0, marginTop: 2 }}>{ft.sub}</p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* CTA — adapts to path */}
                {(() => {
                  const effectiveCar = carModel === 'Other' ? otherCar.trim() : carModel;
                  const ready = skipAnalysis ? !!fuelType : !!(effectiveCar && fuelType);
                  return (
                    <button
                      onClick={skipAnalysis ? findStations : runAnalysis}
                      disabled={!ready}
                      style={{
                        width: '100%', height: 54, borderRadius: 16, border: 'none',
                        background: ready ? 'linear-gradient(135deg, #22C55E, #16A34A)' : 'var(--oof-surface)',
                        color: ready ? '#000' : 'var(--oof-text-faint)',
                        fontWeight: 800, fontSize: 16,
                        cursor: ready ? 'pointer' : 'not-allowed',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                        boxShadow: ready ? '0 4px 20px rgba(34,197,94,0.35)' : 'none',
                        transition: 'all 0.2s ease',
                      }}
                    >
                      <span style={{ fontSize: 18 }}>{skipAnalysis ? '📍' : '🤖'}</span>
                      {skipAnalysis ? 'Show Nearby Stations' : 'Check Vehicle & Fuel Compatibility'}
                      <ChevronRight style={{ width: 18, height: 18 }} />
                    </button>
                  );
                })()}
              </div>
            )}

            {/* ══ STEP 4: ANALYZING ════════════════════════════════════════════ */}
            {step === 'analyzing' && (() => {
              const STATION_MSGS = [
                'Scanning your area…',
                'Checking road network…',
                'Locating fuel stations…',
                'Calculating distances…',
                'Checking station access…',
                'Almost there…',
              ];
              const ANALYSIS_MSGS = [
                'Reading your engine type…',
                'Checking fuel compatibility…',
                'Analysing topography…',
                'Scanning nearby stations…',
                'Cross-referencing fuel data…',
                'Finalising results…',
              ];
              const msgs = skipAnalysis ? STATION_MSGS : ANALYSIS_MSGS;
              const currentMsg = msgs[analyzeMsgIdx % msgs.length];
              const effectiveCar = carModel === 'Other' ? otherCar.trim() : carModel;
              return (
                <div style={{ textAlign: 'center', paddingTop: 36, paddingBottom: 40 }}>

                  {/* ── Concentric spinning rings + logo ── */}
                  <div style={{ position: 'relative', width: 200, height: 200, margin: '0 auto 32px' }}>

                    {/* Outermost slow dashed ring */}
                    <div style={{ position: 'absolute', inset: 0, animation: 'spin 10s linear infinite' }}>
                      <svg width="200" height="200" viewBox="0 0 200 200" fill="none">
                        <circle cx="100" cy="100" r="96"
                          stroke="rgba(34,197,94,0.20)" strokeWidth="1" strokeDasharray="8 6" />
                      </svg>
                    </div>

                    {/* Outer fast arc */}
                    <div style={{ position: 'absolute', inset: 0, animation: 'spin 1.8s linear infinite' }}>
                      <svg width="200" height="200" viewBox="0 0 200 200" fill="none">
                        <circle cx="100" cy="100" r="90"
                          stroke="#22C55E" strokeWidth="2.5" strokeLinecap="round"
                          strokeDasharray="120 446"
                          style={{ filter: 'drop-shadow(0 0 6px rgba(34,197,94,0.6))' }} />
                      </svg>
                    </div>

                    {/* Middle counter-rotating dashed ring */}
                    <div style={{ position: 'absolute', top: 28, left: 28, width: 144, height: 144, animation: 'spin-ccw 3s linear infinite' }}>
                      <svg width="144" height="144" viewBox="0 0 144 144" fill="none">
                        <circle cx="72" cy="72" r="68"
                          stroke="rgba(34,197,94,0.35)" strokeWidth="1.5" strokeDasharray="5 9" />
                      </svg>
                    </div>

                    {/* Inner fast arc */}
                    <div style={{ position: 'absolute', top: 48, left: 48, width: 104, height: 104, animation: 'spin 1.1s linear infinite' }}>
                      <svg width="104" height="104" viewBox="0 0 104 104" fill="none">
                        <circle cx="52" cy="52" r="48"
                          stroke="rgba(34,197,94,0.45)" strokeWidth="2" strokeLinecap="round"
                          strokeDasharray="48 254" />
                      </svg>
                    </div>

                    {/* Logo badge — dead centre */}
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <div style={{
                        position: 'absolute', width: 100, height: 100, borderRadius: 24,
                        background: 'rgba(34,197,94,0.18)', filter: 'blur(16px)',
                        animation: 'oof-badge-pulse 2s ease-in-out infinite',
                      }} />
                      <div style={{
                        position: 'relative', width: 88, height: 88, borderRadius: 22,
                        background: 'var(--oof-sheet)',
                        border: '2.5px solid rgba(34,197,94,0.90)',
                        boxShadow: '0 0 0 1px rgba(34,197,94,0.15), 0 0 24px rgba(34,197,94,0.6), 0 0 52px rgba(34,197,94,0.2)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        animation: 'oof-badge-pulse 2s ease-in-out infinite',
                      }}>
                        <img src="/motofix-logo.png" alt="MOTOFIX"
                          style={{ width: 64, height: 64, objectFit: 'contain' }}
                          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                      </div>
                    </div>
                  </div>

                  {/* Heading */}
                  <h2 style={{ fontSize: 20, fontWeight: 800, color: 'var(--oof-text-hi)', marginBottom: 10 }}>
                    {skipAnalysis ? 'Finding Stations' : 'Analysing'}
                  </h2>

                  {/* Cycling message — re-keyed so it fades in each change */}
                  <p key={currentMsg} style={{
                    fontSize: 14, fontWeight: 600, color: '#22C55E',
                    lineHeight: 1.5, margin: '0 0 8px',
                    animation: 'oof-msg-in 0.4s ease both',
                  }}>
                    {currentMsg}
                  </p>

                  {/* Vehicle/fuel context line */}
                  {!skipAnalysis && effectiveCar && (
                    <p style={{ fontSize: 12, color: 'var(--oof-text-faint)', margin: 0 }}>
                      {effectiveCar} · {FUEL_TYPES.find(f => f.id === fuelType)?.label}
                    </p>
                  )}
                </div>
              );
            })()}

            {/* ══ STEP 5: RESULT ═══════════════════════════════════════════════ */}
            {step === 'result' && analysis && (
              <div style={{ paddingTop: 28 }}>

                {/* ── Verdict icon ── */}
                <div style={{ textAlign: 'center', marginBottom: 24 }}>
                  <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center' }}>
                    {analysis.compatible ? (
                      <div style={{
                        width: 80, height: 80, borderRadius: '50%',
                        background: 'rgba(34,197,94,0.15)',
                        border: '2px solid rgba(34,197,94,0.35)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        <div style={{
                          width: 52, height: 52, borderRadius: '50%',
                          background: '#16A34A',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                          <CheckCircle2 style={{ width: 28, height: 28, color: '#fff', strokeWidth: 3 }} />
                        </div>
                      </div>
                    ) : analysis.caution ? (
                      <div style={{
                        width: 80, height: 80, borderRadius: '50%',
                        background: 'rgba(245,158,11,0.15)',
                        border: '2px solid rgba(245,158,11,0.35)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        <AlertTriangle style={{ width: 44, height: 44, color: '#F59E0B' }} />
                      </div>
                    ) : (
                      <div style={{
                        width: 80, height: 80, borderRadius: '50%',
                        background: 'rgba(239,68,68,0.15)',
                        border: '2px solid rgba(239,68,68,0.35)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        <div style={{
                          width: 52, height: 52, borderRadius: '50%',
                          background: '#DC2626',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                          <XCircle style={{ width: 28, height: 28, color: '#fff', strokeWidth: 3 }} />
                        </div>
                      </div>
                    )}
                  </div>
                  <h2 style={{ fontSize: 22, fontWeight: 900, color: 'var(--oof-text-hi)', marginBottom: 8 }}>
                    {analysis.compatible
                      ? 'Good to go!'
                      : analysis.caution
                        ? 'Proceed with caution'
                        : 'Wrong fuel for this engine'}
                  </h2>
                  <p style={{ fontSize: 14, color: 'var(--oof-text-lo)', lineHeight: 1.6, maxWidth: 340, margin: '0 auto' }}>
                    {analysis.analysis}
                  </p>
                </div>



                {/* ── Warning box (caution / incompatible) ── */}
                {analysis.warning && (
                  <div style={{
                    borderRadius: 16, padding: '16px 18px', marginBottom: 20,
                    background: analysis.caution ? 'rgba(245,158,11,0.18)' : 'rgba(239,68,68,0.18)',
                    border: `2px solid ${analysis.caution ? 'rgba(245,158,11,0.60)' : 'rgba(239,68,68,0.60)'}`,
                    display: 'flex', gap: 12, alignItems: 'flex-start',
                  }}>
                    <AlertTriangle style={{ width: 22, height: 22, color: analysis.caution ? '#FBBF24' : '#F87171', flexShrink: 0, marginTop: 1 }} />
                    <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--oof-text-hi)', lineHeight: 1.6, margin: 0 }}>
                      {analysis.warning}
                    </p>
                  </div>
                )}

                {/* ── Recommendation box ── */}
                <div style={{
                  borderRadius: 14, padding: '14px 16px', marginBottom: 28,
                  background: 'var(--oof-surface)', border: '1px solid var(--oof-border)',
                }}>
                  <p style={{ fontSize: 11, fontWeight: 700, color: '#22C55E', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 6px' }}>
                    Recommendation
                  </p>
                  <p style={{ fontSize: 13, color: 'var(--oof-text-md)', lineHeight: 1.55, margin: 0 }}>
                    {analysis.recommendation}
                  </p>
                </div>

                {/* ── CTAs ── */}
                {analysis.compatible && (
                  <button
                    onClick={() => goTo('station_scan')}
                    style={{
                      width: '100%', height: 54, borderRadius: 16, border: 'none',
                      background: 'linear-gradient(135deg, #22C55E, #16A34A)',
                      color: '#000', fontWeight: 800, fontSize: 16, cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                      boxShadow: '0 4px 24px rgba(34,197,94,0.40)',
                    }}
                  >
                    <MapPin style={{ width: 18, height: 18 }} /> Proceed to Find Stations
                  </button>
                )}

                {analysis.caution && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <button
                      onClick={() => goTo('station_scan')}
                      style={{
                        width: '100%', height: 54, borderRadius: 16, border: 'none',
                        background: 'linear-gradient(135deg, #22C55E, #16A34A)',
                        color: '#000', fontWeight: 800, fontSize: 16, cursor: 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                        boxShadow: '0 4px 24px rgba(34,197,94,0.35)',
                      }}
                    >
                      <MapPin style={{ width: 18, height: 18 }} /> Proceed to Find Stations
                    </button>
                    <button
                      onClick={() => goTo('fuel_switch')}
                      style={{
                        width: '100%', height: 44, borderRadius: 14,
                        border: '1.5px solid var(--oof-border)', background: 'transparent',
                        color: 'var(--oof-text-md)', fontWeight: 600, fontSize: 14, cursor: 'pointer',
                      }}
                    >
                      ← Switch to recommended fuel
                    </button>
                  </div>
                )}

                {!analysis.compatible && !analysis.caution && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <button
                      onClick={() => goTo('fuel_switch')}
                      style={{
                        width: '100%', height: 54, borderRadius: 16, border: 'none',
                        background: 'linear-gradient(135deg, #22C55E, #16A34A)',
                        color: '#000', fontWeight: 800, fontSize: 16, cursor: 'pointer',
                        boxShadow: '0 4px 24px rgba(34,197,94,0.35)',
                      }}
                    >
                      ← Switch to Compatible Fuel
                    </button>
                    <button
                      onClick={() => goTo('station_scan')}
                      style={{
                        width: '100%', padding: '14px 16px', borderRadius: 14,
                        border: '2px solid rgba(239,68,68,0.60)', background: 'rgba(239,68,68,0.18)',
                        color: 'var(--oof-text-hi)', fontWeight: 600, fontSize: 14, cursor: 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                      }}
                    >
                      <AlertTriangle style={{ width: 16, height: 16, color: '#F87171', flexShrink: 0 }} />
                      I understand the risk — find stations anyway
                    </button>

                  </div>
                )}

              </div>
            )}

            {/* ══ STEP 6: FUEL SWITCH ══════════════════════════════════════════ */}
            {step === 'fuel_switch' && analysis && (() => {
              const effectiveCar = carModel === 'Other' ? otherCar.trim() : carModel;
              const compatible = COMPATIBLE_FUELS[analysis.engine_type] ?? Object.keys(COMPATIBLE_FUELS).flatMap(k => COMPATIBLE_FUELS[k]);
              return (
                <div style={{ paddingTop: 16 }}>
                  {/* Back button */}
                  <button
                    onClick={() => goTo('result')}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: 'var(--oof-text-lo)', fontSize: 13, fontWeight: 600,
                      padding: '4px 0', marginBottom: 20,
                    }}
                  >
                    <ChevronRight style={{ width: 16, height: 16, transform: 'rotate(180deg)' }} />
                    Back
                  </button>

                  <div style={{ textAlign: 'center', marginBottom: 28 }}>
                    <div style={{ fontSize: 48, marginBottom: 12 }}>⛽</div>
                    <h2 style={{ fontSize: 20, fontWeight: 800, color: 'var(--oof-text-hi)', marginBottom: 8 }}>
                      Compatible fuels for your {effectiveCar}
                    </h2>
                    <p style={{ fontSize: 13, color: 'var(--oof-text-lo)', lineHeight: 1.5, maxWidth: 320, margin: '0 auto' }}>
                      Your engine type is <strong style={{ color: 'var(--oof-text-hi)' }}>{analysis.engine_type}</strong>. Only these fuels will run it safely — pick one and we'll find stations near you.
                    </p>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 28 }}>
                    {compatible.map(fuelId => {
                      const ft = FUEL_TYPES.find(f => f.id === fuelId);
                      if (!ft) return null;
                      const badge = fuelBadge(analysis.engine_type, fuelId);
                      const active = fuelType === fuelId;
                      return (
                        <button
                          key={fuelId}
                          onClick={() => setFuelType(fuelId)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 14,
                            padding: '14px 16px', borderRadius: 14, cursor: 'pointer', textAlign: 'left',
                            border: active ? '2px solid #22C55E' : '1.5px solid var(--oof-border)',
                            background: active ? 'rgba(34,197,94,0.12)' : 'var(--oof-surface)',
                            transition: 'all 0.15s ease',
                          }}
                        >
                          {/* Radio dot */}
                          <div style={{
                            width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
                            border: active ? '2px solid #22C55E' : '2px solid var(--oof-border)',
                            background: active ? '#22C55E' : 'transparent',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                          }}>
                            {active && <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#fff' }} />}
                          </div>
                          <span style={{ fontSize: 22 }}>{ft.emoji}</span>
                          <div style={{ flex: 1 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              <p style={{ fontSize: 14, fontWeight: 700, color: active ? 'var(--oof-text-hi)' : 'var(--oof-text-md)', margin: 0 }}>
                                {ft.label}
                              </p>
                              {badge === 'recommended' && (
                                <span style={{
                                  fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 9999,
                                  background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.35)',
                                  color: '#22C55E', textTransform: 'uppercase', letterSpacing: '0.05em',
                                }}>Recommended</span>
                              )}
                              {badge === 'caution' && (
                                <span style={{
                                  fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 9999,
                                  background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.35)',
                                  color: '#F59E0B', textTransform: 'uppercase', letterSpacing: '0.05em',
                                }}>Emergency only</span>
                              )}
                            </div>
                            <p style={{ fontSize: 11, color: 'var(--oof-text-faint)', margin: '2px 0 0' }}>
                              {badge === 'caution'
                                ? 'Lower octane risks knock under boost — use only if no premium available'
                                : ft.sub}
                            </p>
                          </div>
                          {/* Price estimate */}
                          {analysis.price_estimates?.[fuelId as keyof typeof analysis.price_estimates] && (
                            <span style={{
                              fontSize: 11, color: 'var(--oof-text-lo)', flexShrink: 0,
                              background: 'var(--oof-surface)', borderRadius: 8,
                              padding: '3px 8px', border: '1px solid var(--oof-divider)',
                            }}>
                              {analysis.price_estimates[fuelId as keyof typeof analysis.price_estimates]}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  <button
                    onClick={() => goTo('station_scan')}
                    disabled={!fuelType || !compatible.includes(fuelType)}
                    style={{
                      width: '100%', height: 54, borderRadius: 16, border: 'none',
                      background: (fuelType && compatible.includes(fuelType))
                        ? 'linear-gradient(135deg, #22C55E, #16A34A)'
                        : 'var(--oof-surface)',
                      color: (fuelType && compatible.includes(fuelType)) ? '#000' : 'var(--oof-text-faint)',
                      fontWeight: 800, fontSize: 16,
                      cursor: (fuelType && compatible.includes(fuelType)) ? 'pointer' : 'not-allowed',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                      boxShadow: (fuelType && compatible.includes(fuelType)) ? '0 4px 20px rgba(34,197,94,0.35)' : 'none',
                      transition: 'all 0.2s ease',
                    }}
                  >
                    <MapPin style={{ width: 18, height: 18 }} />
                    Confirm & Find Stations
                  </button>
                </div>
              );
            })()}

            {/* ══ STEP 7: STATION SCAN ANIMATION ══════════════════════════════ */}
            {step === 'station_scan' && (
              <div style={{ textAlign: 'center', paddingTop: 36, paddingBottom: 40 }}>

                {/* Concentric spinning rings + logo */}
                <div style={{ position: 'relative', width: 200, height: 200, margin: '0 auto 32px' }}>
                  <div style={{ position: 'absolute', inset: 0, animation: 'spin 10s linear infinite' }}>
                    <svg width="200" height="200" viewBox="0 0 200 200" fill="none">
                      <circle cx="100" cy="100" r="96" stroke="rgba(34,197,94,0.20)" strokeWidth="1" strokeDasharray="8 6" />
                    </svg>
                  </div>
                  <div style={{ position: 'absolute', inset: 0, animation: 'spin 1.8s linear infinite' }}>
                    <svg width="200" height="200" viewBox="0 0 200 200" fill="none">
                      <circle cx="100" cy="100" r="90" stroke="#22C55E" strokeWidth="2.5" strokeLinecap="round"
                        strokeDasharray="120 446" style={{ filter: 'drop-shadow(0 0 6px rgba(34,197,94,0.6))' }} />
                    </svg>
                  </div>
                  <div style={{ position: 'absolute', top: 28, left: 28, width: 144, height: 144, animation: 'spin-ccw 3s linear infinite' }}>
                    <svg width="144" height="144" viewBox="0 0 144 144" fill="none">
                      <circle cx="72" cy="72" r="68" stroke="rgba(34,197,94,0.35)" strokeWidth="1.5" strokeDasharray="5 9" />
                    </svg>
                  </div>
                  <div style={{ position: 'absolute', top: 48, left: 48, width: 104, height: 104, animation: 'spin 1.1s linear infinite' }}>
                    <svg width="104" height="104" viewBox="0 0 104 104" fill="none">
                      <circle cx="52" cy="52" r="48" stroke="rgba(34,197,94,0.45)" strokeWidth="2" strokeLinecap="round" strokeDasharray="48 254" />
                    </svg>
                  </div>
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{
                      position: 'absolute', width: 100, height: 100, borderRadius: 24,
                      background: 'rgba(34,197,94,0.18)', filter: 'blur(16px)',
                      animation: 'oof-badge-pulse 2s ease-in-out infinite',
                    }} />
                    <div style={{
                      position: 'relative', width: 88, height: 88, borderRadius: 22,
                      background: 'var(--oof-sheet)',
                      border: '2.5px solid rgba(34,197,94,0.90)',
                      boxShadow: '0 0 0 1px rgba(34,197,94,0.15), 0 0 24px rgba(34,197,94,0.6), 0 0 52px rgba(34,197,94,0.2)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      animation: 'oof-badge-pulse 2s ease-in-out infinite',
                    }}>
                      <img src="/motofix-logo.png" alt="MOTOFIX"
                        style={{ width: 64, height: 64, objectFit: 'contain' }}
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                    </div>
                  </div>
                </div>

                <h2 style={{ fontSize: 20, fontWeight: 800, color: 'var(--oof-text-hi)', marginBottom: 24 }}>
                  Finding Stations
                </h2>

                {/* Ticking checkmark steps */}
                <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 14, textAlign: 'left' }}>
                  {SCAN_STEPS.map((label, i) => {
                    if (scanStep < i) return null;
                    const done = scanStep > i;
                    return (
                      <div
                        key={label}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 12,
                          animation: 'oof-msg-in 0.4s ease both',
                        }}
                      >
                        {done ? (
                          <CheckCircle2 style={{ width: 22, height: 22, color: '#22C55E', flexShrink: 0 }} />
                        ) : (
                          <div style={{
                            width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                            border: '2px solid #22C55E',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                          }}>
                            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#22C55E', animation: 'oof-badge-pulse 1s ease-in-out infinite' }} />
                          </div>
                        )}
                        <span style={{
                          fontSize: 14, fontWeight: done ? 700 : 600,
                          color: done ? 'var(--oof-text-hi)' : '#22C55E',
                        }}>
                          {label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ══ STEP 8: STATIONS ═════════════════════════════════════════════ */}
            {step === 'stations' && (
              <div style={{ paddingTop: 16 }}>
                <div style={{ marginBottom: 16 }}>
                  <h2 style={{ fontSize: 18, fontWeight: 800, color: 'var(--oof-text-hi)', marginBottom: 4 }}>
                    ⛽ Nearby Fuel Stations
                  </h2>
                  <p style={{ fontSize: 12, color: 'var(--oof-text-faint)' }}>
                    {stations.length} real station{stations.length !== 1 ? 's' : ''} found near you · tap any for details
                  </p>
                </div>

                {/* Map */}
                <div style={{
                    position: 'relative',
                    height: mapHeight, borderRadius: 16, overflow: 'hidden',
                    border: '2px solid var(--oof-text-faint)', marginBottom: 16,
                    transition: 'height 0.3s ease',
                  }}>
                    <style>{LEAFLET_BASE_CSS}</style>
                    <MapContainer
                      center={driverPos ?? KAMPALA}
                      zoom={13}
                      style={MAP_CONTAINER}
                      zoomControl={false}
                    >
                      <MapViewport
                        mapRef={mapRef}
                        center={driverPos ?? KAMPALA}
                        points={driverPos ? [driverPos, ...stations.map(s => ({ lat: s.lat, lng: s.lng }))] : undefined}
                      />
                      <OpenFreeMapLayer />
                      {driverPos && (
                        <Marker
                          position={driverPos}
                          icon={navigating
                            ? new Icon({ iconUrl: NAV_CAR_SVG(userHeading), iconSize: [44, 44], iconAnchor: [22, 22] })
                            : new Icon({ iconUrl: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
                            '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="40" viewBox="0 0 32 40">' +
                            '<path d="M16 1C7.72 1 1 7.72 1 16C1 26.5 16 39 16 39C16 39 31 26.5 31 16C31 7.72 24.28 1 16 1Z" fill="#3B82F6" stroke="white" stroke-width="2"/>' +
                            '<circle cx="16" cy="12" r="4" fill="white"/>' +
                            '<path d="M8 24c0-4.42 3.58-8 8-8s8 3.58 8 8z" fill="white"/>' +
                            '</svg>'
                          )}`, iconSize: [32, 40], iconAnchor: [16, 40] })}
                          title="Your location"
                        >
                          <Popup>Your location</Popup>
                        </Marker>
                      )}
                      {stations.map(s => (
                        <Marker
                          key={s.place_id}
                          position={{ lat: s.lat, lng: s.lng }}
                          icon={stationMarkerIcon(s)}
                          eventHandlers={{ click: () => handleStationClick(s) }}
                        >
                          <Popup>{s.name}</Popup>
                        </Marker>
                      ))}
                      {directions && <Polyline positions={directions} pathOptions={{ color: '#22C55E', weight: 5, opacity: 0.85 }} />}
                    </MapContainer>

                    {/* Navigation banner */}
                    {navigating && (
                      <div style={{
                        position: 'absolute', top: 10, left: 10, right: 52, zIndex: 10,
                        background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)',
                        borderRadius: 12, padding: '8px 14px',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <Navigation2 style={{ width: 16, height: 16, color: '#22C55E' }} />
                          <span style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>
                            {routeInfo ? `${routeInfo.duration} · ${routeInfo.distance}` : 'Navigating…'}
                          </span>
                        </div>
                        <button
                          onClick={stopNavigation}
                          style={{ background: '#DC2626', border: 'none', borderRadius: 8, padding: '4px 10px', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                        >
                          Stop
                        </button>
                      </div>
                    )}

                    {/* Expand / minimise height toggle — top-right */}
                    <button
                      onClick={() => setMapHeight(h => h >= MAP_MAX ? 240 : MAP_MAX)}
                      style={{
                        position: 'absolute', top: 10, right: 10, zIndex: 10,
                        width: 34, height: 34, borderRadius: 8,
                        background: 'rgba(0,0,0,0.65)', border: '1px solid rgba(255,255,255,0.20)',
                        color: '#fff', cursor: 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        backdropFilter: 'blur(4px)',
                      }}
                    >
                      {mapHeight >= MAP_MAX
                        ? <Minimize2 style={{ width: 16, height: 16 }} />
                        : <Maximize2 style={{ width: 16, height: 16 }} />}
                    </button>

                    {/* Zoom in / out — bottom-right */}
                    <div style={{
                      position: 'absolute', bottom: 12, right: 10,
                      display: 'flex', flexDirection: 'column', gap: 4,
                      zIndex: 10,
                    }}>
                      {[{ label: '+', delta: 1 }, { label: '−', delta: -1 }].map(({ label, delta }) => (
                        <button
                          key={label}
                          onClick={() => {
                            const current = mapRef.current?.getZoom() ?? 13;
                            const next = Math.min(Math.max(current + delta, 8), 20);
                            mapRef.current?.setZoom(next);
                          }}
                          style={{
                            width: 32, height: 32, borderRadius: 8,
                            background: 'rgba(0,0,0,0.65)', border: '1px solid rgba(255,255,255,0.18)',
                            color: '#fff', fontSize: 18, lineHeight: 1, cursor: 'pointer',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            backdropFilter: 'blur(4px)',
                          }}
                        >{label}</button>
                      ))}
                    </div>
                  </div>

                {/* Section title */}
                {stations.length > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                    <div style={{ flex: 1, height: 1, background: 'var(--oof-divider)' }} />
                    <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--oof-text-faint)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: 0, whiteSpace: 'nowrap' }}>
                      Nearby gas &amp; fuel stations
                    </p>
                    <div style={{ flex: 1, height: 1, background: 'var(--oof-divider)' }} />
                  </div>
                )}

                {/* Station cards */}
                {stations.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '32px 16px' }}>
                    <div style={{ fontSize: 48, marginBottom: 16 }}>{gpsError ? '📍' : '⛽'}</div>
                    <p style={{ fontSize: 16, fontWeight: 700, color: 'var(--oof-text-hi)', marginBottom: 8 }}>
                      {gpsError ? 'Location access needed' : 'No stations found nearby'}
                    </p>
                    <p style={{ fontSize: 13, color: 'var(--oof-text-lo)', lineHeight: 1.6, marginBottom: 20 }}>
                      {gpsError
                        ? 'MOTOFIX needs your GPS location to find the nearest fuel stations. Please allow location access and try again.'
                        : 'No fuel stations were found on Google Maps near your current location. Tap below to search a wider area.'}
                    </p>
                    <button
                      onClick={retryLocation}
                      style={{
                        padding: '12px 28px', borderRadius: 14, border: 'none',
                        background: 'linear-gradient(135deg, #22C55E, #16A34A)',
                        color: '#000', fontWeight: 800, fontSize: 14, cursor: 'pointer',
                        boxShadow: '0 4px 16px rgba(34,197,94,0.35)',
                      }}
                    >
                      {gpsError ? '📍 Enable Location & Retry' : '🔄 Try Searching a Wider Area'}
                    </button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    {stations.map((s, i) => {
                      const isActive = selected?.place_id === s.place_id;
                      const filled = Math.round(s.rating ?? 4);
                      return (
                        <div key={s.place_id} className="oof-station-card" onClick={() => { setSelected(s); setDetailStation(s); }} style={{
                          display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer',
                          padding: '14px 6px',
                          borderTop: i === 0 ? 'none' : '1px solid var(--oof-divider)',
                          background: isActive ? 'var(--oof-surface)' : 'transparent',
                        }}>
                          {/* Text block — Google-style listing */}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <p style={{ fontSize: 15.5, fontWeight: 700, color: 'var(--oof-text-hi)', margin: 0, lineHeight: 1.25 }}>{s.name}</p>

                            {s.rating != null && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 5, margin: '3px 0 0' }}>
                                <span style={{ fontSize: 12.5, fontWeight: 700, color: '#E7711B' }}>{s.rating.toFixed(1)}</span>
                                <span style={{ display: 'flex', gap: 0.5 }}>
                                  {[0, 1, 2, 3, 4].map(n => (
                                    <Star key={n} style={{ width: 11, height: 11, color: '#FBBF24', fill: n < filled ? '#FBBF24' : 'transparent' }} />
                                  ))}
                                </span>
                                <span style={{ fontSize: 12, color: 'var(--oof-text-faint)' }}>({s.user_ratings_total})</span>
                              </div>
                            )}

                            <p style={{ fontSize: 12.5, color: 'var(--oof-text-lo)', margin: '3px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              Gas station{s.vicinity && s.vicinity !== 'Uganda' ? ` · ${s.vicinity}` : ''}
                            </p>

                            <p style={{ fontSize: 12.5, margin: '3px 0 0' }}>
                              <span style={{ color: s.open_now === false ? '#EA4335' : '#1E8E3E', fontWeight: 600 }}>
                                {s.open_now === false ? 'Closed' : (s.is24h ? 'Open 24 hours' : 'Open')}
                              </span>
                              <span style={{ color: 'var(--oof-text-faint)' }}> · {s.distance_km} km · ⛽ {fmtUGX(s.petrol)}</span>
                            </p>
                          </div>

                          {/* Directions button — like Google Maps rows */}
                          <button
                            onClick={e => { e.stopPropagation(); setSelected(s); setProfileStation(s); }}
                            style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, background: 'none', border: 'none', cursor: 'pointer', padding: '2px 2px' }}
                          >
                            <div style={{ width: 38, height: 38, borderRadius: '50%', border: '1.5px solid #4285F4', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              <Navigation2 style={{ width: 17, height: 17, color: '#4285F4' }} />
                            </div>
                            <span style={{ fontSize: 10, color: '#4285F4', fontWeight: 600 }}>Directions</span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Fuel delivery CTA */}
                <div style={{
                  marginTop: 20, padding: '16px',
                  background: 'rgba(245,158,11,0.07)', border: '1.5px solid rgba(245,158,11,0.22)',
                  borderRadius: 16,
                }}>
                  <p style={{ fontSize: 13, fontWeight: 700, color: '#F59E0B', marginBottom: 4 }}>🚗 Can't make it to a station?</p>
                  <p style={{ fontSize: 12, color: 'var(--oof-text-lo)', marginBottom: 12, lineHeight: 1.5 }}>
                    Request fuel delivery directly to your location. A MOTOFIX provider will bring {selectedFuelLabel} to you.
                  </p>
                  <button
                    onClick={requestDelivery}
                    disabled={loadingDelivery}
                    style={{
                      width: '100%', height: 46, borderRadius: 12, border: 'none',
                      background: 'linear-gradient(135deg, #F59E0B, #D97706)',
                      color: '#000', fontWeight: 800, fontSize: 14,
                      cursor: loadingDelivery ? 'not-allowed' : 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                    }}
                  >
                    {loadingDelivery
                      ? <><Loader2 style={{ width: 16, height: 16, animation: 'spin 1s linear infinite' }} /> Requesting…</>
                      : <><Phone style={{ width: 15, height: 15 }} /> Request Fuel Delivery to Me</>
                    }
                  </button>
                </div>
              </div>
            )}

          </div>
        </div>
      </div>

      {/* Station detail — website-style profile */}
      {detailStation && (
        <StationDetailPopup
          station={detailStation}
          onClose={() => setDetailStation(null)}
          onDirections={() => { const s = detailStation; setSelected(s); setDetailStation(null); setProfileStation(s); }}
        />
      )}

      {/* Directions + 3D locator map */}
      {profileStation && (
        <StationProfileModal
          station={profileStation}
          driverPos={driverPos}
          isLoaded={isLoaded}
          onClose={() => setProfileStation(null)}
        />
      )}
    </div>,
    document.body,
  );
}

// ── Shared little styles / row ───────────────────────────────────────────────
const chip = (c: string): CSSProperties => ({ fontSize: 12, fontWeight: 700, padding: '6px 12px', borderRadius: 9999, background: `${c}1f`, border: `1.5px solid ${c}55`, color: c, display: 'flex', alignItems: 'center', gap: 5 });
const sectionLabel: CSSProperties = { fontSize: 11, fontWeight: 700, color: 'var(--oof-text-faint)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 10px' };

function InfoRow({ icon, label, value, href }: { icon: ReactNode; label: string; value: string; href?: string }) {
  const inner = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 0', borderBottom: '1px solid var(--oof-divider)' }}>
      <div style={{ width: 28, display: 'flex', justifyContent: 'center', flexShrink: 0 }}>{icon}</div>
      <div style={{ minWidth: 0 }}>
        <p style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--oof-text-faint)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0 }}>{label}</p>
        <p style={{ fontSize: 13, fontWeight: 600, color: href ? '#60A5FA' : 'var(--oof-text-md)', margin: '2px 0 0' }}>{value}</p>
      </div>
    </div>
  );
  return href ? <a href={href} style={{ textDecoration: 'none' }}>{inner}</a> : inner;
}

// ── Station Detail — website-style profile page ──────────────────────────────
function StationDetailPopup({
  station, onClose, onDirections,
}: {
  station: SimStation;
  onClose: () => void;
  onDirections: () => void;
}) {
  const [shot, setShot] = useState(0);
  const etaMin = Math.max(1, Math.round(station.distance_km * 2.4));
  const prices = [
    { label: 'Petrol', emoji: '⛽', value: station.petrol },
    { label: 'Diesel', emoji: '🛢️', value: station.diesel },
    { label: 'Super',  emoji: '⭐', value: station.superPetrol },
  ];

  return createPortal(
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,0.80)', backdropFilter: 'blur(10px)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
      onClick={onClose}
    >
      <div
        style={{ width: '100%', maxWidth: 480, maxHeight: '92vh', background: 'var(--oof-sheet)', borderRadius: '24px 24px 0 0', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}
        onClick={e => e.stopPropagation()}
      >
        {/* ── Hero: real brand photos, or a clean branded header if none ── */}
        <div style={{ position: 'relative', height: 230, flexShrink: 0, background: station.photos.length ? '#0b1020' : `linear-gradient(135deg, ${station.color}, ${station.color2})` }}>
          {station.photos.length > 0 ? (
            <div
              onScroll={e => { const el = e.currentTarget; setShot(Math.round(el.scrollLeft / Math.max(1, el.clientWidth))); }}
              style={{ display: 'flex', height: '100%', overflowX: 'auto', scrollSnapType: 'x mandatory', WebkitOverflowScrolling: 'touch' }}
            >
              {station.photos.map((src, i) => (
                <div key={i} style={{ position: 'relative', minWidth: '100%', height: '100%', scrollSnapAlign: 'start', background: '#0b1020' }}>
                  <img src={src} alt={station.name} loading="lazy" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
                </div>
              ))}
            </div>
          ) : (
            /* No verified brand photo — branded placeholder (never a wrong brand) */
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <span style={{ fontSize: 48, fontWeight: 900, color: '#fff', letterSpacing: 1, textShadow: '0 2px 14px rgba(0,0,0,0.35)' }}>{station.mark}</span>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: 'rgba(255,255,255,0.9)', display: 'flex', alignItems: 'center', gap: 5 }}>📷 Photo unavailable</span>
            </div>
          )}
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to top, rgba(0,0,0,0.80) 0%, transparent 46%)', pointerEvents: 'none' }} />
          {/* pagination dots */}
          {station.photos.length > 1 && (
            <div style={{ position: 'absolute', bottom: 38, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 6, pointerEvents: 'none' }}>
              {station.photos.map((_, i) => (
                <span key={i} style={{ width: i === shot ? 18 : 6, height: 6, borderRadius: 3, background: i === shot ? '#fff' : 'rgba(255,255,255,0.5)', transition: 'width 0.2s' }} />
              ))}
            </div>
          )}
          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '14px 20px', pointerEvents: 'none' }}>
            <span style={{ display: 'inline-block', fontSize: 10, fontWeight: 800, color: '#fff', background: station.color, borderRadius: 6, padding: '3px 9px', marginBottom: 7, letterSpacing: '0.05em', textTransform: 'uppercase' }}>{station.brand}</span>
            <h2 style={{ fontSize: 21, fontWeight: 900, color: '#fff', margin: 0, textShadow: '0 1px 8px rgba(0,0,0,0.6)' }}>{station.name}</h2>
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.82)', margin: '3px 0 0' }}>{station.tagline}</p>
          </div>
          <button onClick={onClose} style={{ position: 'absolute', top: 14, right: 14, width: 34, height: 34, borderRadius: '50%', background: 'rgba(0,0,0,0.55)', border: '1.5px solid rgba(255,255,255,0.20)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <X style={{ width: 16, height: 16, color: '#fff' }} />
          </button>
        </div>

        {/* ── Body ── */}
        <div style={{ padding: '18px 20px 32px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* Google-style rating + type + quick actions */}
          <div>
            {station.rating != null && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: '#E7711B' }}>{station.rating.toFixed(1)}</span>
                <span style={{ display: 'flex', gap: 1 }}>
                  {[0, 1, 2, 3, 4].map(n => (
                    <Star key={n} style={{ width: 14, height: 14, color: '#FBBF24', fill: n < Math.round(station.rating!) ? '#FBBF24' : 'transparent' }} />
                  ))}
                </span>
                <span style={{ fontSize: 13, color: 'var(--oof-text-faint)' }}>({station.user_ratings_total})</span>
              </div>
            )}
            <p style={{ fontSize: 13, color: 'var(--oof-text-lo)', margin: '5px 0 0' }}>
              Gas station · {station.distance_km} km away · ~{etaMin} min ·{' '}
              <span style={{ color: station.open_now === false ? '#EA4335' : '#1E8E3E', fontWeight: 600 }}>
                {station.open_now === false ? 'Closed' : (station.is24h ? 'Open 24 hours' : 'Open')}
              </span>
            </p>
            <div style={{ display: 'flex', gap: 26, marginTop: 16 }}>
              {[
                { label: 'Directions', icon: <Navigation2 style={{ width: 19, height: 19, color: '#fff' }} />, primary: true as const, onClick: onDirections },
                { label: 'Call', icon: <Phone style={{ width: 18, height: 18, color: '#1A73E8' }} />, href: `tel:${station.phone.replace(/\s/g, '')}` },
                { label: 'Maps', icon: <MapPin style={{ width: 18, height: 18, color: '#1A73E8' }} />, href: station.maps_url },
              ].map(a => {
                const inner = (
                  <>
                    <div style={{ width: 46, height: 46, borderRadius: '50%', border: a.primary ? 'none' : '1.5px solid var(--oof-border)', background: a.primary ? '#1A73E8' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{a.icon}</div>
                    <span style={{ fontSize: 11, fontWeight: 600, color: '#1A73E8' }}>{a.label}</span>
                  </>
                );
                return a.href
                  ? <a key={a.label} href={a.href} target={a.href.startsWith('http') ? '_blank' : undefined} rel="noreferrer" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, textDecoration: 'none' }}>{inner}</a>
                  : <button key={a.label} onClick={a.onClick} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>{inner}</button>;
              })}
            </div>
          </div>

          {/* pump prices */}
          <div>
            <p style={sectionLabel}>Today's pump prices · per litre</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              {prices.map(p => (
                <div key={p.label} style={{ padding: '12px 6px', borderRadius: 14, background: `${station.color}12`, border: `1.5px solid ${station.color}33`, textAlign: 'center' }}>
                  <p style={{ fontSize: 18, margin: '0 0 2px' }}>{p.emoji}</p>
                  <p style={{ fontSize: 13, fontWeight: 900, color: 'var(--oof-text-hi)', margin: 0 }}>{p.value.toLocaleString()}</p>
                  <p style={{ fontSize: 9.5, fontWeight: 700, color: station.color, margin: '2px 0 0', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{p.label}</p>
                </div>
              ))}
            </div>
            <p style={{ fontSize: 10, color: 'var(--oof-text-faint)', margin: '7px 0 0', textAlign: 'center' }}>Indicative UGX prices — confirm at the pump</p>
          </div>

          {/* address / hours / phone */}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <InfoRow icon={<MapPin style={{ width: 15, height: 15, color: station.color }} />} label="Address" value={station.vicinity || 'Uganda'} />
            <InfoRow icon={<span style={{ fontSize: 14 }}>🕒</span>} label="Opening hours" value={station.hours} />
            <InfoRow icon={<Phone style={{ width: 15, height: 15, color: station.color }} />} label="Phone" value={station.phone} href={`tel:${station.phone.replace(/\s/g, '')}`} />
          </div>

          {/* amenities */}
          <div>
            <p style={sectionLabel}>Services & amenities</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
              {station.services.map(svc => (
                <div key={svc.label} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 12px', borderRadius: 12, background: 'var(--oof-surface)', border: '1px solid var(--oof-border)' }}>
                  <span style={{ fontSize: 16, flexShrink: 0 }}>{svc.icon}</span>
                  <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--oof-text-md)', margin: 0, lineHeight: 1.25 }}>{svc.label}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Primary CTA — opens the live route + 3D locator map */}
          <button onClick={onDirections} style={{ width: '100%', height: 52, borderRadius: 14, border: 'none', background: '#1A73E8', color: '#fff', fontWeight: 700, fontSize: 15, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <Navigation2 style={{ width: 18, height: 18 }} /> Directions &amp; 3D view
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Station locator map with an estimated straight-line route ────────────────
function StationProfileModal({ station, driverPos, onClose }: {
  station: SimStation;
  driverPos: { lat: number; lng: number } | null;
  onClose: () => void;
}) {
  const mapRef = useRef<LeafletMap | null>(null);
  const [directions, setDirections] = useState<LL[] | null>(null);
  const [info, setInfo] = useState<{ duration: string; distance: string } | null>(null);
  const [navOn, setNavOn] = useState(false);   // in-app turn-by-turn mode
  const dest = { lat: station.lat, lng: station.lng };

  useEffect(() => {
    if (!driverPos) {
      setDirections(null);
      setInfo(null);
      return;
    }
    const distanceKm = Math.max(haversineM(driverPos, dest) / 1000, station.distance_km || 0);
    const durationMinutes = Math.max(1, Math.round((distanceKm / 25) * 60));
    setDirections([driverPos, dest]);
    setInfo({
      distance: `${distanceKm.toFixed(1)} km`,
      duration: durationMinutes < 60
        ? `${durationMinutes} min`
        : `${Math.floor(durationMinutes / 60)} hr ${durationMinutes % 60} min`,
    });
  }, [driverPos?.lat, driverPos?.lng, station.distance_km, station.lat, station.lng]);

  const fit = (m: LeafletMap) => {
    const points = driverPos ? [driverPos, dest] : [dest];
    if (points.length > 1) {
      m.fitBounds(points.map(({ lat, lng }) => [lat, lng]) as [number, number][], { padding: [48, 48] });
    } else {
      m.setView(dest, 15);
    }
  };

  const pin = (color: string) => `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="50" viewBox="0 0 40 50">' +
    '<path d="M20 1C10 1 2 9 2 19C2 32 20 49 20 49C20 49 38 32 38 19C38 9 30 1 20 1Z" fill="' + color + '" stroke="white" stroke-width="2.5"/>' +
    '<circle cx="20" cy="18" r="7" fill="white"/></svg>'
  )}`;

  // Google-style red fuel-station marker (pump glyph) — clearly NOT the driver pin.
  const fuelIcon = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="46" viewBox="0 0 40 46">' +
    '<path d="M20 45 L12.5 33 H27.5 Z" fill="#EA4335"/>' +
    '<rect x="5" y="2.5" width="30" height="33" rx="9" fill="#EA4335" stroke="#fff" stroke-width="2"/>' +
    '<g fill="#fff">' +
    '<rect x="14" y="10" width="9" height="16" rx="1.6"/>' +
    '<rect x="16" y="12.5" width="5" height="4.5" rx="0.8" fill="#EA4335"/>' +
    '<rect x="16" y="19.6" width="5" height="1.6" rx="0.7" fill="#EA4335"/>' +
    '<rect x="16" y="22.3" width="5" height="1.6" rx="0.7" fill="#EA4335"/>' +
    '<path d="M23 13 h2 a1.8 1.8 0 0 1 1.8 1.8 v5.6 a1.5 1.5 0 0 0 3 0 v-4.4 l-1.6 -1.6" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</g></svg>'
  )}`;

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 3000, background: '#000', display: 'flex', flexDirection: 'column' }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', background: 'rgba(0,0,0,0.92)', flexShrink: 0, borderBottom: '1px solid rgba(255,255,255,0.10)' }}>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center', gap: 6, color: '#60A5FA', fontWeight: 700, fontSize: 14 }}>
          <ChevronRight style={{ width: 16, height: 16, transform: 'rotate(180deg)' }} /> Back
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 15, fontWeight: 800, color: '#fff', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{station.name}</p>
          <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.50)', margin: 0 }}>{station.distance_km} km away · {station.brand}</p>
        </div>
        <span style={{ fontSize: 10, fontWeight: 800, color: '#fff', background: station.color, borderRadius: 6, padding: '3px 8px' }}>{station.mark}</span>
      </div>

      {/* map */}
      <div style={{ flex: 1, position: 'relative' }}>
        <style>{LEAFLET_BASE_CSS}</style>
        <MapContainer center={driverPos ?? dest ?? KAMPALA} zoom={15} style={{ width: '100%', height: '100%' }} zoomControl={false}>
          <MapViewport mapRef={mapRef} center={driverPos ?? dest ?? KAMPALA} points={directions ?? undefined} zoom={15} />
          <OpenFreeMapLayer />
          {driverPos && (
            <Marker position={driverPos} icon={new Icon({ iconUrl: pin('#3B82F6'), iconSize: [34, 43], iconAnchor: [17, 42] })}>
              <Popup>Your location</Popup>
            </Marker>
          )}
          <Marker position={dest} icon={new Icon({ iconUrl: fuelIcon, iconSize: [40, 46], iconAnchor: [20, 45] })}>
            <Popup>{station.name}</Popup>
          </Marker>
          {directions && <Polyline positions={directions} pathOptions={{ color: station.color, weight: 6, opacity: 0.9 }} />}
        </MapContainer>

        {/* zoom */}
        <div style={{ position: 'absolute', bottom: 188, right: 14, display: 'flex', flexDirection: 'column', gap: 5, zIndex: 6 }}>
          {[{ l: '+', d: 1 }, { l: '−', d: -1 }].map(({ l, d }) => (
            <button key={l} onClick={() => { const m = mapRef.current; if (m) m.setZoom(Math.min(Math.max(m.getZoom() + d, 6), 21)); }} style={{ width: 38, height: 38, borderRadius: 10, background: 'rgba(0,0,0,0.72)', border: '1px solid rgba(255,255,255,0.20)', color: '#fff', fontSize: 20, lineHeight: 1, cursor: 'pointer', backdropFilter: 'blur(4px)' }}>{l}</button>
          ))}
        </div>

        {/* route info card */}
        <div style={{ position: 'absolute', left: 14, right: 14, bottom: 92, background: 'rgba(10,14,30,0.92)', backdropFilter: 'blur(8px)', borderRadius: 16, padding: '12px 15px', border: '1px solid rgba(255,255,255,0.12)', display: 'flex', alignItems: 'center', gap: 13, zIndex: 6 }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: station.color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Navigation2 style={{ width: 22, height: 22, color: '#fff' }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: 17, fontWeight: 800, color: '#fff', margin: 0 }}>
              {info ? `${info.duration} · ${info.distance}` : (driverPos ? 'Calculating route…' : 'Enable GPS for directions')}
            </p>
            <p style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.6)', margin: '2px 0 0' }}>Shortest driving route to {station.brand}</p>
          </div>
        </div>

        {/* Start navigation — in-app turn-by-turn (stays inside MOTOFIX) */}
        <button
          onClick={() => { if (directions) setNavOn(true); }}
          disabled={!directions}
          style={{ position: 'absolute', left: 14, right: 14, bottom: 22, height: 54, borderRadius: 14, border: 'none', background: directions ? '#1A73E8' : '#3a4255', color: '#fff', fontWeight: 800, fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, cursor: directions ? 'pointer' : 'default', boxShadow: '0 6px 22px rgba(26,115,232,0.55)', zIndex: 7 }}
        >
          <Navigation2 style={{ width: 20, height: 20 }} /> Start navigation
        </button>
      </div>

      {navOn && directions && (
        <NavView route={directions} station={station} routeInfo={info} onExit={() => setNavOn(false)} />
      )}
    </div>,
    document.body,
  );
}

// ── Helpers for in-app navigation ────────────────────────────────────────────
function stripHtml(html?: string): string {
  if (!html) return '';
  const d = document.createElement('div');
  d.innerHTML = html;
  return (d.textContent || d.innerText || '').replace(/\s+/g, ' ').trim();
}
function bearingDeg(a: LL, b: LL): number {
  const p1 = a.lat * Math.PI / 180, p2 = b.lat * Math.PI / 180, dl = (b.lng - a.lng) * Math.PI / 180;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function maneuverEmoji(m?: string): string {
  if (!m) return '⬆️';
  if (m.includes('uturn')) return '↩️';
  if (m.includes('left')) return '⬅️';
  if (m.includes('right')) return '➡️';
  if (m.includes('roundabout') || m.includes('rotary')) return '🔄';
  if (m.includes('merge') || m.includes('ramp') || m.includes('fork')) return '↗️';
  return '⬆️';
}
function fmtMeters(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.max(0, Math.round(m / 10) * 10)} m`;
}

// ── Landmark lookup (OpenStreetMap) to make directions reference real places ──
interface Landmark { name: string; lat: number; lng: number }

function haversineM(a: LL, b: LL): number {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

/** Named shops / businesses / places near the route, used as turn references. */
async function fetchLandmarks(points: LL[]): Promise<Landmark[]> {
  if (points.length === 0) return [];
  const lats = points.map(p => p.lat), lngs = points.map(p => p.lng);
  const pad = 0.0014;
  const bbox = `${Math.min(...lats) - pad},${Math.min(...lngs) - pad},${Math.max(...lats) + pad},${Math.max(...lngs) + pad}`;
  // Nodes only + short timeout = fast & far less likely to 504 than way lookups.
  const q = '[out:json][timeout:12];('
    + `node[name][amenity](${bbox});node[name][shop](${bbox});node[name][office](${bbox});node[name][craft](${bbox});`
    + ');out tags 300;';
  const urls = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  for (let attempt = 0; attempt < 2; attempt++) {   // mirrors 504 under load — retry
    for (const url of urls) {
      try {
        const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: q }) });
        if (!res.ok) continue;
        const data = await res.json();
        const out: Landmark[] = [];
        for (const el of (data.elements ?? [])) {
          const name = el.tags?.name;
          if (el.lat != null && el.lon != null && name) out.push({ name, lat: el.lat, lng: el.lon });
        }
        if (out.length) return out;
      } catch { /* try the next mirror */ }
    }
  }
  return [];
}

function nearestLandmark(pt: LL, landmarks: Landmark[], maxM = 110): string {
  let best = '', bestD = maxM;
  for (const l of landmarks) {
    const d = haversineM(pt, { lat: l.lat, lng: l.lng });
    if (d < bestD) { bestD = d; best = l.name; }
  }
  return best;
}

// ── In-app turn-by-turn directions (manual checklist, no voice) ──────────────
// Stays inside MOTOFIX: a north-up map with a route line + a blue arrow whose
// tip points along the route, and a tick-through list of the real Directions
// steps (street names + distances). On arrival it asks whether the driver can
// actually see the station, and offers help if not.
function NavView({ route, station, onExit }: {
  route: google.maps.DirectionsRoute;
  station: SimStation;
  onExit: () => void;
}) {
  const MAP_ID = import.meta.env.VITE_GOOGLE_MAPS_MAP_ID?.trim() || undefined;
  const mapRef = useRef<google.maps.Map | null>(null);
  const steps = route.legs?.[0]?.steps ?? [];
  const [doneCount, setDoneCount] = useState(0);
  const [prompt, setPrompt] = useState(false);
  const [outcome, setOutcome] = useState<'' | 'seen' | 'notseen'>('');
  const [landmarks, setLandmarks] = useState<Landmark[]>([]);

  const ll = (p: google.maps.LatLng): LL => ({ lat: p.lat(), lng: p.lng() });
  const startLL = (s: google.maps.DirectionsStep) => ll(s.start_location);
  const endLL = (s: google.maps.DirectionsStep) => ll(s.end_location);
  const stepPath = (s: google.maps.DirectionsStep): LL[] => {
    const p = (s.path ?? []) as google.maps.LatLng[];
    return p.length >= 2 ? p.map(ll) : [startLL(s), endLL(s)];
  };

  // Pull nearby named places once, then attach the closest to each turn point.
  useEffect(() => { fetchLandmarks(steps.map(startLL)).then(setLandmarks).catch(() => {}); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  const stepLandmarks = useMemo(() => steps.map(s => nearestLandmark(startLL(s), landmarks)), [landmarks]);   // eslint-disable-line react-hooks/exhaustive-deps

  const curPos: LL = doneCount === 0
    ? (steps[0] ? startLL(steps[0]) : { lat: station.lat, lng: station.lng })
    : endLL(steps[Math.min(doneCount, steps.length) - 1]);
  const nextStep = steps[doneCount];
  const heading = nextStep
    ? bearingDeg(curPos, endLL(nextStep))
    : (steps.length ? bearingDeg(startLL(steps[steps.length - 1]), endLL(steps[steps.length - 1])) : 0);

  const donePath = useMemo(() => steps.slice(0, doneCount).flatMap(stepPath), [doneCount]);   // eslint-disable-line react-hooks/exhaustive-deps
  const remPath = useMemo(() => steps.slice(doneCount).flatMap(stepPath), [doneCount]);        // eslint-disable-line react-hooks/exhaustive-deps
  const remainingMeters = steps.slice(doneCount).reduce((a, s) => a + (s.distance?.value ?? 0), 0);

  useEffect(() => { const m = mapRef.current; if (m) m.panTo(curPos); }, [doneCount]);          // eslint-disable-line react-hooks/exhaustive-deps

  const tick = (i: number) => {
    const nd = i < doneCount ? i : i + 1;   // tap a done step to un-tick; else tick through it
    setDoneCount(nd);
    if (nd >= steps.length) setPrompt(true);
  };

  const fitAll = (m: google.maps.Map) => {
    try {
      const b = new window.google.maps.LatLngBounds();
      (route.overview_path ?? []).forEach(p => b.extend(p));
      b.extend({ lat: station.lat, lng: station.lng });
      m.fitBounds(b, 60);
    } catch { /* noop */ }
  };

  const fuelMarker = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="46" viewBox="0 0 40 46"><path d="M20 45 L12.5 33 H27.5 Z" fill="#EA4335"/><rect x="5" y="2.5" width="30" height="33" rx="9" fill="#EA4335" stroke="#fff" stroke-width="2"/><g fill="#fff"><rect x="14" y="10" width="9" height="16" rx="1.6"/><rect x="16" y="12.5" width="5" height="4.5" rx="0.8" fill="#EA4335"/></g></svg>'
  )}`;
  const arrowSvg = (deg: number) => `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44"><circle cx="22" cy="22" r="19" fill="#1A73E8" stroke="#fff" stroke-width="3"/><g transform="rotate(${Math.round(deg)} 22 22)"><path d="M22 7 L33 33 L22 27 L11 33 Z" fill="#fff"/></g></svg>`
  )}`;

  const overlayWrap: CSSProperties = { position: 'absolute', inset: 0, zIndex: 20, background: 'rgba(0,0,0,0.78)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 22 };
  const card: CSSProperties = { width: '100%', maxWidth: 380, background: '#11162a', borderRadius: 22, border: '1px solid rgba(255,255,255,0.12)', padding: '26px 22px', textAlign: 'center' };

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 4000, background: '#0b1020', display: 'flex', flexDirection: 'column' }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', paddingTop: 'max(12px, env(safe-area-inset-top, 12px))', background: '#0b1020', flexShrink: 0, borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
        <button onClick={onExit} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#60A5FA', display: 'flex', alignItems: 'center', gap: 5, fontWeight: 700, fontSize: 14 }}>
          <ChevronRight style={{ width: 16, height: 16, transform: 'rotate(180deg)' }} /> Exit
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 14.5, fontWeight: 800, color: '#fff', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Directions to {station.name}</p>
          <p style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.55)', margin: 0 }}>{fmtMeters(remainingMeters)} left · {Math.max(0, steps.length - doneCount)} step{steps.length - doneCount !== 1 ? 's' : ''} to go</p>
        </div>
      </div>

      {/* map */}
      <div style={{ height: '40vh', minHeight: 210, position: 'relative', flexShrink: 0 }}>
        <GoogleMap
          mapContainerStyle={{ width: '100%', height: '100%' }}
          center={curPos}
          zoom={15}
          onLoad={m => { mapRef.current = m; fitAll(m); }}
          options={{ disableDefaultUI: true, gestureHandling: 'greedy', clickableIcons: false, ...(MAP_ID ? { mapId: MAP_ID } : {}) }}
        >
          {donePath.length >= 2 && <Polyline path={donePath} options={{ strokeColor: '#94a3b8', strokeWeight: 7, strokeOpacity: 0.8 }} />}
          {remPath.length >= 2 && <Polyline path={remPath} options={{ strokeColor: '#1A73E8', strokeWeight: 7, strokeOpacity: 0.95 }} />}
          <Marker position={{ lat: station.lat, lng: station.lng }} icon={{ url: fuelMarker, scaledSize: new window.google.maps.Size(38, 44), anchor: new window.google.maps.Point(19, 42) }} />
          <Marker position={curPos} icon={{ url: arrowSvg(heading), scaledSize: new window.google.maps.Size(44, 44), anchor: new window.google.maps.Point(22, 22) }} zIndex={5} />
        </GoogleMap>
        <button onClick={() => { const m = mapRef.current; if (m) fitAll(m); }} style={{ position: 'absolute', top: 10, right: 10, height: 34, padding: '0 12px', borderRadius: 9, background: 'rgba(0,0,0,0.7)', border: '1px solid rgba(255,255,255,0.2)', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer', backdropFilter: 'blur(4px)' }}>Whole route</button>
      </div>

      {/* directions checklist */}
      <div style={{ flex: 1, overflowY: 'auto', background: '#0b1020' }}>
        <p style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '12px 18px 4px' }}>Tick each step as you reach it</p>
        {steps.map((s, i) => {
          const done = i < doneCount;
          const isNext = i === doneCount;
          return (
            <button key={i} onClick={() => tick(i)} style={{ width: '100%', display: 'flex', alignItems: 'flex-start', gap: 12, padding: '13px 18px', background: isNext ? 'rgba(26,115,232,0.12)' : 'transparent', border: 'none', borderBottom: '1px solid rgba(255,255,255,0.07)', cursor: 'pointer', textAlign: 'left' }}>
              {done
                ? <CheckCircle2 style={{ width: 24, height: 24, color: '#22C55E', flexShrink: 0, marginTop: 1 }} />
                : <span style={{ width: 24, height: 24, borderRadius: '50%', flexShrink: 0, marginTop: 1, border: `2px solid ${isNext ? '#60A5FA' : 'rgba(255,255,255,0.3)'}`, display: 'block' }} />}
              <span style={{ fontSize: 18, lineHeight: 1.2, flexShrink: 0 }}>{maneuverEmoji(s.maneuver)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 13.5, fontWeight: 600, color: done ? 'rgba(255,255,255,0.45)' : '#fff', margin: 0, textDecoration: done ? 'line-through' : 'none', lineHeight: 1.35 }}>
                  {stripHtml(s.instructions)}
                  {stepLandmarks[i] && !done && <span style={{ color: '#FBBF24', fontWeight: 700 }}> — by {stepLandmarks[i]}</span>}
                </p>
                <p style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.45)', margin: '2px 0 0' }}>{fmtMeters(s.distance?.value ?? 0)}{s.duration?.text ? ` · about ${s.duration.text}` : ''}</p>
              </div>
            </button>
          );
        })}
        {/* arrival row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px 20px' }}>
          <span style={{ width: 24, height: 24, borderRadius: '50%', flexShrink: 0, border: '2px solid #EA4335', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12 }}>🏁</span>
          <div>
            <p style={{ fontSize: 13.5, fontWeight: 700, color: '#fff', margin: 0 }}>Arrive at {station.name}</p>
            <p style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.45)', margin: '2px 0 0' }}>{station.vicinity}</p>
          </div>
        </div>
      </div>

      {/* bottom: arrived button */}
      <div style={{ flexShrink: 0, padding: '12px 16px', paddingBottom: 'max(16px, env(safe-area-inset-bottom, 16px))', background: '#0b1020', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
        <button onClick={() => setPrompt(true)} style={{ width: '100%', height: 52, borderRadius: 14, border: 'none', background: '#22C55E', color: '#fff', fontWeight: 800, fontSize: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          <MapPin style={{ width: 18, height: 18 }} /> I've reached the station
        </button>
      </div>

      {/* arrival prompt — do you see it? */}
      {prompt && !outcome && (
        <div style={overlayWrap}>
          <div style={card}>
            <div style={{ fontSize: 46, marginBottom: 10 }}>⛽</div>
            <h3 style={{ fontSize: 19, fontWeight: 900, color: '#fff', margin: '0 0 8px' }}>Can you see {station.brand}?</h3>
            <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.65)', lineHeight: 1.5, margin: '0 0 22px' }}>You should be at <strong style={{ color: '#fff' }}>{station.name}</strong>. Look around — is the station in sight?</p>
            <button onClick={() => setOutcome('seen')} style={{ width: '100%', height: 50, borderRadius: 13, border: 'none', background: '#22C55E', color: '#fff', fontWeight: 800, fontSize: 15, cursor: 'pointer', marginBottom: 10 }}>✅ Yes, I can see it</button>
            <button onClick={() => setOutcome('notseen')} style={{ width: '100%', height: 50, borderRadius: 13, border: '1.5px solid rgba(255,255,255,0.25)', background: 'transparent', color: '#fff', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}>❌ No, I can't find it</button>
          </div>
        </div>
      )}

      {/* arrived & seen */}
      {outcome === 'seen' && (
        <div style={overlayWrap}>
          <div style={card}>
            <div style={{ fontSize: 50, marginBottom: 10 }}>🎉</div>
            <h3 style={{ fontSize: 20, fontWeight: 900, color: '#fff', margin: '0 0 8px' }}>You've arrived!</h3>
            <p style={{ fontSize: 13.5, color: 'rgba(255,255,255,0.7)', lineHeight: 1.5, margin: '0 0 22px' }}>Pull in and refuel at {station.name}. Drive safely.</p>
            <button onClick={onExit} style={{ width: '100%', height: 50, borderRadius: 13, border: 'none', background: '#1A73E8', color: '#fff', fontWeight: 800, fontSize: 15, cursor: 'pointer' }}>Done</button>
          </div>
        </div>
      )}

      {/* arrived but can't find it */}
      {outcome === 'notseen' && (
        <div style={overlayWrap}>
          <div style={{ ...card, textAlign: 'left' }}>
            <div style={{ fontSize: 40, marginBottom: 8, textAlign: 'center' }}>🔎</div>
            <h3 style={{ fontSize: 18, fontWeight: 900, color: '#fff', margin: '0 0 10px', textAlign: 'center' }}>Can't spot it?</h3>
            <ul style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)', lineHeight: 1.6, margin: '0 0 20px', paddingLeft: 18 }}>
              <li>It may be <strong style={{ color: '#fff' }}>across the road</strong> or just around the corner — the pin can be a few metres off.</li>
              <li>Check for the <strong style={{ color: '#fff' }}>{station.brand}</strong> sign or canopy.</li>
              <li>Ask a nearby boda rider or attendant.</li>
            </ul>
            <a href={`tel:${station.phone.replace(/\s/g, '')}`} style={{ width: '100%', height: 48, borderRadius: 13, background: '#22C55E', color: '#fff', fontWeight: 800, fontSize: 15, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, textDecoration: 'none', marginBottom: 10 }}>
              <Phone style={{ width: 16, height: 16 }} /> Call the station
            </a>
            <button onClick={() => { setPrompt(false); setOutcome(''); }} style={{ width: '100%', height: 46, borderRadius: 13, border: '1.5px solid rgba(255,255,255,0.25)', background: 'transparent', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer', marginBottom: 10 }}>Look at the map again</button>
            <button onClick={onExit} style={{ width: '100%', height: 46, borderRadius: 13, border: 'none', background: 'transparent', color: '#60A5FA', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>Choose another station</button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
