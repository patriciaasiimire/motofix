// RequestDetail.tsx — the live screen for one active request. This is the most complex
// driver page: it shows the job status, the mechanic's live position on a map (with the
// shrinking route + ETA), call/chat actions, and the end-of-job FinalPaymentFlow. It
// reacts to real-time updates from RequestContext as the mechanic accepts → arrives → finishes.

import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ChevronLeft, MapPin, Wrench, Clock, Phone, Loader2,
  CheckCircle2, Circle, AlertCircle, User,
  DollarSign, Check, X, Smartphone, Maximize2, Minimize2,
  AlertTriangle, MessageCircle, Star,
} from 'lucide-react';
import { useLoadScript, GoogleMap, Marker, Polyline } from '@react-google-maps/api';
import { requestsService, paymentsService, mechanicService, chatService } from '@/config/api';
import type { MechanicPublicProfile } from '@/config/api';
import MechanicAssignedCard from '@/components/MechanicAssignedCard';
import FinalPaymentFlow from '@/components/FinalPaymentFlow';
import { toast } from 'sonner';
import { reverseGeocode, isCoordString, parseCoordString } from '@/utils/geocode';
import { useRequests, Request } from '@/contexts/RequestContext';
import { useWS } from '@/contexts/WebSocketContext';
import { useJobSim } from '@/hooks/useJobSim';
import { useLocation as useGeoLocation } from '@/hooks/useLocation';
import { cn } from '@/lib/utils';

// ─── Status timeline ──────────────────────────────────────────────────────────
const STATUS_STEPS = [
  { key: 'pending',               label: 'Request Sent',            desc: 'Looking for a verified provider for this job type' },
  { key: 'accepted',              label: 'Provider Accepted',        desc: 'Your provider is preparing to help' },
  { key: 'en_route',              label: 'Provider On the Way',      desc: 'Your provider is heading to you' },
  { key: 'arrived',               label: 'Provider Arrived',         desc: 'Your provider has arrived at your location' },
  { key: 'service_started',       label: 'Assessment Started',       desc: 'On-site assessment or service has started' },
  { key: 'awaiting_confirmation', label: 'Confirm Job Done',         desc: 'Your provider says the job is complete — please confirm below' },
  { key: 'completed',             label: 'Job Completed',            desc: 'Repair confirmed and done' },
] as const;

const STATUS_ORDER = ['pending', 'accepted', 'en_route', 'arrived', 'service_started', 'awaiting_confirmation', 'completed'] as const;
type StatusKey = (typeof STATUS_ORDER)[number];

function stepIndex(s: string) {
  return STATUS_ORDER.indexOf(s as StatusKey);
}

// Append 'Z' to naive UTC timestamps from the Python backend so all browsers
// treat them as UTC rather than local time (avoids a +03:00 skew in Uganda).
function normTs(ts: string): string {
  return /[Z+]/.test(ts) ? ts : ts + 'Z';
}

// Format a duration in minutes as "Xh Ym" (or "Ym" under an hour).
function fmtDuration(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

function minutesBetween(a?: string, b?: string): number | null {
  if (!a || !b) return null;
  const ta = Date.parse(normTs(a));
  const tb = Date.parse(normTs(b));
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  const mins = Math.round((tb - ta) / 60000);
  return Number.isFinite(mins) ? Math.max(0, mins) : null;
}

// ─── Haversine distance (km) ──────────────────────────────────────────────────
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseEtaMinutes(text: string): number | null {
  const h = text.match(/(\d+)\s*h/i);
  const m = text.match(/(\d+)\s*m/i);
  if (!h && !m) return null;
  return (h ? parseInt(h[1]) * 60 : 0) + (m ? parseInt(m[1]) : 0);
}

// ─── Shared traffic-aware ETA ─────────────────────────────────────────────────
// Deterministic so the driver app and the mechanic app always agree on the time.
// Effective driving speed adapts to the time of day (Uganda traffic patterns):
// rush-hour jams are slow, late-night roads are clear. NOTE: this exact function
// is duplicated in the mechanic app (ActiveJob.tsx) — keep the two in sync.
export function estimateEta(distanceKm: number, now: Date = new Date()): { minutes: number; durationText: string; distanceText: string } {
  const hour = now.getHours();
  let speed: number; // average effective km/h including traffic
  if      (hour >= 7  && hour < 10) speed = 17; // morning rush — heavy jam
  else if (hour >= 10 && hour < 16) speed = 27; // midday — moderate
  else if (hour >= 16 && hour < 20) speed = 15; // evening rush — worst jam
  else if (hour >= 20 && hour < 23) speed = 33; // evening — light traffic
  else                              speed = 42; // late night / early morning — clear
  const roadKm = distanceKm * 1.35; // straight-line → real road distance correction
  const minutes = Math.max(1, Math.round((roadKm / speed) * 60));
  const durationText = minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
  const distanceText = roadKm < 1 ? `${Math.round(roadKm * 1000)} m` : `${roadKm.toFixed(1)} km`;
  return { minutes, durationText, distanceText };
}

// ─── Arrival-time window ──────────────────────────────────────────────────────
// Both apps derive the SAME window from en_route_at + eta_minutes, so the driver
// and the mechanic always see an identical, forgiving arrival range.
function arrivalWindow(enRouteAt?: string, etaMinutes?: number): string | null {
  if (!enRouteAt || etaMinutes == null) return null;
  const start = new Date(normTs(enRouteAt));
  if (isNaN(start.getTime())) return null;
  const arrival = start.getTime() + etaMinutes * 60000;
  const pad = Math.max(10, Math.round(etaMinutes * 0.4)) * 60000; // forgiving upper buffer
  const round5 = (ms: number) => { const d = new Date(ms); d.setMinutes(Math.round(d.getMinutes() / 5) * 5, 0, 0); return d; };
  const lo = round5(arrival);
  const hi = round5(arrival + pad);
  const fmt = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); // "5:05 PM"
  const loStr = fmt(lo), hiStr = fmt(hi);
  // Drop the redundant meridiem on the lower bound when both share it: "5:05 – 5:20 PM"
  return loStr.slice(-2) === hiStr.slice(-2)
    ? `${loStr.replace(/\s?[AP]M$/i, '')} – ${hiStr}`
    : `${loStr} – ${hiStr}`;
}

// ─── Snap a point onto the route polyline so the mechanic pin never drifts off
//     the road (planar approximation — accurate at city scale). ────────────────
type LL = { lat: number; lng: number };
const FALLBACK_CENTER: LL = { lat: 0.3476, lng: 32.5825 }; // Kampala — only used before any GPS is known

// ─── Route metadata + "point along the route" ────────────────────────────────
// Lets us place the mechanic pin at a fraction of the way along the fixed route,
// so it always sits ON the line and only advances toward the driver.
type RouteMeta = { path: LL[]; cum: number[]; total: number; start: LL; end: LL };
function _segKm(a: LL, b: LL) {
  const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
function buildRouteMeta(path: LL[]): RouteMeta | null {
  if (!path || path.length < 2) return null;
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum[i] = cum[i - 1] + _segKm(path[i - 1], path[i]);
  return { path, cum, total: cum[cum.length - 1], start: path[0], end: path[path.length - 1] };
}
function pointAlong(meta: RouteMeta, frac: number): LL {
  const target = Math.max(0, Math.min(1, frac)) * meta.total;
  let i = 1;
  while (i < meta.cum.length && meta.cum[i] < target) i++;
  if (i >= meta.path.length) return meta.end;
  const segA = meta.cum[i - 1], segB = meta.cum[i];
  const t = segB > segA ? (target - segA) / (segB - segA) : 0;
  const a = meta.path[i - 1], b = meta.path[i];
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}
// Place a raw position onto the route at the progress implied by how close it is
// to the driver (the route's end). Always on the line; advances toward the driver.
function pinOnRoute(raw: LL, meta: RouteMeta | null): LL {
  if (!meta || meta.total <= 0) return raw;
  const toEnd      = _segKm(raw, meta.end);
  const startToEnd = _segKm(meta.start, meta.end);
  const progress   = startToEnd > 0 ? 1 - toEnd / startToEnd : 1;
  return pointAlong(meta, progress);
}
// The remaining road from the mechanic's current progress to the driver — uses
// the SAME progress as pinOnRoute, so the line's head sits exactly under the pin
// and the route visibly shrinks as the mechanic advances.
function remainingAlong(raw: LL, meta: RouteMeta | null): LL[] | null {
  if (!meta || meta.total <= 0) return null;
  const toEnd      = _segKm(raw, meta.end);
  const startToEnd = _segKm(meta.start, meta.end);
  const progress   = Math.max(0, Math.min(1, startToEnd > 0 ? 1 - toEnd / startToEnd : 1));
  const target = progress * meta.total;
  let i = 1;
  while (i < meta.cum.length && meta.cum[i] < target) i++;
  return [pointAlong(meta, progress), ...meta.path.slice(i)];
}

// ─── Map ──────────────────────────────────────────────────────────────────────
const MAP_CONTAINER_STYLE = { width: '100%', height: '100%' };

// Clean light map — strips POI/transit clutter, keeps standard Google Maps look
const MAP_LIGHT_STYLES = [
  { featureType: 'poi',     stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
];

const MAP_OPTIONS: google.maps.MapOptions = {
  disableDefaultUI: true,
  gestureHandling: 'cooperative',
  clickableIcons: false,
  zoomControl: true,
  styles: MAP_LIGHT_STYLES as google.maps.MapTypeStyle[],
};
const MAP_OPTIONS_FULL: google.maps.MapOptions = {
  ...MAP_OPTIONS,
  zoomControl: true,
  fullscreenControl: false,
};

// Driver: blue map pin with person silhouette — anchor at bottom tip (22, 53)
const DRIVER_PIN_SVG = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="44" height="56" viewBox="0 0 44 56">' +
  '<circle cx="22" cy="20" fill="none" stroke="#3B82F6" stroke-width="2">' +
  '<animate attributeName="r" from="12" to="22" dur="2s" repeatCount="indefinite"/>' +
  '<animate attributeName="opacity" from="0.7" to="0" dur="2s" repeatCount="indefinite"/>' +
  '</circle>' +
  '<ellipse cx="22" cy="55" rx="5" ry="1.5" fill="rgba(0,0,0,0.18)"/>' +
  '<path d="M22 2C12.06 2 4 10.06 4 20C4 32 22 53 22 53C22 53 40 32 40 20C40 10.06 31.94 2 22 2Z" fill="#3B82F6" stroke="white" stroke-width="2.5"/>' +
  '<circle cx="22" cy="14" r="5" fill="white"/>' +
  '<path d="M12 30c0-5.52 4.48-10 10-10s10 4.48 10 10z" fill="white"/>' +
  '</svg>'
)}`;

// Mechanic: red teardrop pin with 👨‍🔧 emoji — anchor at pin tip
const MECHANIC_CAR_SVG = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="54" height="66" viewBox="0 0 54 66">' +
  '<defs>' +
  '<radialGradient id="pg" cx="38%" cy="28%" r="68%">' +
  '<stop offset="0%" stop-color="#F87171"/>' +
  '<stop offset="100%" stop-color="#B91C1C"/>' +
  '</radialGradient>' +
  '<filter id="sh" x="-30%" y="-10%" width="160%" height="160%">' +
  '<feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="rgba(0,0,0,0.35)"/>' +
  '</filter>' +
  '</defs>' +
  // pin shadow
  '<ellipse cx="27" cy="64" rx="9" ry="3" fill="rgba(0,0,0,0.22)"/>' +
  // pin body with gradient + drop-shadow filter
  '<path filter="url(#sh)" d="M27 2C15.4 2 6 11.4 6 23C6 38.5 27 63 27 63C27 63 48 38.5 48 23C48 11.4 38.6 2 27 2Z" fill="url(#pg)" stroke="white" stroke-width="2.5"/>' +
  // subtle gloss highlight arc at top
  '<path d="M17 11C19.5 7 23 5 27 5C31 5 34.5 7 37 11" fill="none" stroke="rgba(255,255,255,0.45)" stroke-width="3" stroke-linecap="round"/>' +
  // white circle badge
  '<circle cx="27" cy="23" r="15.5" fill="white"/>' +
  // subtle inner ring
  '<circle cx="27" cy="23" r="15.5" fill="none" stroke="rgba(185,28,28,0.15)" stroke-width="1.5"/>' +
  // mechanic emoji centred in badge
  '<text x="27" y="31" text-anchor="middle" font-size="19" font-family="Segoe UI Emoji,Apple Color Emoji,Noto Color Emoji,sans-serif">&#x1F468;&#x200D;&#x1F527;</text>' +
  '</svg>'
)}`;

const GLASS_BADGE: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 5,
  fontSize: 10, fontWeight: 700,
  background: 'rgba(10,14,30,0.82)', color: '#e2e8f0',
  borderRadius: 8, padding: '4px 9px',
  border: '1px solid rgba(255,255,255,0.12)',
  backdropFilter: 'blur(4px)',
};

function MapOverlays({
  expanded, distText, driverPos, mechPos,
  onToggle,
}: {
  expanded: boolean;
  distText: string | null;
  driverPos: { lat: number; lng: number } | null;
  mechPos:   { lat: number; lng: number } | null;
  onToggle: () => void;
}) {
  return (
    <>
      {/* Bottom-left legend */}
      <div style={{ position: 'absolute', bottom: expanded ? 28 : 10, left: 10, display: 'flex', gap: 5, pointerEvents: 'none', zIndex: 10 }}>
        {driverPos && (
          <span style={GLASS_BADGE}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#3B82F6', flexShrink: 0, boxShadow: '0 0 5px #3B82F6' }} /> You
          </span>
        )}
        {mechPos && (
          <span style={GLASS_BADGE}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#F59E0B', flexShrink: 0, boxShadow: '0 0 5px #F59E0B' }} /> Mechanic
          </span>
        )}
      </div>

      {/* Top-right distance only — the arrival time now lives above the map */}
      <div style={{ position: 'absolute', top: expanded ? 18 : 10, right: expanded ? 54 : 46, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5, pointerEvents: 'none', zIndex: 10 }}>
        {distText && (
          <div style={{ ...GLASS_BADGE, pointerEvents: 'none' }}>{distText}</div>
        )}
      </div>

      {/* Expand / collapse toggle */}
      <button
        onClick={onToggle}
        style={{ position: 'absolute', top: expanded ? 18 : 10, right: 10, zIndex: 20, width: 34, height: 34, borderRadius: 10, background: 'rgba(10,14,30,0.82)', border: '1px solid rgba(255,255,255,0.15)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
      >
        {expanded
          ? <Minimize2 style={{ width: 14, height: 14, color: '#e2e8f0' }} />
          : <Maximize2 style={{ width: 14, height: 14, color: '#e2e8f0' }} />}
      </button>
    </>
  );
}

function TrackingMap({
  driverLat, driverLng,
  arrived, assigned, simActive, requestId, enRouteAt,
  onRouteUpdate, onProgress,
}: {
  driverLat?: number | null; driverLng?: number | null;
  arrived?: boolean;
  assigned?: boolean;       // mechanic accepted (accepted/en_route) → draw full route + both pins
  simActive?: boolean;      // en_route → advance the mechanic pin
  requestId?: string | number | null;
  enRouteAt?: string | null;
  onRouteUpdate?: (info: { duration: string; distance: string } | null) => void;
  onProgress?: (fraction: number) => void;
}) {
  const { isLoaded } = useLoadScript({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY ?? '',
  });
  const mapRef    = useRef<google.maps.Map | null>(null);
  const mapRefExp = useRef<google.maps.Map | null>(null);
  // Once the user zooms/pans, stop auto-fitting so the map stays where they put it
  const userInteractedRef    = useRef(false);
  const userInteractedExpRef = useRef(false);
  // Track whether each map has had its initial fit
  const initialFitDoneRef    = useRef(false);
  const initialFitDoneExpRef = useRef(false);

  const [expanded, setExpanded]     = useState(false);
  const initialCenterRef  = useRef<LL | null>(null); // stable map center (set once)

  const hasDriver = driverLat != null && driverLng != null;
  const driverPos = hasDriver ? { lat: driverLat as number, lng: driverLng as number } : null;
  const enRoute     = !!simActive && !arrived;             // pin advances
  const showJourney = !!(assigned ?? simActive) && !arrived; // route + both pins drawn

  // Deterministic shared simulation — both apps compute the SAME route, pin and
  // (monotonic) ETA from the request location + id + en_route time. The route is
  // drawn as soon as the job is accepted; the pin only advances once en route.
  const sim = useJobSim({
    isLoaded,
    active: showJourney,
    advancing: enRoute,
    driver: driverPos,
    seed: String(requestId ?? ''),
    enRouteAt: enRouteAt ?? null,
  });

  // The mechanic marker is parked at the route start while accepted, rides the route
  // while en route, and once arrived it sits with the driver.
  const mechDisplay = arrived ? driverPos : (sim.mechPos ?? null);
  // Draw the route ONLY during the journey — sim.remaining stays populated from the
  // cached route after arrival, so without this gate the line lingers once arrived.
  const remainingRoute = showJourney ? sim.remaining : null;

  // Push progress (drives the arrival bar) + a monotonic ETA/distance to parent.
  useEffect(() => { if (enRoute) onProgress?.(sim.progress); }, [sim.progress, enRoute, onProgress]);
  useEffect(() => {
    if (!enRoute || sim.etaMinutes == null || sim.distanceKm == null) { onRouteUpdate?.(null); return; }
    const km = sim.distanceKm;
    onRouteUpdate?.({
      duration: sim.etaMinutes <= 0 ? 'Arriving' : `${sim.etaMinutes} min`,
      distance: km >= 1 ? `${km.toFixed(1)} km` : `${Math.round(km * 1000)} m`,
    });
  }, [enRoute, sim.etaMinutes, sim.distanceKm, onRouteUpdate]);

  const fitBounds = useCallback((map: google.maps.Map | null, force = false) => {
    if (!map || !isLoaded) return;
    const isExp = map === mapRefExp.current;
    if (!force && (isExp ? userInteractedExpRef.current : userInteractedRef.current)) return;
    const pts: LL[] = [];
    if (driverPos) pts.push(driverPos);
    if (sim.start) pts.push(sim.start);
    else if (sim.mechPos) pts.push(sim.mechPos);
    if (pts.length === 0) return;
    if (pts.length === 1) { map.setCenter(pts[0]); map.setZoom(16); }
    else {
      const b = new window.google.maps.LatLngBounds();
      pts.forEach(p => b.extend(p));
      map.fitBounds(b, 60);
    }
    if (isExp) initialFitDoneExpRef.current = true;
    else       initialFitDoneRef.current    = true;
  }, [driverPos, sim.start, sim.mechPos, isLoaded]);

  // Frame the route once the start + driver are known (re-runs as they arrive).
  useEffect(() => { if (!initialFitDoneRef.current) fitBounds(mapRef.current); }, [fitBounds, sim.ready]);
  useEffect(() => { if (!initialFitDoneExpRef.current) fitBounds(mapRefExp.current); }, [fitBounds, sim.ready]);

  // On arrival, re-frame around the driver (the mechanic is now with them).
  useEffect(() => {
    if (!arrived || !isLoaded || !driverPos) return;
    const fit = (map: google.maps.Map | null) => { if (map) { map.setCenter(driverPos); map.setZoom(16); } };
    fit(mapRef.current); fit(mapRefExp.current);
  }, [arrived, isLoaded, driverPos]);

  if (!isLoaded) return <div className="rounded-2xl bg-muted animate-pulse" style={{ height: 320 }} />;

  if (initialCenterRef.current == null && driverPos) initialCenterRef.current = driverPos;
  const center = initialCenterRef.current ?? FALLBACK_CENTER;

  const driverIcon: google.maps.Icon = { url: DRIVER_PIN_SVG,   scaledSize: new window.google.maps.Size(35, 45), anchor: new window.google.maps.Point(17.5, 42.5) };
  const mechIcon:   google.maps.Icon = { url: MECHANIC_CAR_SVG, scaledSize: new window.google.maps.Size(43, 53), anchor: new window.google.maps.Point(21.5, 50.5) };

  const distText = (enRoute && sim.distanceKm != null)
    ? (sim.distanceKm >= 1 ? `${sim.distanceKm.toFixed(1)} km` : `${Math.round(sim.distanceKm * 1000)} m`)
    : null;

  const mapChildren = (
    <>
      {driverPos   && <Marker position={driverPos}   icon={driverIcon} title="Your location" />}
      {mechDisplay && <Marker position={mechDisplay} icon={mechIcon}   title="Mechanic" />}
      {remainingRoute && remainingRoute.length >= 2 && (
        // key tracks the journey so the line is re-drawn as the mechanic advances —
        // otherwise its path freezes at the full route and the pin just slides over a
        // static line instead of the road shrinking toward the driver.
        <Polyline key={`route-${remainingRoute.length}`} path={remainingRoute} options={{ strokeColor: '#F59E0B', strokeWeight: 6, strokeOpacity: 0.9, zIndex: 10 }} />
      )}
    </>
  );

  const overlayProps = { expanded, distText, driverPos, mechPos: mechDisplay, onToggle: () => setExpanded(e => !e) };

  return (
    <>
      <style>{`
        .motofix-map .gm-style-cc,
        .motofix-map a[href^="https://maps.google.com/maps"],
        .motofix-map .gmnoscreen { display: none !important; }
      `}</style>
      {/* Collapsed inline map — always mounted so the map instance is never destroyed */}
      <div
        className="motofix-map rounded-2xl overflow-hidden border border-border/50 relative"
        style={{ height: 320, visibility: expanded ? 'hidden' : 'visible' }}
      >
        <GoogleMap
          mapContainerStyle={MAP_CONTAINER_STYLE}
          center={center}
          zoom={15}
          options={MAP_OPTIONS}
          onLoad={m => {
            mapRef.current = m;
            fitBounds(m, true);
            m.addListener('dragstart',    () => { userInteractedRef.current = true; });
            m.addListener('zoom_changed', () => { userInteractedRef.current = true; });
          }}
        >
          {mapChildren}
        </GoogleMap>
        <MapOverlays {...overlayProps} />
      </div>

      {/* Full-screen map — portalled to document.body to escape ancestor transforms/stacking contexts */}
      {expanded && createPortal(
        <div className="motofix-map" style={{ position: 'fixed', inset: 0, zIndex: 9999, background: '#000' }}>
          <div style={{ position: 'relative', width: '100vw', height: '100vh' }}>
            <GoogleMap
              mapContainerStyle={{ width: '100vw', height: '100vh' }}
              center={center}
              zoom={15}
              options={MAP_OPTIONS_FULL}
              onLoad={m => {
                mapRefExp.current = m;
                fitBounds(m, true);
                m.addListener('dragstart',    () => { userInteractedExpRef.current = true; });
                m.addListener('zoom_changed', () => { userInteractedExpRef.current = true; });
              }}
            >
              {mapChildren}
            </GoogleMap>
            <MapOverlays {...overlayProps} expanded={true} />
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

// ─── Status step colors (for timeline pill) ───────────────────────────────────
const STATUS_STEP_COLOR: Record<string, string> = {
  pending:               '#F59E0B',
  accepted:              '#3B82F6',
  en_route:              '#F59E0B',
  arrived:               '#8B5CF6',
  service_started:       '#F97316',
  awaiting_confirmation: '#A78BFA',
  completed:             '#22C55E',
};

// ─── Status badge ─────────────────────────────────────────────────────────────
const STATUS_BADGE: Record<string, { label: string; className: string; style?: React.CSSProperties }> = {
  pending:   { label: 'Pending',    className: 'bg-warning/20 text-warning border-warning/30' },
  accepted:  { label: 'Accepted',   className: 'border-transparent', style: { background: '#16a34a', color: '#fff', borderColor: '#15803d' } },
  en_route:  { label: 'On the Way', className: 'bg-accent/20 text-accent border-accent/30' },
  arrived:   { label: 'Arrived',    className: 'bg-accent/20 text-accent border-accent/30' },
  service_started:       { label: 'In Service',           className: 'bg-primary/20 text-primary border-primary/30' },
  awaiting_confirmation: { label: 'Confirm Completion',   className: 'border-transparent', style: { background: '#A78BFA22', color: '#A78BFA', borderColor: '#A78BFA44' } },
  completed:             { label: 'Completed',            className: 'bg-success/20 text-success border-success/30' },
  cancelled:             { label: 'Cancelled',            className: 'bg-destructive/20 text-destructive border-destructive/30' },
};

interface QuoteRecord {
  id: number;
  quoted_amount: number;
  commission: number;
  mechanic_payout: number;
  quote_approved: boolean;
  collection_status: string;
  disbursement_status: string;
}

// ─── Confirmation card (own component so hooks are unconditional) ─────────────
function ConfirmJobCard({ onConfirm, onDecline }: { onConfirm: () => Promise<void>; onDecline: () => void }) {
  const [isConfirming, setIsConfirming] = useState(false);
  const confirm = async () => {
    setIsConfirming(true);
    try { await onConfirm(); } catch (err: any) {
      toast.error(err?.response?.data?.detail ?? 'Could not confirm. Please try again.');
    } finally { setIsConfirming(false); }
  };
  return (
    <div className="animate-slide-up" style={{ animationDelay: '0.08s' }}>
      <div style={{
        borderRadius: 20,
        background: 'rgba(167,139,250,0.08)',
        border: '1.5px solid rgba(167,139,250,0.35)',
        padding: '20px 18px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <div style={{ width: 42, height: 42, borderRadius: 13, background: 'rgba(167,139,250,0.15)', border: '1px solid rgba(167,139,250,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <CheckCircle2 style={{ width: 20, height: 20, color: '#A78BFA' }} />
          </div>
          <div>
            <p style={{ fontSize: 14, fontWeight: 800, color: '#A78BFA', marginBottom: 2 }}>Mechanic says the job is done</p>
            <p style={{ fontSize: 12, color: 'var(--text-lo)', lineHeight: 1.4 }}>Are you satisfied with the repair? Tap Yes to confirm.</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={confirm}
            disabled={isConfirming}
            style={{
              flex: 1, height: 48, borderRadius: 14, border: 'none',
              background: 'linear-gradient(135deg, #A78BFA, #7C3AED)',
              color: '#fff', fontWeight: 800, fontSize: 14,
              cursor: isConfirming ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            }}
          >
            {isConfirming
              ? <Loader2 style={{ width: 16, height: 16, animation: 'spin 1s linear infinite' }} />
              : <Check style={{ width: 16, height: 16 }} />}
            {isConfirming ? 'Confirming…' : 'Yes, Job is Done'}
          </button>
          <button
            onClick={onDecline}
            style={{
              flex: 1, height: 48, borderRadius: 14,
              border: '1.5px solid rgba(239,68,68,0.4)',
              background: 'rgba(239,68,68,0.08)',
              color: '#f87171', fontWeight: 700, fontSize: 14,
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            }}
          >
            <X style={{ width: 16, height: 16 }} />
            Not yet
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function RequestDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { requests, paymentsEnabled, sendWsMessage, markCancelled, revertCancelled } = useRequests();

  const [request, setRequest] = useState<Request | null>(null);
  const jobTypeLabel = /tow|recovery/i.test(request?.service_type ?? '') ? 'Tow / recovery' : 'Roadside assist';
  const [isLoading, setIsLoading] = useState(true);
  const [isCalling, setIsCalling] = useState(false);
  const [displayLocation, setDisplayLocation] = useState('');

  // Cancel flow
  const [cancelPhase, setCancelPhase] = useState<'warning' | 'reason' | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelOther, setCancelOther] = useState('');
  const [isCancelling, setIsCancelling] = useState(false);
  const [mapCoords, setMapCoords] = useState<{ lat: number; lon: number } | null>(null);

  // Quote & payment state
  const [quote, setQuote] = useState<QuoteRecord | null>(null);
  const [isApprovingQuote, setIsApprovingQuote] = useState(false);
  const [momoPhone, setMomoPhone] = useState('');
  const [isPaying, setIsPaying] = useState(false);
  const [isCashPaying, setIsCashPaying] = useState(false);

  const [acceptCountdown,   setAcceptCountdown]   = useState<string | null>(null);
  const [acceptSecondsLeft, setAcceptSecondsLeft] = useState<number | null>(null);
  const [noProviders, setNoProviders] = useState(false);
  const [isTryingAgain, setIsTryingAgain] = useState(false);
  const [acceptedNotif, setAcceptedNotif] = useState(false);
  const [showCallSheet, setShowCallSheet] = useState(false);
  const [etaNearBannerShown, setEtaNearBannerShown] = useState(false);
  const etaNearBannerRef = useRef(false);
  const [mechanicPhone, setMechanicPhone] = useState<string | null>(null);
  const [alreadyReviewed, setAlreadyReviewed] = useState(false);
  // Final-bill payment (mechanic's actual_fee). Cash/MoMo are simulated for the demo;
  // "paid" is tracked locally per request so the breakdown card reflects it.
  const [feePaid, setFeePaid] = useState(false);
  const [showFeePaySheet, setShowFeePaySheet] = useState(false);
  useEffect(() => {
    try { setFeePaid(sessionStorage.getItem(`motofix_fee_paid_${id}`) === '1'); } catch {}
  }, [id]);
  const markFeePaid = (method: 'momo' | 'cash') => {
    try { sessionStorage.setItem(`motofix_fee_paid_${id}`, '1'); } catch {}
    setFeePaid(true);
    setShowFeePaySheet(false);
    toast.success(method === 'cash' ? 'Cash payment recorded. Thank you!' : 'Payment successful. Thank you!');
  };

  // Live route info lifted from TrackingMap via callback
  const [liveRoute, setLiveRoute] = useState<{ duration: string; distance: string } | null>(null);
  const liveRouteRef = useRef<{ duration: string; distance: string } | null>(null);
  const handleRouteUpdate = useCallback((info: { duration: string; distance: string } | null) => {
    liveRouteRef.current = info;
    setLiveRoute(info);
  }, []);

  // How far along the route the mechanic is (0 → 1) — drives the arrival bar.
  const [mechProgress, setMechProgress] = useState(0);
  const handleProgress = useCallback((p: number) => setMechProgress(p), []);

  // ── Simulated mechanic approach — animates the mechanic driving to the driver
  const [simMech, setSimMech] = useState<{ lat: number; lng: number } | null>(null);
  const simMechRef        = useRef<{ lat: number; lng: number } | null>(null);
  const nearNotifiedRef   = useRef(false);
  const [confirmingSeen, setConfirmingSeen] = useState(false);

  // Driver confirms they can see the mechanic → service begins, map closes
  const handleSeeMechanic = useCallback(async () => {
    if (!id) return;
    setConfirmingSeen(true);
    try {
      await requestsService.updateStatus(id, 'service_started');
      toast.success('Your mechanic is here — service is starting!', { icon: '🔧', duration: 6000 });
      if (navigator.vibrate) navigator.vibrate(200);
    } catch {
      toast.error('Could not update status. Please try again.');
    } finally {
      setConfirmingSeen(false);
    }
  }, [id]);

  // Driver can't see the mechanic yet → open the chat to coordinate
  const handleNotYet = useCallback(() => {
    navigate(`/requests/${id}/chat`);
  }, [id, navigate]);

  // Driver marks the job done themselves (e.g. mechanic forgot) → mechanic then confirms
  const handleDriverMarkDone = useCallback(async () => {
    if (!id) return;
    try {
      await requestsService.updateStatus(id, 'awaiting_confirmation');
      toast.success('Marked as done — waiting for your mechanic to confirm.', { icon: '✅' });
    } catch {
      toast.error('Could not update. Please try again.');
    }
  }, [id]);

  // Mechanic Assigned Card state
  const [mechanicProfile, setMechanicProfile] = useState<MechanicPublicProfile | null>(null);
  const [showMechanicCard, setShowMechanicCard] = useState(false);
  const [mechanicCardDismissed, setMechanicCardDismissed] = useState(false);
  const [bubblePos, setBubblePos] = useState(() => ({
    x: typeof window !== 'undefined' ? window.innerWidth - 72 : 300,
    y: typeof window !== 'undefined' ? window.innerHeight - 160 : 500,
  }));
  const bubbleDragStartRef  = useRef<{ px: number; py: number; bx: number; by: number } | null>(null);
  const bubbleHasDraggedRef = useRef(false);

  // Unread chat-message count shown on the floating mechanic bubble.
  const { lastMessage: chatWsMessage, sendMessage: wsSend } = useWS();
  const [chatUnread, setChatUnread] = useState(0);

  // Pull the true unread count from the server when the mechanic is assigned
  // (covers messages that arrived while the app was closed).
  useEffect(() => {
    if (!id || !mechanicProfile) return;
    chatService.unread(id, 'driver')
      .then(res => setChatUnread(res.data?.unread ?? 0))
      .catch(() => {});
  }, [id, mechanicProfile]);

  // Live: bump the badge when the mechanic sends a message while we're on this screen.
  useEffect(() => {
    const m = chatWsMessage as { type?: string; service_request_id?: string; sender_role?: string } | null;
    if (m?.type === 'chat_message' && String(m.service_request_id) === String(id) && m.sender_role === 'mechanic') {
      setChatUnread(c => c + 1);
    }
  }, [chatWsMessage, id]);

  const prevStatusRef = useRef<string | null>(null);

  const quotePollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const paymentPollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastBroadcastRef = useRef(0);
  const lastGeocodedPosRef = useRef<{ lat: number; lng: number } | null>(null);
  const gpsLatRef = useRef<number | null>(null);
  const gpsLngRef = useRef<number | null>(null);

  // Always watch device GPS on this page — the live position is the source of truth.
  // GPS stops only when request is completed or cancelled (nothing left to track).
  const isActive = !!request && !['completed', 'cancelled', 'awaiting_confirmation'].includes(request?.status ?? '');
  const { lat: gpsLat, lng: gpsLng, accuracy: gpsAccuracy } = useGeoLocation(isActive);

  // ── Load request ──────────────────────────────────────────────────────────
  useEffect(() => {
    const cached = requests.find((r) => String(r.id) === id);
    if (cached) { setRequest(cached); setIsLoading(false); }
    if (!id) return;
    requestsService.getById(id)
      .then((res) => { setRequest(res.data); setIsLoading(false); })
      .catch(() => { if (!cached) setIsLoading(false); });
  }, [id, requests]);

  useEffect(() => {
    const live = requests.find((r) => String(r.id) === id);
    if (!live) return;
    // Never downgrade a terminal status (e.g. a stale context snapshot showing
    // awaiting_confirmation must not overwrite a confirmed 'completed').
    setRequest(prev => {
      if (prev?.status === 'completed' && live.status !== 'completed') return prev;
      return live;
    });
  }, [requests, id]);

  // Pre-fill MoMo number from stored user profile
  useEffect(() => {
    try {
      const user = JSON.parse(localStorage.getItem('motofix_user') || '{}');
      if (user?.phone) setMomoPhone(user.phone.replace('+', ''));
    } catch {}
  }, []);

  // ── Parse stored request coords (used as map fallback only) ───────────────
  useEffect(() => {
    if (!request?.location) return;
    const loc = request.location.trim();
    if (isCoordString(loc)) {
      const coords = parseCoordString(loc);
      if (coords) setMapCoords({ lat: coords.lat, lon: coords.lng });
    }
  }, [request?.location]);

  // ── Geocode live GPS → location text ─────────────────────────────────────
  // Live GPS always wins. Falls back to stored request coords only while GPS
  // is still resolving. Re-geocodes whenever device moves ≥40 m.
  useEffect(() => {
    if (gpsLat != null && gpsLng != null) {
      // Live GPS resolved — this is the source of truth
      const last = lastGeocodedPosRef.current;
      const movedM = last ? haversineKm(last.lat, last.lng, gpsLat, gpsLng) * 1000 : Infinity;
      if (movedM < 40) return; // haven't moved enough to bother re-geocoding

      lastGeocodedPosRef.current = { lat: gpsLat, lng: gpsLng };
      setDisplayLocation('Locating…');
      reverseGeocode(gpsLat, gpsLng)
        .then((addr) => setDisplayLocation(addr ?? `Near ${gpsLat.toFixed(4)}°N, ${gpsLng.toFixed(4)}°E`))
        .catch(() => setDisplayLocation(`Near ${gpsLat.toFixed(4)}°N, ${gpsLng.toFixed(4)}°E`));

    } else if (mapCoords && lastGeocodedPosRef.current == null) {
      // GPS not yet available — show stored coords as a temporary placeholder
      setDisplayLocation('Locating…');
      reverseGeocode(mapCoords.lat, mapCoords.lon)
        .then((addr) => {
          // Only apply if live GPS still hasn't arrived
          if (lastGeocodedPosRef.current == null) {
            setDisplayLocation(addr ?? `Near ${mapCoords.lat.toFixed(4)}°N, ${mapCoords.lon.toFixed(4)}°E`);
          }
        })
        .catch(() => {});
    }
  // displayLocation intentionally excluded — it is SET by this effect, not a trigger
  }, [gpsLat, gpsLng, mapCoords]);

  // Keep GPS refs in sync for use inside interval (avoids stale closures)
  useEffect(() => { gpsLatRef.current = gpsLat ?? null; }, [gpsLat]);
  useEffect(() => { gpsLngRef.current = gpsLng ?? null; }, [gpsLng]);

  // ── Broadcast live GPS reactively (on GPS change, throttled to 10 s) ───────
  useEffect(() => {
    if (!isActive || !id || gpsLat == null || gpsLng == null) return;
    const now = Date.now();
    if (now - lastBroadcastRef.current < 10000) return;
    lastBroadcastRef.current = now;
    sendWsMessage({ type: 'location_update', role: 'driver', lat: gpsLat, lng: gpsLng, service_request_id: id });
  }, [gpsLat, gpsLng, isActive, id, sendWsMessage]);

  // ── Periodic 15 s broadcast — ensures mechanic map updates even if driver is stationary
  useEffect(() => {
    if (!isActive || !id) return;
    const timer = setInterval(() => {
      const lat = gpsLatRef.current;
      const lng = gpsLngRef.current;
      if (lat == null || lng == null) return;
      sendWsMessage({ type: 'location_update', role: 'driver', lat, lng, service_request_id: id });
      lastBroadcastRef.current = Date.now();
    }, 15000);
    return () => clearInterval(timer);
  }, [isActive, id, sendWsMessage]);

  // ── 5-minute acceptance countdown (pending only) ─────────────────────────
  useEffect(() => {
    if (request?.status !== 'pending') {
      setAcceptCountdown(null);
      setAcceptSecondsLeft(null);
      return;
    }
    const WINDOW_MS = 5 * 60 * 1000;
    // Server returns naive UTC datetimes (no 'Z' suffix). Append 'Z' so browsers
    // don't interpret them as local time (which is +03:00 in Uganda → 3 hrs skew).
    const rawTs = (request as any).dispatched_at || request.created_at;
    const normalised = rawTs
      ? /[Z+]/.test(String(rawTs)) ? String(rawTs) : String(rawTs) + 'Z'
      : null;
    const startMs = normalised ? (new Date(normalised).getTime() || Date.now()) : Date.now();

    // Use an object ref so tick() can clear itself without stale closure issues
    const timerRef = { id: 0 as ReturnType<typeof setInterval> };

    const tick = () => {
      const elapsed = Date.now() - startMs;
      const remaining = Math.max(0, WINDOW_MS - elapsed);
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      setAcceptCountdown(`${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`);
      setAcceptSecondsLeft(Math.round(remaining / 1000));
      if (elapsed >= WINDOW_MS) {
        setNoProviders(true);
        // Clear immediately so repeated ticks can't re-show the modal after user dismisses it
        clearInterval(timerRef.id);
      }
    };

    tick();
    // Only start the interval if window hasn't already expired
    if (Date.now() - startMs < WINDOW_MS) {
      timerRef.id = setInterval(tick, 1000);
    }
    return () => clearInterval(timerRef.id);
  }, [request?.status, (request as any)?.dispatched_at, request?.created_at]);

  // ── Notify driver when mechanic accepts ──────────────────────────────────
  useEffect(() => {
    if (!request) return;
    const prev = prevStatusRef.current;
    prevStatusRef.current = request.status;
    if (prev !== 'awaiting_confirmation' && request.status === 'awaiting_confirmation') {
      toast('Your mechanic says the job is done. Please confirm below.', {
        duration: 8000,
        icon: '🔧',
      });
    }
    // Job completed (e.g. mechanic confirmed payment received) → queue the rating prompt.
    if (prev && prev !== 'completed' && request.status === 'completed') {
      try {
        sessionStorage.setItem('motofix_pending_review', JSON.stringify({
          requestId: String(id),
          mechanicName: (request as any).mechanic_name ?? 'your mechanic',
          mechanicId: request.mechanic_id,
          serviceType: request.service_type,
          description: request.description,
        }));
      } catch {}
    }
    if (prev === 'pending' && request.status === 'accepted') {
      setAcceptedNotif(true);
      setNoProviders(false);
      setTimeout(() => setAcceptedNotif(false), 5000);
      // Pre-fetch mechanic phone for the call sheet
      if (id) {
        requestsService.getCallPartner(id)
          .then(res => { if (res.data?.phone) setMechanicPhone(res.data.phone); })
          .catch(() => {});
      }
    }
    if (prev === 'accepted' && request.status !== 'pending' && !mechanicPhone && id) {
      requestsService.getCallPartner(id)
        .then(res => { if (res.data?.phone) setMechanicPhone(res.data.phone); })
        .catch(() => {});
    }
    if (prev === 'accepted' && request.status === 'en_route') {
      // Reset the near-banner so it can fire once per journey
      etaNearBannerRef.current = false;
      setEtaNearBannerShown(false);
      const eta = liveRouteRef.current;
      const etaText = eta ? ` • ${eta.duration} away` : '';
      toast(`${(request as any).mechanic_name ?? 'Mechanic'} is on the way!${etaText}`, {
        duration: 10000,
        icon: '🚗',
      });
    }
    if (prev === 'en_route' && request.status === 'arrived') {
      toast.success('Your mechanic has arrived at your location!', {
        duration: 10000,
        icon: '📍',
      });
      if (navigator.vibrate) navigator.vibrate([300, 100, 300, 100, 300]);
    }
  }, [request?.status]);

  // ── Simulate the mechanic driving toward the driver while en_route ─────────
  useEffect(() => {
    const dLat = gpsLat ?? mapCoords?.lat;
    const dLng = gpsLng ?? mapCoords?.lon;
    // Only simulate when the mechanic app is NOT broadcasting a real position.
    // If a real GPS feed arrives, the map + ETA use it directly (and align with
    // the mechanic's own screen), so the simulation steps aside.
    const hasRealMech = request?.mechanic_lat != null && request?.mechanic_lon != null;
    const active = request?.status === 'en_route' && !hasRealMech;

    if (!active || dLat == null || dLng == null) {
      // Reset between journeys / once a real feed takes over
      if (hasRealMech || (request?.status && request.status !== 'en_route')) {
        simMechRef.current = null;
        nearNotifiedRef.current = false;
        setSimMech(null);
      }
      return;
    }

    // Seed the starting position: real mechanic coords if known, else ~12 km out
    if (!simMechRef.current) {
      const start = (request?.mechanic_lat != null && request?.mechanic_lon != null)
        ? { lat: request.mechanic_lat as number, lng: request.mechanic_lon as number }
        : { lat: dLat + 0.085, lng: dLng + 0.085 };
      // If the real mechanic is already very close, push the start out so the
      // approach is visible during the demo
      const startKm = haversineKm(start.lat, start.lng, dLat, dLng);
      const seeded = startKm < 6
        ? { lat: dLat + 0.085, lng: dLng + 0.085 }
        : start;
      simMechRef.current = seeded;
      setSimMech(seeded);
      nearNotifiedRef.current = false;
    }

    const STEP_KM = 0.6; // distance covered each tick
    const timer = setInterval(() => {
      const cur = simMechRef.current;
      if (!cur) return;
      const remainKm = haversineKm(cur.lat, cur.lng, dLat, dLng);
      if (remainKm <= 0.06) return; // essentially at the driver — hold
      const ratio = Math.min(1, STEP_KM / remainKm);
      const next = {
        lat: cur.lat + (dLat - cur.lat) * ratio,
        lng: cur.lng + (dLng - cur.lng) * ratio,
      };
      simMechRef.current = next;
      setSimMech(next);
    }, 3000);

    return () => clearInterval(timer);
  }, [request?.status, gpsLat, gpsLng, mapCoords?.lat, mapCoords?.lon, request?.mechanic_lat, request?.mechanic_lon]);

  // ── Notify when the mechanic gets within 5 km ──────────────────────────────
  useEffect(() => {
    if (request?.status !== 'en_route') return;
    if (nearNotifiedRef.current || !simMech) return;
    const dLat = gpsLat ?? mapCoords?.lat;
    const dLng = gpsLng ?? mapCoords?.lon;
    if (dLat == null || dLng == null) return;
    const distKm = haversineKm(simMech.lat, simMech.lng, dLat, dLng);
    if (distKm < 5) {
      nearNotifiedRef.current = true;
      toast.success(`${(request as any).mechanic_name?.split(' ')[0] ?? 'Your mechanic'} has arrived nearby — less than 5 km away!`, {
        duration: 10000, icon: '📍',
      });
      if (navigator.vibrate) navigator.vibrate([300, 100, 300]);
    }
  }, [simMech, request?.status, gpsLat, gpsLng, mapCoords?.lat, mapCoords?.lon]);

  // ── Show "almost there" + "Do you see the mechanic?" card only once the pins
  //    are close — ETA ≤ 2 min (i.e. the final stretch of the ~5 min journey).
  //    Triggering earlier made the card pop up the moment the mechanic set off.
  useEffect(() => {
    if (request?.status !== 'en_route') return;
    if (!liveRoute?.duration) return;
    if (etaNearBannerRef.current) return;
    const mins = parseEtaMinutes(liveRoute.duration);
    if (mins == null || mins > 2) return;
    etaNearBannerRef.current = true;
    setEtaNearBannerShown(true);
    toast(`${(request as any).mechanic_name?.split(' ')[0] ?? 'Mechanic'} is almost there — arriving in ~${mins} min!`, {
      duration: 12000, icon: '🔧',
    });
    if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
  }, [liveRoute?.duration, request?.status]);

  // ── Fetch mechanic public profile when assigned ────────────────────────
  useEffect(() => {
    const mechId = (request as any)?.mechanic_id;
    if (!mechId || mechanicProfile) return;
    const activeStatuses = ['accepted', 'en_route', 'arrived', 'service_started', 'awaiting_confirmation', 'completed'];
    if (!activeStatuses.includes(request?.status ?? '')) return;
    mechanicService.getPublicProfile(mechId)
      .then(res => setMechanicProfile(res.data))
      .catch(() => {});
  }, [(request as any)?.mechanic_id, request?.status]);

  // Show the mechanic card automatically once profile loads
  useEffect(() => {
    if (!mechanicProfile || mechanicCardDismissed) return;
    const showStatuses = ['accepted', 'en_route', 'arrived', 'service_started'];
    if (showStatuses.includes(request?.status ?? '')) {
      setShowMechanicCard(true);
    }
  // Only run when profile first arrives — don't re-run on every status tick
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mechanicProfile]);

  // ── Check if driver already reviewed this completed job ──────────────────
  useEffect(() => {
    if (request?.status !== 'completed' || !id) return;
    requestsService.getReview(id)
      .then(() => setAlreadyReviewed(true))
      .catch(() => { /* 404 = no review yet — show the button */ });
  }, [request?.status, id]);

  // ── Poll for quote every 5 s once mechanic accepted ───────────────────────
  const fetchQuote = useCallback(() => {
    if (!paymentsEnabled) return;
    if (!id) return;
    paymentsService.getQuote(id)
      .then((res) => setQuote(res.data))
      .catch(() => {/* no quote yet — keep polling */});
  }, [id, paymentsEnabled]);

  useEffect(() => {
    if (!request) return;
    if (!paymentsEnabled) return;
    const status = request.status;

    // Poll for quote across all active statuses; payment is due at 'completed'
    const activeStatuses = ['accepted', 'en_route', 'arrived', 'service_started', 'in_progress', 'awaiting_confirmation', 'completed'];
    if (activeStatuses.includes(status)) {
      fetchQuote(); // immediate first fetch
      if (status !== 'completed') {
        quotePollingRef.current = setInterval(fetchQuote, 5000);
        return () => {
          if (quotePollingRef.current) clearInterval(quotePollingRef.current);
        };
      }
    }

    return () => {
      if (quotePollingRef.current) clearInterval(quotePollingRef.current);
    };
  }, [request?.status, fetchQuote, paymentsEnabled]);

  // ── Poll payment status after collection initiated ────────────────────────
  useEffect(() => {
    if (!paymentsEnabled) return;
    if (!id || !quote || quote.collection_status !== 'initiated') return;
    paymentPollingRef.current = setInterval(() => {
      paymentsService.getStatus(id).then((res) => {
        const updated: QuoteRecord = res.data;
        setQuote(updated);
        if (updated.collection_status === 'successful' || updated.collection_status === 'success') {
          if (paymentPollingRef.current) clearInterval(paymentPollingRef.current);
          toast.success('Payment confirmed!');
        } else if (updated.collection_status === 'failed') {
          if (paymentPollingRef.current) clearInterval(paymentPollingRef.current);
          toast.error('Payment failed. Please try again.');
        }
      }).catch(() => {});
    }, 5000);
    return () => { if (paymentPollingRef.current) clearInterval(paymentPollingRef.current); };
  }, [id, quote?.collection_status, paymentsEnabled]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const CANCEL_REASONS = [
    'I no longer need the service',
    'I found another mechanic',
    'The wait time is too long',
    'I placed the request by mistake',
    'Other',
  ];

  const canCancel = new Set(['pending', 'accepted', 'en_route', 'arrived']).has(request?.status ?? '');
  const canCall = request?.status === 'accepted' || request?.status === 'en_route';

  const handleCancelConfirm = async () => {
    if (!id) return;
    const reason = cancelReason === 'Other' ? cancelOther.trim() : cancelReason;
    if (!reason) { toast.error('Please select a reason'); return; }

    // Optimistic cancel: reflect it on screen IMMEDIATELY instead of waiting for the
    // server round-trip (which used to leave the modal stuck on "Cancelling…" until a
    // manual refresh). markCancelled flips it in the shared store and keeps it cancelled
    // until the server confirms; we also flip the local copy and leave the screen at once.
    markCancelled(id);
    setRequest(prev => (prev ? { ...prev, status: 'cancelled' } : prev));
    setCancelPhase(null);
    toast.success('Request cancelled');
    navigate(-1);

    // Tell the server in the background. If it rejects, undo the optimistic cancel so the
    // request reappears as active and the driver knows it didn't go through.
    try {
      await requestsService.updateStatus(id, 'cancelled', reason);
    } catch (err: any) {
      revertCancelled(id);
      toast.error(err.response?.data?.detail || "Couldn't cancel the request — please try again.");
    }
  };

  const handleCall = async () => {
    if (!id || !canCall) return;
    if (mechanicPhone) { setShowCallSheet(true); return; }
    setIsCalling(true);
    try {
      const res = await requestsService.getCallPartner(id);
      if (res.data?.phone) {
        setMechanicPhone(res.data.phone);
        setShowCallSheet(true);
      }
    } catch (err: any) {
      toast.error(err.response?.data?.detail || 'Unable to call mechanic');
    } finally {
      setIsCalling(false);
    }
  };

  const handleTryAgain = async () => {
    if (!id) return;
    setIsTryingAgain(true);
    try {
      const res = await requestsService.redispatch(id);
      const updated = res.data?.request ?? res.data;
      if (updated) setRequest((prev: any) => ({ ...prev, ...updated }));
      setNoProviders(false);
      toast('Looking for mechanics again…', { icon: '🔍' });
    } catch (err: any) {
      toast.error(err.response?.data?.detail || 'Failed to redispatch. Please try again.');
    } finally {
      setIsTryingAgain(false);
    }
  };

  const handleApproveQuote = async () => {
    if (!id) return;
    setIsApprovingQuote(true);
    try {
      await paymentsService.approveQuote(id);
      setQuote((q) => q ? { ...q, quote_approved: true } : q);
      toast.success('Quote approved!');
    } catch (err: any) {
      toast.error(err.response?.data?.detail || 'Failed to approve quote');
    } finally {
      setIsApprovingQuote(false);
    }
  };

  const handlePay = async () => {
    if (!id || !quote) return;
    const phone = momoPhone.trim().replace(/\s+/g, '');
    if (!phone) { toast.error('Enter your Mobile Money number'); return; }
    setIsPaying(true);
    try {
      await paymentsService.collect(id, phone);
      setQuote((q) => q ? { ...q, collection_status: 'initiated' } : q);
      toast.success('Payment initiated — approve the prompt on your phone');
    } catch (err: any) {
      toast.error(err.response?.data?.detail || 'Payment failed. Please try again.');
    } finally {
      setIsPaying(false);
    }
  };

  const handlePayCash = async () => {
    if (!id || !quote) return;
    setIsCashPaying(true);
    try {
      await paymentsService.payCash(id);
      setQuote((q) => q ? { ...q, collection_status: 'cash' } : q);
      toast.success('Cash payment recorded!');
    } catch (err: any) {
      toast.error(err.response?.data?.detail || 'Failed to record cash payment.');
    } finally {
      setIsCashPaying(false);
    }
  };

  // ── Loading ───────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <header className="sticky top-0 z-10 bg-card/80 backdrop-blur border-b border-border/50 px-4 py-4">
          <button type="button" onClick={() => navigate(-1)} className="flex items-center gap-2 text-muted-foreground">
            <ChevronLeft className="w-5 h-5" /> Back
          </button>
        </header>
        <div className="p-4 max-w-md mx-auto space-y-4 animate-pulse">
          <div className="h-6 bg-muted rounded w-40" />
          <div className="h-[320px] bg-muted rounded-2xl" />
          <div className="h-20 bg-muted rounded-2xl" />
        </div>
      </div>
    );
  }

  if (!request) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4 p-4">
        <AlertCircle className="w-12 h-12 text-destructive" />
        <p className="text-foreground font-semibold">Request not found</p>
        <button type="button" onClick={() => navigate(-1)} className="text-primary text-sm">Go back</button>
      </div>
    );
  }

  const shortId = `#${String(request.id).padStart(6, '0')}`;
  const badge = STATUS_BADGE[request.status] ?? STATUS_BADGE.pending;
  const currentStep = stepIndex(request.status);
  const isCancelled = request.status === 'cancelled';

  // Quote display conditions
  const hasQuote = !!quote;
  const paymentPending = quote?.collection_status === 'initiated';
  const paymentSuccess = paymentsEnabled && (
    quote?.collection_status === 'successful' ||
    quote?.collection_status === 'success' ||
    quote?.collection_status === 'cash'
  );
  const paymentDue = paymentsEnabled && hasQuote && !paymentSuccess && request?.status === 'completed';

  return (
    <div className="min-h-screen bg-background pb-28">

      {/* Header */}
      <header className="sticky top-0 z-10 bg-card/80 backdrop-blur border-b border-border/50 px-4 py-3 flex items-center gap-3">
        <button type="button" onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-xl hover:bg-muted transition-colors" aria-label="Go back">
          <ChevronLeft className="w-5 h-5 text-foreground" />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="font-bold text-foreground truncate">{request.service_type}</h1>
          <p className="text-xs text-muted-foreground">{shortId}</p>
        </div>
        <span className={cn('px-3 py-1 rounded-full text-xs font-bold border shrink-0', badge.className)} style={badge.style}>
          {badge.label}
        </span>
      </header>

      <div className="p-4 max-w-md mx-auto space-y-4">

        {/* Arrival estimate + progress bar — appears ONLY once the mechanic starts
            the journey (en_route) and sits ABOVE the map. The bar fills with the
            route colour as the mechanic pin nears the driver's pin. */}
        {request.status === 'en_route' && (() => {
          const win = arrivalWindow(request.en_route_at, request.eta_minutes);
          const pct = Math.round(Math.max(0, Math.min(1, mechProgress)) * 100);
          // Live ETA + distance — the SAME figures the mechanic sees on their map,
          // shown here above the loader (not on the map).
          const eta  = liveRoute?.duration;   // "8 min" | "Arriving"
          const dist = liveRoute?.distance;   // "3.7 km"
          const etaParts = eta && eta !== 'Arriving' ? eta.match(/^(\d+)\s*(.*)$/) : null;
          // Big, bold orange→yellow gradient numerals (matching the dashboard amber).
          const amberText: React.CSSProperties = {
            background: 'linear-gradient(135deg, #FBBF24, #F59E0B)',
            WebkitBackgroundClip: 'text', backgroundClip: 'text',
            WebkitTextFillColor: 'transparent', color: '#F59E0B',
          };
          return (
            <div className="animate-slide-up" style={{ padding: '2px 2px 0' }}>
              {eta ? (
                <>
                  <p style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--text-faint)', marginBottom: 3 }}>
                    Arriving in
                  </p>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: win ? 4 : 10 }}>
                    {etaParts ? (
                      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}>
                        <span style={{ ...amberText, fontSize: 48, fontWeight: 900, lineHeight: 0.95, letterSpacing: '-0.03em' }}>{etaParts[1]}</span>
                        <span style={{ ...amberText, fontSize: 20, fontWeight: 800 }}>{etaParts[2]}</span>
                      </span>
                    ) : (
                      <span style={{ ...amberText, fontSize: 38, fontWeight: 900, lineHeight: 1, letterSpacing: '-0.02em' }}>{eta}</span>
                    )}
                    {dist && <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-lo)' }}>· {dist} away</span>}
                  </div>
                  {win && (
                    <p style={{ fontSize: 12.5, color: 'var(--text-lo)', marginBottom: 10 }}>
                      Between <span style={{ color: '#F59E0B', fontWeight: 800 }}>{win}</span>
                    </p>
                  )}
                </>
              ) : (
                <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-hi)', lineHeight: 1.35, marginBottom: 10 }}>
                  {win
                    ? <>Your mechanic will be there between <span style={{ color: '#F59E0B', fontWeight: 800 }}>{win}</span></>
                    : 'Estimating your mechanic’s arrival…'}
                </p>
              )}
              {/* Grey track filling with the route's orange/yellow as the mechanic advances */}
              <div style={{ height: 8, borderRadius: 999, background: 'var(--surface-4)', overflow: 'hidden' }}>
                <div style={{
                  height: '100%', width: `${pct}%`,
                  background: 'linear-gradient(90deg, #F59E0B, #FBBF24)',
                  borderRadius: 999,
                  transition: 'width 1.2s linear',
                }} />
              </div>
            </div>
          );
        })()}

        {/* Tracking map — shows while heading to you; auto-closes once service starts */}
        {(mapCoords != null || gpsLat != null || request.mechanic_lat != null) &&
         ['pending', 'accepted', 'en_route', 'arrived'].includes(request.status) && (
          <div className="animate-slide-up">
            <TrackingMap
              driverLat={mapCoords?.lat ?? gpsLat}
              driverLng={mapCoords?.lon ?? gpsLng}
              arrived={request.status === 'arrived'}
              assigned={['accepted', 'en_route'].includes(request.status)}
              simActive={request.status === 'en_route'}
              requestId={request.id}
              enRouteAt={(request as any).en_route_at}
              onRouteUpdate={handleRouteUpdate}
              onProgress={handleProgress}
            />
          </div>
        )}


        {/* "Almost there" banner + AI "Do you see them?" prompt — ETA ≤ 5 min */}
        {request.status === 'en_route' && etaNearBannerShown && (
          <div className="animate-slide-up" style={{ animationDelay: '0.02s' }}>
            <div style={{
              borderRadius: 16,
              background: 'linear-gradient(135deg, rgba(245,158,11,0.18), rgba(249,115,22,0.10))',
              border: '1.5px solid rgba(245,158,11,0.55)',
              padding: '14px 16px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                <div style={{ fontSize: 26, flexShrink: 0 }}>🔧</div>
                <div>
                  <p style={{ fontSize: 13, fontWeight: 800, color: '#F59E0B', marginBottom: 2 }}>
                    Almost there!
                  </p>
                  <p style={{ fontSize: 12, color: 'var(--text-lo)', lineHeight: 1.4 }}>
                    {(request as any).mechanic_name?.split(' ')[0] ?? 'Mechanic'} is almost here
                  </p>
                </div>
              </div>

              {/* AI prompt */}
              <div style={{
                display: 'flex', gap: 10, alignItems: 'flex-start',
                padding: '10px 12px', borderRadius: 12,
                background: 'rgba(0,0,0,0.18)', border: '1px solid var(--border-2)',
                marginBottom: 10,
              }}>
                <div style={{ fontSize: 18, flexShrink: 0, lineHeight: 1.3 }}>🤖</div>
                <p style={{ fontSize: 12.5, color: 'var(--text-hi)', lineHeight: 1.5, margin: 0 }}>
                  Can you see your mechanic nearby? Tap below once they reach you so we can start the service.
                </p>
              </div>

              <button
                onClick={handleSeeMechanic}
                disabled={confirmingSeen}
                style={{
                  width: '100%', height: 46, borderRadius: 12, border: 'none',
                  background: confirmingSeen ? 'rgba(34,197,94,0.4)' : 'linear-gradient(135deg, #22C55E, #16A34A)',
                  color: confirmingSeen ? '#fff' : '#000', fontWeight: 800, fontSize: 14,
                  cursor: confirmingSeen ? 'not-allowed' : 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  boxShadow: confirmingSeen ? 'none' : '0 4px 16px rgba(34,197,94,0.35)',
                }}
              >
                {confirmingSeen
                  ? <><Loader2 style={{ width: 16, height: 16, animation: 'spin 1s linear infinite' }} /> Starting service…</>
                  : <><CheckCircle2 style={{ width: 16, height: 16 }} /> Yes, I can see {(request as any).mechanic_name?.split(' ')[0] ?? 'them'}</>
                }
              </button>
            </div>
          </div>
        )}

        {/* Mechanic Arrived banner */}
        {request.status === 'arrived' && (
          <div className="animate-slide-up" style={{ animationDelay: '0.03s' }}>
            <div style={{
              borderRadius: 16,
              background: 'rgba(139,92,246,0.10)',
              border: '1.5px solid rgba(139,92,246,0.35)',
              padding: '14px 16px',
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <div style={{
                width: 42, height: 42, borderRadius: 12,
                background: 'rgba(139,92,246,0.18)',
                border: '1px solid rgba(139,92,246,0.35)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                <CheckCircle2 style={{ width: 20, height: 20, color: '#8B5CF6' }} />
              </div>
              <div>
                <p style={{ fontSize: 13, fontWeight: 800, color: '#8B5CF6', marginBottom: 2 }}>
                  Your mechanic has arrived!
                </p>
                <p style={{ fontSize: 12, color: 'var(--text-lo)', lineHeight: 1.4 }}>
                  {(request as any).mechanic_name ?? 'Mechanic'} is at your location
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Location + description */}
        <div className="glass-card rounded-2xl p-4 space-y-3 animate-slide-up" style={{ animationDelay: '0.05s' }}>
          <div className="flex items-start gap-3">
            <MapPin className="w-5 h-5 shrink-0 mt-0.5" style={{ color: '#F59E0B' }} />
            <div>
              <p className="text-xs mb-0.5" style={{ color: '#F59E0B', fontWeight: 700 }}>Location</p>
              <p className="text-sm text-foreground">{displayLocation || request.location || '—'}</p>
            </div>
          </div>
          {request.description && (
            <div className="flex items-start gap-3">
              <Wrench className="w-5 h-5 shrink-0 mt-0.5" style={{ color: '#F59E0B' }} />
              <div>
                <p className="text-xs mb-0.5" style={{ color: '#F59E0B', fontWeight: 700 }}>Description</p>
                <p className="text-sm text-foreground">{request.description}</p>
              </div>
            </div>
          )}
          {request.created_at && (
            <div className="flex items-start gap-3">
              <Clock className="w-5 h-5 shrink-0 mt-0.5" style={{ color: '#F59E0B' }} />
              <div>
                <p className="text-xs mb-0.5" style={{ color: '#F59E0B', fontWeight: 700 }}>Requested at</p>
                <p className="text-sm text-foreground">
                  {new Date(normTs(request.created_at)).toLocaleString('en-UG', {
                    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Kampala',
                  })}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Mechanic info card — shown once accepted */}
        {(request.status === 'accepted' || request.status === 'en_route' || request.status === 'arrived' || request.status === 'service_started') && request.mechanic_name && (
          <div className="glass-card rounded-2xl overflow-hidden animate-slide-up" style={{ animationDelay: '0.1s' }}>
            {/* Avatar + name row */}
            <div style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: 14, borderBottom: '1px solid var(--border-2)' }}>
              {/* Profile photo placeholder — replace src with mechanic.photo_url when available */}
              <div style={{ width: 58, height: 58, borderRadius: '50%', background: 'linear-gradient(135deg, #F59E0B, #D97706)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 4px 14px rgba(245,158,11,0.45)', fontSize: 20, fontWeight: 800, color: '#000' }}>
                {(request.mechanic_name ?? 'M').split(' ').map((p: string) => p[0]).slice(0, 2).join('').toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 3 }}>Your Mechanic</p>
                <p style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-hi)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{request.mechanic_name}</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 4 }}>
                  <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#22C55E', boxShadow: '0 0 5px #22C55E', flexShrink: 0 }} />
                  {request.status === 'en_route' && <span style={{ fontSize: 11, color: '#F59E0B', fontWeight: 600 }}>On the way to you</span>}
                  {request.status === 'arrived'  && <span style={{ fontSize: 11, color: '#8B5CF6', fontWeight: 600 }}>Arrived at your location</span>}
                  {request.status === 'accepted' && <span style={{ fontSize: 11, color: '#3B82F6', fontWeight: 600 }}>Getting ready to head out</span>}
                  {request.status === 'service_started' && <span style={{ fontSize: 11, color: '#F97316', fontWeight: 600 }}>Service in progress</span>}
                </div>
              </div>
            </div>

            {/* Contact details */}
            {mechanicPhone && (
              <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-2)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <Phone style={{ width: 13, height: 13, color: 'var(--text-faint)', flexShrink: 0 }} />
                <span style={{ fontSize: 13, color: 'var(--text-md)' }}>{mechanicPhone}</span>
              </div>
            )}

            {/* Action buttons */}
            <div style={{ padding: '12px 16px', display: 'flex', gap: 8 }}>
              <button
                onClick={handleCall}
                disabled={isCalling}
                style={{ flex: 1, height: 42, borderRadius: 12, border: '1.5px solid rgba(245,158,11,0.5)', background: 'rgba(245,158,11,0.10)', color: '#F59E0B', fontSize: 13, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
              >
                {isCalling
                  ? <Loader2 style={{ width: 14, height: 14, animation: 'spin 1s linear infinite' }} />
                  : <Phone style={{ width: 14, height: 14 }} />}
                Call
              </button>
              <button
                onClick={() => navigate(`/requests/${request.id}/chat`)}
                style={{ flex: 1, height: 42, borderRadius: 12, border: '1.5px solid rgba(59,130,246,0.5)', background: 'rgba(59,130,246,0.10)', color: '#3B82F6', fontSize: 13, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
              >
                <MessageCircle style={{ width: 14, height: 14 }} /> Chat
              </button>
            </div>
          </div>
        )}

        {/* Payment confirmed inline banner */}
        {paymentSuccess && (
          <div className="glass-card rounded-2xl p-4 animate-slide-up flex items-center gap-3 border border-success/30 bg-success/10" style={{ animationDelay: '0.12s' }}>
            <CheckCircle2 className="w-6 h-6 text-success shrink-0" />
            <div>
              <p className="text-sm font-bold text-success">Payment confirmed</p>
              <p className="text-xs text-muted-foreground">UGX {quote!.quoted_amount.toLocaleString()} — mechanic payout is being processed</p>
            </div>
          </div>
        )}

        {/* Status Timeline */}
        {!isCancelled && (
          <div className="glass-card rounded-2xl p-4 animate-slide-up" style={{ animationDelay: '0.16s' }}>
            {/* Header: label + active status pill — matches mechanic app */}
            {(() => {
              const pillColor = STATUS_STEP_COLOR[request.status] ?? '#F59E0B';
              const pillLabel = STATUS_STEPS.find(s => s.key === request.status)?.label
                ?? STATUS_BADGE[request.status]?.label
                ?? request.status;
              return (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-faint, rgba(255,255,255,0.4))', textTransform: 'uppercase', letterSpacing: '0.12em' }}>
                    {jobTypeLabel} · Job Progress
                  </span>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    background: pillColor + '18',
                    border: `1.5px solid ${pillColor}45`,
                    borderRadius: 20,
                    padding: '4px 12px 4px 8px',
                  }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: pillColor, boxShadow: `0 0 6px ${pillColor}` }} />
                    <span style={{ fontSize: 12, fontWeight: 800, color: pillColor }}>{pillLabel}</span>
                  </div>
                </div>
              );
            })()}
            {(() => {
              const dispatchedAt = request.dispatched_at || request.created_at;
              const tAccept = minutesBetween(dispatchedAt, request.accepted_at);
              const tDrive = minutesBetween(request.en_route_at || request.accepted_at, request.arrived_at);
              const tService = minutesBetween(request.service_started_at, request.completed_at);
              const total = minutesBetween(dispatchedAt, request.completed_at);
              // The drive/service/total timings are a post-job SUMMARY — only show them
              // once the job is completed, never mid-service (avoids stale live values).
              const isDone = request.status === 'completed';
              const items = [
                // Pending → live countdown; once accepted the card disappears
                request.status === 'pending' && acceptCountdown != null
                  ? { label: 'Time to Accept', value: acceptCountdown }
                  : null,
                isDone && tDrive   != null ? { label: 'Drive time',     value: fmtDuration(tDrive) }   : null,
                isDone && tService != null ? { label: 'Service time',   value: fmtDuration(tService) } : null,
                isDone && total    != null ? { label: 'Total duration', value: fmtDuration(total) }    : null,
              ].filter(Boolean) as { label: string; value: string }[];
              if (items.length === 0) return null;
              return (
                <div className="grid grid-cols-2 gap-2 mb-4">
                  {items.map((it) => {
                    const isCountdown = it.label === 'Time to Accept';
                    const barColor = (acceptSecondsLeft ?? 300) > 120
                      ? '#F59E0B'
                      : (acceptSecondsLeft ?? 300) > 60
                        ? '#fb923c'
                        : '#f87171';
                    const barPct = Math.max(0, ((acceptSecondsLeft ?? 0) / 300) * 100);
                    return (
                      <div key={it.label} className="rounded-xl border border-border/50 bg-card/50 px-3 py-2">
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{it.label}</p>
                        <p className="text-sm font-bold text-foreground flex items-center gap-1">
                          <Clock className="w-3.5 h-3.5 text-muted-foreground" /> {it.value}
                        </p>
                        {isCountdown && (
                          <div style={{ height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.1)', marginTop: 6, overflow: 'hidden' }}>
                            <div style={{
                              height: '100%', borderRadius: 2,
                              background: `linear-gradient(90deg, ${barColor}, ${barColor}bb)`,
                              width: `${barPct}%`,
                              transition: 'width 1s linear, background 0.5s ease',
                              boxShadow: `0 0 6px ${barColor}88`,
                            }} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })()}
            <style>{`@keyframes step-pulse{0%,100%{opacity:.7;transform:scale(1)}50%{opacity:1;transform:scale(1.2)}}`}</style>
            <div>
              {/* Service Started auto-checks once reached — service begins automatically on arrival */}
              {STATUS_STEPS.map((step, i) => {
                const isCompleted = request.status === 'completed';
                // A step's milestone is "reached" (ticked) as soon as the status
                // arrives AT it — so the step matching the current status ticks
                // immediately, in sync with the option just triggered, instead of
                // lagging one step behind. The current step gets a distinct colored,
                // pulsing check ("you are here") so it's never mistaken for pending.
                const reached   = isCompleted || (currentStep >= 0 && i <= currentStep);
                const isCurrent = !isCompleted && i === currentStep;
                const isLast = i === STATUS_STEPS.length - 1;
                const activeColor = STATUS_STEP_COLOR[request.status] ?? '#F59E0B';
                return (
                  <div key={step.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                      {reached ? (
                        <div style={{ position: 'relative', width: 20, height: 20, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {isCurrent && (
                            <span style={{
                              position: 'absolute', inset: -4, borderRadius: '50%',
                              border: `2px solid ${activeColor}`,
                              animation: 'step-pulse 1.8s ease-in-out infinite',
                            }} />
                          )}
                          <CheckCircle2 style={{ width: 20, height: 20, flexShrink: 0, color: isCurrent ? activeColor : '#22C55E' }} />
                        </div>
                      ) : (
                        <Circle style={{ width: 20, height: 20, flexShrink: 0, color: 'rgba(255,255,255,0.18)' }} />
                      )}
                      {!isLast && (
                        <div style={{
                          width: 2, flex: 1, minHeight: 24,
                          margin: '4px 0', borderRadius: 1,
                          // Green only between two reached steps; the segment leaving
                          // the current step stays dim until the next milestone hits.
                          background: (isCompleted || i < currentStep) ? 'rgba(74,222,128,0.4)' : 'rgba(255,255,255,0.10)',
                        }} />
                      )}
                    </div>
                    <div style={{ paddingBottom: isLast ? 0 : 16 }}>
                      <p style={{
                        fontSize: 13,
                        fontWeight: isCurrent ? 800 : reached ? 600 : 500,
                        lineHeight: 1.3,
                        color: isCurrent ? activeColor : reached ? 'var(--text-hi, rgba(255,255,255,0.88))' : 'var(--text-faint, rgba(255,255,255,0.35))',
                      }}>
                        {step.label}
                      </p>
                      {isCurrent && (
                        <p style={{ fontSize: 12, color: 'var(--text-faint, rgba(255,255,255,0.45))', marginTop: 3, lineHeight: 1.5 }}>
                          {step.desc}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Confirmation — the mechanic marked the job done. When they sent a final
            bill (actual_fee), run the full pay-then-confirm flow; otherwise fall back
            to the simple "confirm job done" card. */}
        {request.status === 'awaiting_confirmation' && request.completion_by !== 'driver' && (
          request.actual_fee != null ? (
            <FinalPaymentFlow
              requestId={String(id)}
              amountDue={Number(request.actual_fee) || 0}
              mechanicName={(request as any).mechanic_name ?? 'your mechanic'}
              mechanicPhone={mechanicPhone}
              serviceNote={(request as any).service_note ?? null}
              sendMessage={wsSend}
              lastMessage={chatWsMessage}
              onPaid={markFeePaid}
              onMessageMechanic={() => navigate(`/requests/${id}/chat`)}
            />
          ) : (
            <ConfirmJobCard
              onConfirm={async () => {
                await requestsService.updateStatus(id!, 'completed');
                // Optimistically reflect completion so the timeline ticks through immediately
                setRequest(prev => prev ? { ...prev, status: 'completed', completed_at: prev.completed_at ?? new Date().toISOString() } : prev);
                try {
                  sessionStorage.setItem('motofix_pending_review', JSON.stringify({
                    requestId: String(id),
                    mechanicName: (request as any).mechanic_name ?? 'your mechanic',
                    mechanicId: request.mechanic_id,
                    serviceType: request.service_type,
                    description: request.description,
                  }));
                } catch {}
                toast.success('Job confirmed. Thank you!');
              }}
              onDecline={() => toast('Sort it out with the mechanic and tap "Yes, Job is Done" when ready.', { duration: 4000 })}
            />
          )
        )}

        {/* Waiting — the DRIVER marked it done, now waiting on the mechanic to confirm */}
        {request.status === 'awaiting_confirmation' && request.completion_by === 'driver' && (
          <div className="animate-slide-up" style={{
            borderRadius: 18, padding: '16px',
            background: 'rgba(167,139,250,0.10)', border: '1.5px solid rgba(167,139,250,0.35)',
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <Loader2 style={{ width: 22, height: 22, color: '#A78BFA', animation: 'spin 1.4s linear infinite', flexShrink: 0 }} />
            <div>
              <p style={{ fontSize: 14, fontWeight: 800, color: '#A78BFA', marginBottom: 2 }}>Waiting for your mechanic to confirm</p>
              <p style={{ fontSize: 12, color: 'var(--text-lo)', lineHeight: 1.5 }}>
                You marked the job done. It auto-completes if there's no response within 30 minutes.
              </p>
            </div>
          </div>
        )}

        {/* Fallback — driver can mark the job done if the mechanic forgot to */}
        {request.status === 'service_started' && (
          <button
            onClick={handleDriverMarkDone}
            className="animate-slide-up"
            style={{
              width: '100%', padding: '12px 16px', borderRadius: 14,
              background: 'rgba(34,197,94,0.08)', border: '1.5px solid rgba(34,197,94,0.30)',
              color: '#22C55E', fontWeight: 700, fontSize: 13, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}
          >
            <CheckCircle2 style={{ width: 16, height: 16 }} /> The service is complete — mark as done
          </button>
        )}

        {/* Payment card — shown when job is completed and payment not yet made */}
        {paymentDue && (
          <div className="animate-slide-up" style={{ animationDelay: '0.18s' }}>
            <div style={{
              borderRadius: 18,
              background: 'rgba(245,158,11,0.06)',
              border: '1.5px solid rgba(245,158,11,0.3)',
              padding: '16px 16px 14px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <DollarSign style={{ width: 16, height: 16, color: '#F59E0B' }} />
                  <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-hi)' }}>Payment Due</p>
                </div>
                <p style={{ fontSize: 18, fontWeight: 900, color: '#F59E0B' }}>
                  UGX {quote!.quoted_amount.toLocaleString()}
                </p>
              </div>

              {paymentPending ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0' }}>
                  <Loader2 style={{ width: 18, height: 18, color: '#3B82F6', animation: 'spin 1s linear infinite', flexShrink: 0 }} />
                  <div>
                    <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-hi)' }}>Awaiting confirmation</p>
                    <p style={{ fontSize: 11, color: 'var(--text-lo)', marginTop: 2 }}>Approve the prompt on your phone</p>
                  </div>
                </div>
              ) : (
                <>
                  <input
                    type="tel"
                    placeholder="Mobile Money number (e.g. 0771234567)"
                    value={momoPhone}
                    onChange={(e) => setMomoPhone(e.target.value)}
                    style={{
                      width: '100%', height: 44, borderRadius: 12,
                      border: '1.5px solid rgba(245,158,11,0.25)',
                      background: 'rgba(245,158,11,0.05)',
                      color: 'var(--text-hi)',
                      padding: '0 14px',
                      fontSize: 14,
                      marginBottom: 10,
                      boxSizing: 'border-box',
                      outline: 'none',
                    }}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={handlePay}
                      disabled={isPaying || isCashPaying}
                      style={{
                        flex: 1, height: 44, borderRadius: 12,
                        border: '1.5px solid rgba(245,158,11,0.5)',
                        background: isPaying ? 'rgba(245,158,11,0.05)' : 'rgba(245,158,11,0.15)',
                        color: '#F59E0B', fontSize: 13, fontWeight: 700,
                        cursor: (isPaying || isCashPaying) ? 'not-allowed' : 'pointer',
                        opacity: (isPaying || isCashPaying) ? 0.7 : 1,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                      }}
                    >
                      {isPaying
                        ? <Loader2 style={{ width: 14, height: 14, animation: 'spin 1s linear infinite' }} />
                        : <Smartphone style={{ width: 14, height: 14 }} />}
                      Mobile Money
                    </button>
                    <button
                      onClick={handlePayCash}
                      disabled={isPaying || isCashPaying}
                      style={{
                        flex: 1, height: 44, borderRadius: 12,
                        border: '1.5px solid rgba(34,197,94,0.4)',
                        background: isCashPaying ? 'rgba(34,197,94,0.05)' : 'rgba(34,197,94,0.10)',
                        color: '#22C55E', fontSize: 13, fontWeight: 700,
                        cursor: (isPaying || isCashPaying) ? 'not-allowed' : 'pointer',
                        opacity: (isPaying || isCashPaying) ? 0.7 : 1,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                      }}
                    >
                      {isCashPaying
                        ? <Loader2 style={{ width: 14, height: 14, animation: 'spin 1s linear infinite' }} />
                        : <DollarSign style={{ width: 14, height: 14 }} />}
                      Pay Cash
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Final bill + Proceed to Pay — appears once the job is confirmed done,
            just before the rating. Driver pays only after confirming completion. */}
        {request.status === 'completed' && request.actual_fee != null && (() => {
          const fixes = (request.service_note ?? '').split(';').map(s => s.trim()).filter(Boolean);
          const amount = Number(request.actual_fee) || 0;
          return (
            <div className="animate-slide-up" style={{
              borderRadius: 18, padding: '18px 16px', marginBottom: 4,
              background: feePaid ? 'rgba(34,197,94,0.08)' : 'rgba(245,158,11,0.07)',
              border: `1.5px solid ${feePaid ? 'rgba(34,197,94,0.35)' : 'rgba(245,158,11,0.4)'}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <CheckCircle2 style={{ width: 18, height: 18, color: feePaid ? '#22C55E' : '#F59E0B' }} />
                <p style={{ fontSize: 14, fontWeight: 800, color: feePaid ? '#22C55E' : '#F59E0B' }}>
                  {feePaid ? 'Payment complete' : 'Service complete — payment due'}
                </p>
              </div>

              {fixes.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 7 }}>What was done</p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {fixes.map((f, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                        <Check style={{ width: 14, height: 14, color: '#22C55E', flexShrink: 0, marginTop: 2 }} />
                        <span style={{ fontSize: 13, color: 'var(--text-hi)', lineHeight: 1.4 }}>{f}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', paddingTop: 12, borderTop: '1px solid var(--border-2)', marginBottom: feePaid ? 0 : 14 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-lo)' }}>Total to pay</span>
                <span style={{ fontSize: 26, fontWeight: 900, color: '#F59E0B', letterSpacing: '-0.02em' }}>UGX {amount.toLocaleString()}</span>
              </div>

              {feePaid ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 12, fontSize: 12.5, color: '#22C55E', fontWeight: 700 }}>
                  <CheckCircle2 style={{ width: 15, height: 15 }} /> Paid — thank you!
                </div>
              ) : (
                <button
                  onClick={() => setShowFeePaySheet(true)}
                  style={{
                    width: '100%', height: 50, borderRadius: 14, border: 'none',
                    background: 'linear-gradient(135deg, #F59E0B, #D97706)', color: '#000',
                    fontWeight: 800, fontSize: 15, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  }}>
                  <DollarSign style={{ width: 17, height: 17 }} /> Proceed to Pay
                </button>
              )}
            </div>
          );
        })()}

        {/* Rate mechanic CTA — shown when job is completed */}
        {request.status === 'completed' && (
          <div className="animate-slide-up" style={{ animationDelay: '0.20s' }}>
            {alreadyReviewed ? (
              <div style={{
                borderRadius: 18,
                background: 'rgba(34,197,94,0.08)',
                border: '1.5px solid rgba(34,197,94,0.25)',
                padding: '14px 18px',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}>
                <CheckCircle2 style={{ width: 20, height: 20, color: '#22C55E', flexShrink: 0 }} />
                <div>
                  <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-hi)' }}>Review submitted</p>
                  <p style={{ fontSize: 11, color: 'var(--text-lo)', marginTop: 2 }}>Thank you for rating your mechanic.</p>
                </div>
              </div>
            ) : (
              <button
                onClick={() => navigate('/rate-motofix', {
                  state: {
                    mode: 'mechanic',
                    requestId: String(id),
                    mechanicName: (request as any).mechanic_name ?? 'your mechanic',
                    mechanicId: request.mechanic_id,
                    serviceType: request.service_type,
                    description: request.description,
                  },
                })}
                style={{
                  width: '100%',
                  height: 56,
                  borderRadius: 18,
                  border: '1.5px solid rgba(245,158,11,0.5)',
                  background: 'linear-gradient(135deg, rgba(245,158,11,0.15), rgba(217,119,6,0.10))',
                  color: '#F59E0B',
                  fontWeight: 800,
                  fontSize: 15,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                }}
              >
                <Star style={{ width: 18, height: 18, fill: '#F59E0B' }} />
                Rate your mechanic
              </button>
            )}
          </div>
        )}

        {/* Cancelled */}
        {isCancelled && (
          <div className="glass-card rounded-2xl p-4 border-destructive/30 bg-destructive/10 animate-slide-up" style={{ animationDelay: '0.16s' }}>
            <div className="flex items-center gap-3">
              <AlertCircle className="w-5 h-5 text-destructive shrink-0" />
              <p className="text-sm text-foreground">This request has been cancelled.</p>
            </div>
          </div>
        )}

        {/* Cancel Request inline button */}
        {canCancel && (
          <button
            type="button"
            onClick={() => setCancelPhase('warning')}
            style={{
              width: '100%', height: 56, borderRadius: 18, border: 'none',
              background: '#dc2626', color: '#fff',
              fontWeight: 800, fontSize: 15, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              boxShadow: '0 4px 20px rgba(220,38,38,0.35)',
            }}
          >
            <AlertTriangle style={{ width: 18, height: 18 }} />
            Cancel Request
          </button>
        )}
      </div>

      {/* ── Cancel warning modal ── */}
      {cancelPhase === 'warning' && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)' }}
            onClick={() => setCancelPhase(null)}
          />
          <div style={{
            position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 90,
            maxWidth: 480, margin: '0 auto',
            borderRadius: '24px 24px 0 0',
            background: 'var(--overlay-bg)',
            border: '1px solid rgba(239,68,68,0.2)',
            boxShadow: '0 -12px 60px rgba(0,0,0,0.7)',
            padding: '28px 24px',
            paddingBottom: 'max(calc(env(safe-area-inset-bottom, 0px) + 24px), 32px)',
            animation: 'cancel-slide-up 0.34s cubic-bezier(0.34,1.56,0.64,1)',
          }}>
            <style>{`@keyframes cancel-slide-up { from { transform: translateY(100%); } to { transform: translateY(0); } }`}</style>
            <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border-4)', margin: '0 auto 24px' }} />
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
              <div style={{
                width: 64, height: 64, borderRadius: '50%',
                background: 'rgba(239,68,68,0.12)', border: '2px solid rgba(239,68,68,0.35)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <AlertTriangle style={{ width: 30, height: 30, color: '#f87171' }} />
              </div>
            </div>
            <h2 style={{ color: 'var(--text-hi)', fontWeight: 900, fontSize: 20, textAlign: 'center', marginBottom: 10 }}>
              Cancel this request?
            </h2>
            <p style={{ color: 'var(--text-lo)', fontSize: 13, textAlign: 'center', lineHeight: 1.65, marginBottom: 28 }}>
              Cancelling may inconvenience the mechanic already on the way. Are you sure you want to cancel?
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button
                onClick={() => { setCancelPhase('reason'); setCancelReason(''); setCancelOther(''); }}
                style={{
                  width: '100%', height: 54, borderRadius: 16, border: 'none',
                  background: '#dc2626', color: '#fff', fontWeight: 800, fontSize: 15, cursor: 'pointer',
                }}
              >
                Yes, Cancel Request
              </button>
              <button
                onClick={() => setCancelPhase(null)}
                style={{
                  width: '100%', height: 48, borderRadius: 14,
                  background: 'var(--surface-3)', border: '1.5px solid var(--border-3)',
                  color: 'var(--text-md)', fontWeight: 700, fontSize: 14, cursor: 'pointer',
                }}
              >
                No, Keep It
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── Mechanic accepted notification banner ── */}
      {acceptedNotif && request?.mechanic_name && (
        <div style={{
          position: 'fixed', top: 80, left: '50%', transform: 'translateX(-50%)', zIndex: 500,
          background: 'rgba(10,14,30,0.95)', border: '1.5px solid rgba(34,197,94,0.5)',
          borderRadius: 20, padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 12,
          boxShadow: '0 8px 32px rgba(0,0,0,0.5), 0 0 20px rgba(34,197,94,0.2)',
          animation: 'cancel-slide-up 0.4s cubic-bezier(0.34,1.56,0.64,1)',
          maxWidth: 340, backdropFilter: 'blur(12px)',
        }}>
          <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#22C55E', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 16 }}>✓</div>
          <div>
            <p style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-hi)' }}>Mechanic on the way!</p>
            <p style={{ fontSize: 12, color: 'var(--text-faint)' }}>{request.mechanic_name} accepted your request</p>
          </div>
        </div>
      )}

      {/* ── No providers modal (countdown expired) ── */}
      {noProviders && request?.status === 'pending' && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)' }} />
          <div style={{
            position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 90,
            maxWidth: 480, margin: '0 auto',
            borderRadius: '24px 24px 0 0',
            background: 'var(--overlay-bg)',
            border: '1px solid rgba(245,158,11,0.2)',
            boxShadow: '0 -12px 60px rgba(0,0,0,0.7)',
            padding: '28px 24px',
            paddingBottom: 'max(calc(env(safe-area-inset-bottom, 0px) + 24px), 32px)',
            animation: 'cancel-slide-up 0.34s cubic-bezier(0.34,1.56,0.64,1)',
          }}>
            <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border-4)', margin: '0 auto 24px' }} />
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
              <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'rgba(245,158,11,0.12)', border: '2px solid rgba(245,158,11,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <AlertTriangle style={{ width: 30, height: 30, color: '#F59E0B' }} />
              </div>
            </div>
            <h2 style={{ color: 'var(--text-hi)', fontWeight: 900, fontSize: 20, textAlign: 'center', marginBottom: 10 }}>
              No mechanics available
            </h2>
            <p style={{ color: 'var(--text-lo)', fontSize: 13, textAlign: 'center', lineHeight: 1.65, marginBottom: 28 }}>
              No service providers accepted your request in time. You can try again or cancel the request.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button
                onClick={handleTryAgain}
                disabled={isTryingAgain}
                style={{ width: '100%', height: 54, borderRadius: 16, border: 'none', background: isTryingAgain ? 'rgba(245,158,11,0.5)' : 'linear-gradient(135deg, #F59E0B, #D97706)', color: '#000', fontWeight: 800, fontSize: 15, cursor: isTryingAgain ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
              >
                {isTryingAgain && <Loader2 style={{ width: 16, height: 16, animation: 'spin 1s linear infinite' }} />}
                {isTryingAgain ? 'Cancelling…' : 'Try Again'}
              </button>
              <button
                onClick={() => { setNoProviders(false); setCancelPhase('warning'); }}
                style={{ width: '100%', height: 54, borderRadius: 16, border: 'none', background: '#ff2d2d', color: '#fff', fontWeight: 800, fontSize: 15, cursor: 'pointer' }}
              >
                Cancel Request
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── Call options sheet ── */}
      {showCallSheet && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)' }} onClick={() => setShowCallSheet(false)} />
          <div style={{
            position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 90,
            maxWidth: 480, margin: '0 auto',
            borderRadius: '24px 24px 0 0',
            background: 'var(--overlay-bg)',
            boxShadow: '0 -12px 60px rgba(0,0,0,0.6)',
            padding: '20px 20px',
            paddingBottom: 'max(calc(env(safe-area-inset-bottom, 0px) + 20px), 28px)',
            animation: 'cancel-slide-up 0.28s cubic-bezier(0.34,1.56,0.64,1)',
          }}>
            <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border-4)', margin: '0 auto 22px' }} />
            <p style={{ fontSize: 17, fontWeight: 800, color: 'var(--text-hi)', marginBottom: 4 }}>
              Contact {request?.mechanic_name?.split(' ')[0] ?? 'Mechanic'}
            </p>
            <p style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 20 }}>
              {mechanicPhone ?? 'Phone not available'}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <a
                href={mechanicPhone ? `tel:${mechanicPhone}` : undefined}
                onClick={() => setShowCallSheet(false)}
                style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderRadius: 14, background: 'var(--surface-2)', border: '1.5px solid rgba(245,158,11,0.4)', textDecoration: 'none', opacity: mechanicPhone ? 1 : 0.5, pointerEvents: mechanicPhone ? 'auto' : 'none' }}
              >
                <div style={{ width: 46, height: 46, borderRadius: 13, background: 'rgba(245,158,11,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Phone style={{ width: 20, height: 20, color: '#F59E0B' }} />
                </div>
                <div>
                  <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-hi)' }}>Phone Call</p>
                  <p style={{ fontSize: 12, color: 'var(--text-faint)' }}>Dial via your phone's dialer</p>
                </div>
              </a>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderRadius: 14, background: 'var(--surface-2)', border: '1.5px solid rgba(59,130,246,0.25)', opacity: 0.55 }}>
                <div style={{ width: 46, height: 46, borderRadius: 13, background: 'rgba(59,130,246,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Smartphone style={{ width: 20, height: 20, color: '#3B82F6' }} />
                </div>
                <div style={{ flex: 1 }}>
                  <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-hi)' }}>In-App Voice Call</p>
                  <p style={{ fontSize: 12, color: 'var(--text-faint)' }}>VoIP calling — coming soon</p>
                </div>
                <div style={{ background: 'var(--surface-3)', borderRadius: 8, padding: '3px 9px', flexShrink: 0 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-faint)', letterSpacing: '0.05em' }}>SOON</span>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── Final-bill pay sheet (MoMo / Cash — simulated) ── */}
      {showFeePaySheet && request?.actual_fee != null && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)' }} onClick={() => setShowFeePaySheet(false)} />
          <div style={{
            position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 90, maxWidth: 480, margin: '0 auto',
            borderRadius: '24px 24px 0 0', background: 'var(--overlay-bg)', boxShadow: '0 -12px 60px rgba(0,0,0,0.6)',
            padding: '20px 20px', paddingBottom: 'max(calc(env(safe-area-inset-bottom, 0px) + 20px), 28px)',
            animation: 'cancel-slide-up 0.28s cubic-bezier(0.34,1.56,0.64,1)',
          }}>
            <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border-4)', margin: '0 auto 18px' }} />
            <p style={{ fontSize: 13, color: 'var(--text-faint)', marginBottom: 2 }}>Total to pay</p>
            <p style={{ fontSize: 30, fontWeight: 900, color: '#F59E0B', letterSpacing: '-0.02em', marginBottom: 18 }}>UGX {(Number(request.actual_fee) || 0).toLocaleString()}</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button onClick={() => markFeePaid('momo')} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderRadius: 14, background: 'var(--surface-2)', border: '1.5px solid rgba(245,158,11,0.4)', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
                <div style={{ width: 46, height: 46, borderRadius: 13, background: 'rgba(245,158,11,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Smartphone style={{ width: 20, height: 20, color: '#F59E0B' }} />
                </div>
                <div>
                  <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-hi)' }}>Mobile Money</p>
                  <p style={{ fontSize: 12, color: 'var(--text-faint)' }}>Pay via MTN / Airtel MoMo</p>
                </div>
              </button>
              <button onClick={() => markFeePaid('cash')} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderRadius: 14, background: 'var(--surface-2)', border: '1.5px solid rgba(34,197,94,0.35)', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
                <div style={{ width: 46, height: 46, borderRadius: 13, background: 'rgba(34,197,94,0.14)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <DollarSign style={{ width: 20, height: 20, color: '#22C55E' }} />
                </div>
                <div>
                  <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-hi)' }}>Cash</p>
                  <p style={{ fontSize: 12, color: 'var(--text-faint)' }}>Pay the mechanic directly</p>
                </div>
              </button>
            </div>
            <p style={{ fontSize: 11, color: 'var(--text-faint)', textAlign: 'center', marginTop: 14, lineHeight: 1.5 }}>
              Demo: the payment is recorded — no real charge is made.
            </p>
          </div>
        </>
      )}

      {/* ── Mechanic Assigned Card ── */}
      {showMechanicCard && mechanicProfile && (
        <MechanicAssignedCard
          profile={mechanicProfile}
          mechanicPhone={mechanicPhone}
          requestId={id ?? ''}
          onDismiss={() => { setShowMechanicCard(false); setMechanicCardDismissed(true); }}
          onCall={() => { setShowMechanicCard(false); setMechanicCardDismissed(true); handleCall(); }}
          onMessage={() => { setShowMechanicCard(false); setChatUnread(0); navigate(`/requests/${request?.id}/chat`); }}
          unreadCount={chatUnread}
        />
      )}

      {/* ── Draggable floating mechanic bubble (after dismiss) ── */}
      {mechanicCardDismissed && mechanicProfile && (
        <div
          onPointerDown={e => {
            e.currentTarget.setPointerCapture(e.pointerId);
            bubbleDragStartRef.current = { px: e.clientX, py: e.clientY, bx: bubblePos.x, by: bubblePos.y };
            bubbleHasDraggedRef.current = false;
          }}
          onPointerMove={e => {
            if (!bubbleDragStartRef.current) return;
            const dx = e.clientX - bubbleDragStartRef.current.px;
            const dy = e.clientY - bubbleDragStartRef.current.py;
            if (Math.abs(dx) > 5 || Math.abs(dy) > 5) bubbleHasDraggedRef.current = true;
            setBubblePos({
              x: Math.max(4, Math.min(window.innerWidth  - 60, bubbleDragStartRef.current.bx + dx)),
              y: Math.max(4, Math.min(window.innerHeight - 60, bubbleDragStartRef.current.by + dy)),
            });
          }}
          onPointerUp={() => {
            if (!bubbleHasDraggedRef.current) {
              setMechanicCardDismissed(false);
              setShowMechanicCard(true);
            }
            bubbleDragStartRef.current = null;
          }}
          style={{
            position: 'fixed', zIndex: 900,
            left: bubblePos.x, top: bubblePos.y,
            width: 56, height: 56, borderRadius: '50%',
            background: 'linear-gradient(135deg, #F59E0B, #D97706)',
            boxShadow: '0 4px 20px rgba(245,158,11,0.50), 0 0 0 3px rgba(245,158,11,0.18)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'grab', touchAction: 'none', userSelect: 'none',
            fontSize: 16, fontWeight: 900, color: '#000',
            border: '2px solid rgba(245,158,11,0.7)',
          }}
        >
          {mechanicProfile.full_name.split(' ').map((p: string) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()}
          {/* Unread-message badge — clears once the chat is opened & viewed */}
          {chatUnread > 0 && (
            <div style={{
              position: 'absolute', top: -4, right: -4,
              minWidth: 20, height: 20, padding: '0 5px', borderRadius: 10,
              background: '#EF4444', color: '#fff', fontSize: 11, fontWeight: 900,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: '2px solid var(--page-bg)', boxShadow: '0 2px 8px rgba(239,68,68,0.5)',
            }}>
              {chatUnread > 9 ? '9+' : chatUnread}
            </div>
          )}
        </div>
      )}

      {/* ── Cancel reason modal ── */}
      {cancelPhase === 'reason' && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)' }}
            onClick={() => setCancelPhase(null)}
          />
          <div style={{
            position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 90,
            maxWidth: 480, margin: '0 auto',
            borderRadius: '24px 24px 0 0',
            background: 'var(--overlay-bg)',
            border: '1px solid rgba(239,68,68,0.2)',
            boxShadow: '0 -12px 60px rgba(0,0,0,0.7)',
            padding: '28px 24px',
            paddingBottom: 'max(calc(env(safe-area-inset-bottom, 0px) + 24px), 32px)',
            animation: 'cancel-slide-up 0.34s cubic-bezier(0.34,1.56,0.64,1)',
            maxHeight: '80vh', overflowY: 'auto',
          }}>
            <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border-4)', margin: '0 auto 24px' }} />
            <h2 style={{ color: 'var(--text-hi)', fontWeight: 900, fontSize: 18, marginBottom: 6 }}>
              Why are you cancelling?
            </h2>
            <p style={{ color: 'var(--text-lo)', fontSize: 12, marginBottom: 20, lineHeight: 1.5 }}>
              Your feedback helps us improve the service.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
              {CANCEL_REASONS.map(reason => (
                <button
                  key={reason}
                  onClick={() => setCancelReason(reason)}
                  style={{
                    width: '100%', padding: '13px 16px', borderRadius: 14, cursor: 'pointer',
                    textAlign: 'left', fontWeight: 600, fontSize: 14,
                    background: cancelReason === reason ? 'rgba(239,68,68,0.12)' : 'var(--surface-2)',
                    border: `1.5px solid ${cancelReason === reason ? 'rgba(239,68,68,0.4)' : 'var(--border-2)'}`,
                    color: cancelReason === reason ? '#f87171' : 'var(--text-md)',
                    transition: 'all 0.15s ease',
                  }}
                >
                  {reason}
                </button>
              ))}
            </div>
            {cancelReason === 'Other' && (
              <textarea
                value={cancelOther}
                onChange={e => setCancelOther(e.target.value)}
                placeholder="Please describe your reason…"
                rows={3}
                style={{
                  width: '100%', borderRadius: 12, padding: '12px 14px', marginBottom: 16,
                  background: 'var(--surface-2)', border: '1.5px solid var(--border-3)',
                  color: 'var(--text-hi)', fontSize: 13, resize: 'none', outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            )}
            <button
              onClick={handleCancelConfirm}
              disabled={isCancelling || !cancelReason || (cancelReason === 'Other' && !cancelOther.trim())}
              style={{
                width: '100%', height: 54, borderRadius: 16, border: 'none',
                background: isCancelling || !cancelReason ? 'rgba(239,68,68,0.4)' : '#dc2626',
                color: '#fff', fontWeight: 800, fontSize: 15,
                cursor: isCancelling || !cancelReason ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              }}
            >
              {isCancelling && <Loader2 style={{ width: 18, height: 18, animation: 'spin 1s linear infinite' }} />}
              {isCancelling ? 'Cancelling…' : 'Confirm Cancellation'}
            </button>
          </div>
        </>
      )}

      {/* ── Persistent "Have you seen your mechanic?" popup — shows on arrival ── */}
      {request.status === 'arrived' && createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 4000, background: 'rgba(0,0,0,0.66)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ width: '100%', maxWidth: 380, borderRadius: 24, background: 'var(--page-bg)', border: '1px solid var(--border-3)', padding: '28px 22px', boxShadow: '0 24px 80px rgba(0,0,0,0.6)', animation: 'slide-up 0.35s cubic-bezier(0.22,0.68,0,1.2) both' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
              <div style={{ width: 72, height: 72, borderRadius: '50%', background: 'rgba(139,92,246,0.15)', border: '2px solid rgba(139,92,246,0.40)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ width: 48, height: 48, borderRadius: '50%', background: '#8B5CF6', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 14px rgba(139,92,246,0.45)' }}>
                  <MapPin style={{ width: 24, height: 24, color: '#fff' }} />
                </div>
              </div>
            </div>
            <h2 style={{ fontSize: 20, fontWeight: 900, color: 'var(--text-hi)', textAlign: 'center', marginBottom: 8 }}>
              Has your mechanic arrived?
            </h2>
            <p style={{ fontSize: 14, color: 'var(--text-lo)', textAlign: 'center', lineHeight: 1.6, marginBottom: 24 }}>
              {(request as any).mechanic_name ?? 'Your mechanic'} says they're at your location. Can you see them?
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button
                onClick={handleSeeMechanic}
                disabled={confirmingSeen}
                style={{
                  width: '100%', height: 54, borderRadius: 16, border: 'none',
                  background: confirmingSeen ? 'rgba(34,197,94,0.4)' : 'linear-gradient(135deg, #22C55E, #16A34A)',
                  color: confirmingSeen ? '#fff' : '#000', fontWeight: 800, fontSize: 16,
                  cursor: confirmingSeen ? 'not-allowed' : 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  boxShadow: confirmingSeen ? 'none' : '0 4px 18px rgba(34,197,94,0.35)',
                }}
              >
                {confirmingSeen
                  ? <><Loader2 style={{ width: 18, height: 18, animation: 'spin 1s linear infinite' }} /> Confirming…</>
                  : <><CheckCircle2 style={{ width: 18, height: 18 }} /> Yes, I have</>}
              </button>
              <button
                onClick={handleNotYet}
                disabled={confirmingSeen}
                style={{
                  width: '100%', height: 50, borderRadius: 14,
                  border: '1.5px solid var(--border-3)', background: 'transparent',
                  color: 'var(--text-md)', fontWeight: 700, fontSize: 14, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                }}
              >
                <MessageCircle style={{ width: 16, height: 16 }} /> No, not yet — message them
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
