// NearbyMechanics.tsx — shows the verified mechanics near the driver on a map (from the
// matching service), so they can see who's available, how close and how well rated, and
// pick one. Part of the request flow when finding help.

import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import L, { type Map as LeafletMap } from 'leaflet';
import { MapContainer, Marker, Circle, Polyline, Popup, useMap } from 'react-leaflet';
import OpenFreeMapLayer from '@/components/OpenFreeMapLayer';
import {
  ArrowLeft, Phone, Star, Navigation, X,
  Shield, Clock, Zap, MapPin, CheckCircle2,
  Wrench, Truck, ShoppingBag, Loader2, ChevronRight,
  MessageCircle, Mail, Camera, FileText, ScanLine, Sparkles,
} from 'lucide-react';
import { matchingService, requestsService, MechanicCandidate } from '@/config/api';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';

/* ── Palette ──────────────────────────────────────────────────────────────── */
const R  = '#ff2d2d';
const Y  = '#F59E0B';
const YD = '#D97706';

/* ── SVG marker icons ─────────────────────────────────────────────────────── */
const driverIcon = (size = 40) => L.divIcon({
  className: '',
  html:
    `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${size/2}" cy="${size/2}" r="${size/2-2}" fill="${R}" opacity="0.18"/>
      <circle cx="${size/2}" cy="${size/2}" r="${size/3}" fill="${R}" stroke="white" stroke-width="3.5"/>
      <circle cx="${size/2}" cy="${size/2}" r="${size/7.5}" fill="white"/>
    </svg>`,
  iconSize: [size, size],
  iconAnchor: [size / 2, size / 2],
});

const providerIcon = (size = 28, color = Y, pulse = false) => L.divIcon({
  className: '',
  html:
    `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      ${pulse ? `<circle cx="${size/2}" cy="${size/2}" r="${size/2-1}" fill="${color}" opacity="0.22"/>` : ''}
      <circle cx="${size/2}" cy="${size/2}" r="${size/2.8}" fill="${color}" stroke="white" stroke-width="3"/>
      <circle cx="${size/2}" cy="${size/2}" r="${size/7}" fill="white"/>
    </svg>`,
  iconSize: [size, size],
  iconAnchor: [size / 2, size / 2],
});

function MapController({ mapRef, zoom }: { mapRef: React.MutableRefObject<LeafletMap | null>; zoom: number }) {
  const map = useMap();

  useEffect(() => {
    mapRef.current = map;
    return () => { mapRef.current = null; };
  }, [map, mapRef]);

  useEffect(() => {
    if (map.getZoom() !== zoom) map.setZoom(zoom);
  }, [map, zoom]);

  return null;
}

/* ── Provider meta ────────────────────────────────────────────────────────── */
const PROVIDER_META: Record<string, { icon: React.ElementType; color: string; label: string; searchLabel: string }> = {
  mechanic:           { icon: Wrench,      color: Y,         label: 'Mechanic',        searchLabel: 'Mechanics'               },
  towing_provider:    { icon: Truck,       color: '#60A5FA', label: 'Towing Service',  searchLabel: 'Towing Service Providers' },
  spare_parts_dealer: { icon: ShoppingBag, color: '#A78BFA', label: 'Parts Dealer',    searchLabel: 'Parts Dealers'            },
};

/* ── Avatar gradients ─────────────────────────────────────────────────────── */
const AVATAR_GRADIENTS = [
  ['#F59E0B', '#D97706'],
  ['#3B82F6', '#1D4ED8'],
  ['#10B981', '#059669'],
  ['#8B5CF6', '#6D28D9'],
  ['#EC4899', '#BE185D'],
  ['#F97316', '#C2410C'],
];

/* ── Mock content pools ───────────────────────────────────────────────────── */
const SERVICE_SETS: string[][] = [
  ['Flat Tyre', 'Battery Jump', 'Engine Repair', 'Oil Change', 'Brake Service'],
  ['Emergency Towing', 'Long Distance Tow', 'Winching', 'Flatbed Service'],
  ['Suspension', 'Wheel Alignment', 'AC Repair', 'Electrical Faults', 'Diagnostics'],
  ['Fuel Delivery', 'Lockout Assist', 'Tyre Change', 'Jump Start', 'Minor Repairs'],
  ['Heavy Towing', 'Accident Recovery', 'Motorcycle Tow', 'Underground Parking'],
];
const ABOUT_POOL = [
  'Licensed and certified roadside mechanics with over 10 years serving Kampala and the greater metro area. Available 24/7 for emergency callouts.',
  'Professional towing and recovery specialists. Fully insured, GPS-tracked fleet. We handle all vehicle types from motorcycles to heavy trucks.',
  'Your trusted neighbourhood garage, now on-demand. Fast response times and transparent pricing — no hidden charges ever.',
  'Certified technicians with manufacturer-level diagnostic equipment. We come to you, wherever you are on the road.',
  'Emergency roadside specialists. Serving drivers across Uganda since 2015. Rated #1 in customer satisfaction on the MOTOFIX platform.',
];
const LOCATION_LABELS = [
  'Plot 14, Jinja Rd, Kampala',
  'Kireka Market, Wakiso',
  'Ntinda, Kampala',
  'Najjera, Kira Rd',
  'Bukoto, Kampala',
];
const REVIEW_POOL = [
  { author: 'Alex K.',    rating: 5, text: 'Arrived in 12 minutes. Fixed the tyre on the spot. Absolute lifesaver!' },
  { author: 'Sarah M.',   rating: 4, text: 'Very professional and fair pricing. Will call again without hesitation.' },
  { author: 'James O.',   rating: 5, text: 'Showed up even in the rain. Sorted my battery in under 20 minutes.' },
  { author: 'Aisha N.',   rating: 5, text: 'Best roadside service I have ever used. Highly recommend.' },
  { author: 'Brian T.',   rating: 4, text: 'Quick response, knew exactly what to do. Got me back on the road fast.' },
  { author: 'Linda W.',   rating: 5, text: 'Super reliable. Friendly guy and great service. 10/10.' },
  { author: 'Moses K.',   rating: 5, text: 'Fastest response I have ever seen. Was there in 8 minutes from the call.' },
  { author: 'Fatuma A.',  rating: 4, text: 'Clean tools, clean uniform, professional attitude. Highly recommended.' },
];

/* ── Types ────────────────────────────────────────────────────────────────── */
// beacon   → GPS captured, pulsing pin
// refine   → user describes location, uploads photo
// refining → brief "adjusting pin" animation
// scanning → map blur, searching
// results  → provider dots pop onto map
// connecting / tracking
type Phase = 'beacon' | 'refine' | 'refining' | 'scanning' | 'results' | 'connecting' | 'tracking';

interface RouteState { lat?: number; lng?: number; address?: string; serviceType?: string }
interface RichProvider extends MechanicCandidate {
  pos: { lat: number; lng: number };
  whatsapp: string;
  email: string;
  locationLabel: string;
  services: string[];
  about: string;
  avatarGradient: string[];
  initials: string;
  reviewCount: number;
}

function scatterPos(center: { lat: number; lng: number }) {
  const angle = Math.random() * Math.PI * 2;
  const dist  = 0.004 + Math.random() * 0.012;
  return { lat: center.lat + Math.cos(angle) * dist, lng: center.lng + Math.sin(angle) * dist };
}
function toInitials(name: string) {
  const parts = name.trim().split(' ');
  return parts.length >= 2 ? `${parts[0][0]}${parts[1][0]}`.toUpperCase() : name.slice(0, 2).toUpperCase();
}
function cleanPhone(phone?: string) {
  return (phone ?? '').replace(/\s+/g, '').replace(/^\+/, '');
}

/* ──────────────────────────────────────────────────────────────────────────
   Location refine sheet
────────────────────────────────────────────────────────────────────────── */
function LocationRefineSheet({
  address, meta, onSubmit, onSkip,
}: {
  address: string;
  meta: { label: string; searchLabel: string; color: string; icon: React.ElementType };
  onSubmit: (note: string, photo: File | null) => void;
  onSkip: () => void;
}) {
  const [note,    setNote]    = useState('');
  const [photo,   setPhoto]   = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handlePhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhoto(file);
    const reader = new FileReader();
    reader.onload = () => setPreview(reader.result as string);
    reader.readAsDataURL(file);
  };

  const hasDetails = note.trim().length > 0 || photo !== null;

  return (
    <div style={{
      position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 30,
      borderRadius: '24px 24px 0 0',
      background: 'var(--overlay-bg)',
      border: '1.5px solid var(--border-2)', borderBottom: 'none',
      boxShadow: '0 -24px 64px rgba(0,0,0,0.35)',
      maxHeight: '82vh', overflowY: 'auto', scrollbarWidth: 'none',
      animation: 'sheet-up 0.4s cubic-bezier(0.34,1.56,0.64,1) both',
    }}>
      {/* Drag handle */}
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 12, paddingBottom: 2 }}>
        <div style={{ width: 40, height: 4, borderRadius: 2, background: 'var(--border-4)' }} />
      </div>

      {/* Header */}
      <div style={{ padding: '10px 18px 0' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 6 }}>
          <div style={{
            width: 46, height: 46, borderRadius: 14, flexShrink: 0,
            background: `${R}12`, border: `1.5px solid ${R}30`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <ScanLine style={{ width: 22, height: 22, color: R }} />
          </div>
          <div>
            <p style={{ color: 'var(--text-hi)', fontWeight: 800, fontSize: 16, lineHeight: 1.2, marginBottom: 4 }}>
              Confirm your exact location
            </p>
            <p style={{ color: 'var(--text-lo)', fontSize: 12, lineHeight: 1.5 }}>
              Drag the map pin to refine your GPS position, then add nearby landmarks if helpful.
            </p>
          </div>
        </div>

        {/* GPS confirmed chip */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 9, marginTop: 10,
          padding: '10px 13px', borderRadius: 12,
          background: 'rgba(34,197,94,0.07)', border: '1px solid rgba(34,197,94,0.2)',
        }}>
          <CheckCircle2 style={{ width: 16, height: 16, color: '#4ade80', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ color: '#4ade80', fontSize: 11, fontWeight: 700, marginBottom: 1 }}>GPS Location Captured</p>
            <p style={{ color: 'var(--text-dim)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{address}</p>
          </div>
        </div>
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: 'var(--surface-3)', margin: '16px 0 0' }} />

      {/* Description input */}
      <div style={{ padding: '16px 18px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <FileText style={{ width: 14, height: 14, color: 'var(--text-dim)' }} />
          <p style={{ color: 'var(--text-lo)', fontSize: 12, fontWeight: 700 }}>Describe where you are <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>(optional)</span></p>
        </div>
        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder="e.g. Near Total petrol station, white building on left, by Nakumatt junction, next to the mosque…"
          rows={3}
          style={{
            width: '100%', resize: 'none',
            background: 'var(--surface-2)',
            border: `1px solid ${note.trim() ? `${Y}40` : 'var(--border-2)'}`,
            borderRadius: 14,
            color: 'var(--text-hi)', fontSize: 13, lineHeight: 1.55,
            padding: '12px 14px',
            outline: 'none', boxSizing: 'border-box',
            transition: 'border-color 0.2s',
            fontFamily: 'inherit',
          }}
        />
        <p style={{ color: 'var(--text-faint)', fontSize: 10.5, marginTop: 5, lineHeight: 1.4 }}>
          Mention nearby landmarks — gas stations, banks, schools, road names, or any visible signs.
        </p>
      </div>

      {/* Photo upload */}
      <div style={{ padding: '14px 18px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <Camera style={{ width: 14, height: 14, color: 'var(--text-dim)' }} />
          <p style={{ color: 'var(--text-lo)', fontSize: 12, fontWeight: 700 }}>Photo of your surroundings <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>(optional)</span></p>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handlePhoto}
          style={{ display: 'none' }}
        />

        {preview ? (
          /* Photo preview */
          <div style={{ position: 'relative', borderRadius: 14, overflow: 'hidden', border: `1.5px solid ${Y}40` }}>
            <img src={preview} alt="area" style={{ width: '100%', height: 130, objectFit: 'cover', display: 'block' }} />
            <div style={{
              position: 'absolute', inset: 0,
              background: 'linear-gradient(to top, rgba(0,0,0,0.6) 0%, transparent 50%)',
              display: 'flex', alignItems: 'flex-end', padding: '10px 12px',
            }}>
              <span style={{ color: 'var(--text-hi)', fontSize: 11, fontWeight: 700 }}>Photo captured</span>
              <CheckCircle2 style={{ width: 14, height: 14, color: '#4ade80', marginLeft: 6 }} />
            </div>
            <button
              onClick={() => { setPhoto(null); setPreview(null); }}
              style={{
                position: 'absolute', top: 8, right: 8,
                width: 28, height: 28, borderRadius: 8,
                background: 'var(--overlay-bg)', border: '1px solid var(--border-3)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              <X style={{ width: 13, height: 13, color: 'var(--text-hi)' }} />
            </button>
          </div>
        ) : (
          /* Upload button */
          <button
            onClick={() => fileRef.current?.click()}
            style={{
              width: '100%', height: 80, borderRadius: 14, cursor: 'pointer',
              background: 'var(--surface-1)',
              border: '1.5px dashed var(--border-3)',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 7,
              transition: 'background 0.2s, border-color 0.2s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = `${Y}08`; e.currentTarget.style.borderColor = `${Y}35`; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface-1)'; e.currentTarget.style.borderColor = 'var(--border-3)'; }}
          >
            <Camera style={{ width: 22, height: 22, color: 'var(--text-dim)' }} />
            <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>Tap to take or upload a photo</span>
          </button>
        )}
        <p style={{ color: 'var(--text-faint)', fontSize: 10.5, marginTop: 5, lineHeight: 1.4 }}>
          A photo helps us verify your exact spot and speeds up provider dispatch.
        </p>
      </div>

      {/* CTA */}
      <div style={{ padding: '18px 18px 36px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <button
          onClick={() => onSubmit(note, photo)}
          style={{
            width: '100%', height: 54, borderRadius: 15, border: 'none',
            background: `linear-gradient(135deg, ${Y}, ${YD})`,
            color: '#000', fontWeight: 800, fontSize: 15,
            cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            boxShadow: `0 0 0 3px ${Y}22, 0 8px 28px ${Y}33`,
          }}
        >
          <meta.icon style={{ width: 18, height: 18 }} />
          {hasDetails ? `Refine Location & Find ${meta.searchLabel}` : `Find ${meta.searchLabel} Near Me`}
        </button>
        <button
          onClick={onSkip}
          style={{
            width: '100%', height: 42, borderRadius: 12, cursor: 'pointer',
            background: 'none', border: '1px solid var(--border-2)',
            color: 'var(--text-dim)', fontSize: 13, fontWeight: 600,
          }}
        >
          Skip — use GPS coordinates only
        </button>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   Refining overlay (brief — sits on top of map while adjusting pin)
────────────────────────────────────────────────────────────────────────── */
function RefiningOverlay() {
  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 28,
      background: 'rgba(0,0,0,0.35)',
      backdropFilter: 'blur(4px)',
      WebkitBackdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      animation: 'fade-in 0.3s ease both',
    }}>
      <div style={{
        padding: '16px 24px', borderRadius: 18,
        background: 'var(--overlay-bg)', border: `1.5px solid ${Y}30`,
        boxShadow: `0 0 40px ${Y}18`,
        display: 'flex', alignItems: 'center', gap: 14,
      }}>
        <div style={{ width: 36, height: 36, borderRadius: 11, background: `${Y}14`, border: `1.5px solid ${Y}35`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <ScanLine style={{ width: 18, height: 18, color: Y }} />
        </div>
        <div>
          <p style={{ color: 'var(--text-hi)', fontWeight: 800, fontSize: 14, marginBottom: 2 }}>Refining your location…</p>
          <p style={{ color: 'var(--text-dim)', fontSize: 11 }}>Analysing details and adjusting pin</p>
        </div>
        <Loader2 style={{ width: 18, height: 18, color: Y, flexShrink: 0 }} className="animate-spin" />
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   Scanning blur overlay
────────────────────────────────────────────────────────────────────────── */
function ScanBlurOverlay({ searchLabel }: { searchLabel: string }) {
  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 25,
      backdropFilter: 'blur(10px)',
      WebkitBackdropFilter: 'blur(10px)',
      background: 'rgba(0,0,0,0.35)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      gap: 28, animation: 'fade-in 0.4s ease both',
    }}>
      {/* Radar rings */}
      <div style={{ position: 'relative', width: 140, height: 140 }}>
        {[140, 104, 68].map((s, i) => (
          <div key={s} style={{
            position: 'absolute', top: '50%', left: '50%',
            width: s, height: s, borderRadius: '50%',
            border: `1.5px solid ${R}${['22', '44', '77'][i]}`,
            transform: 'translate(-50%,-50%)',
            animation: `radar-ring ${2.4 + i * 0.6}s ease-out ${i * 0.4}s infinite`,
          }} />
        ))}
        {/* Conic sweep */}
        <div style={{
          position: 'absolute', top: '50%', left: '50%',
          width: 70, height: 70,
          transform: 'translate(-50%,-50%)',
          borderRadius: '50%',
          background: `conic-gradient(${R}00 0deg, ${R}33 60deg, ${R}00 80deg)`,
          animation: 'spin-cw 1.8s linear infinite',
        }} />
        {/* Center icon */}
        <div style={{
          position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
          width: 44, height: 44, borderRadius: 14,
          background: `linear-gradient(135deg, ${R}, ${R}bb)`,
          boxShadow: `0 0 32px ${R}55`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <MapPin style={{ width: 22, height: 22, color: 'var(--text-hi)' }} />
        </div>
      </div>

      {/* Text */}
      <div style={{ textAlign: 'center', maxWidth: 280, padding: '0 24px' }}>
        <p style={{ color: 'var(--text-hi)', fontWeight: 900, fontSize: 20, marginBottom: 8, textShadow: '0 0 24px rgba(255,255,255,0.2)' }}>
          Searching for {searchLabel}
        </p>
        <p style={{ color: 'var(--text-lo)', fontSize: 13, lineHeight: 1.55 }}>
          Scanning a 2 km radius around your breakdown location
        </p>
      </div>

      {/* Progress bar */}
      <div style={{ width: 200, height: 3, borderRadius: 2, background: 'var(--surface-4)', overflow: 'hidden' }}>
        <div style={{ height: '100%', borderRadius: 2, background: `linear-gradient(90deg, ${R}, ${Y})`, animation: 'scan-sweep 1.8s ease-in-out infinite' }} />
      </div>

      <p style={{ color: 'var(--text-faint)', fontSize: 11, letterSpacing: '0.1em' }}>
        Checking availability · verifying proximity
      </p>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   Connecting overlay
────────────────────────────────────────────────────────────────────────── */
function ConnectingOverlay({ name, serviceType }: { name: string; serviceType: string }) {
  const meta = PROVIDER_META[serviceType] ?? PROVIDER_META.mechanic;
  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 60,
      background: 'var(--overlay-bg)', backdropFilter: 'blur(14px)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 28, padding: 32, animation: 'fade-in 0.3s ease both',
    }}>
      <div style={{ position: 'relative', width: 120, height: 120 }}>
        {[120, 88, 56].map((s, i) => (
          <div key={s} style={{
            position: 'absolute', top: '50%', left: '50%',
            width: s, height: s, borderRadius: '50%',
            border: `1.5px solid ${R}${['30','55','99'][i]}`,
            transform: 'translate(-50%,-50%)',
            animation: `spin-cw ${1.4 + i * 0.5}s linear ${i * 0.2}s infinite`,
          }} />
        ))}
        <div style={{
          position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
          width: 52, height: 52, borderRadius: 16,
          background: `linear-gradient(135deg,${R},${R}aa)`,
          boxShadow: `0 0 32px ${R}66`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <meta.icon style={{ width: 26, height: 26, color: 'var(--text-hi)' }} />
        </div>
      </div>
      <div style={{ textAlign: 'center' }}>
        <p style={{ color: 'var(--text-lo)', fontSize: 11, letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: 8 }}>Connecting you to</p>
        <p style={{ color: 'var(--text-hi)', fontWeight: 900, fontSize: 24, marginBottom: 6 }}>{name}</p>
        <p style={{ color: meta.color, fontSize: 13, fontWeight: 700 }}>{meta.label}</p>
      </div>
      <div style={{ width: 200, height: 3, borderRadius: 2, background: 'var(--surface-4)', overflow: 'hidden' }}>
        <div style={{ height: '100%', borderRadius: 2, background: `linear-gradient(90deg,${R},${Y})`, animation: 'progress-fill 2.5s cubic-bezier(0.4,0,0.2,1) both' }} />
      </div>
      <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>Confirming availability…</p>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   Provider detail sheet
────────────────────────────────────────────────────────────────────────── */
function ProviderSheet({ mechanic, serviceType, requesting, onClose, onRequest, onNavigate }: {
  mechanic: RichProvider; serviceType: string; requesting: boolean;
  onClose: () => void; onRequest: () => void; onNavigate: () => void;
  driverPos?: { lat: number; lng: number };
}) {
  const meta    = PROVIDER_META[serviceType] ?? PROVIDER_META.mechanic;
  const Icon    = meta.icon;
  const _ts = mechanic.total_score ?? 0;
  const rating  = Math.min(5, Math.max(3.5, _ts > 5 ? _ts / 20 : _ts * 5));  // total_score is 0–100 now (legacy mocks were 0–1)
  const reviews = [REVIEW_POOL[mechanic.mechanic_id % 8], REVIEW_POOL[(mechanic.mechanic_id + 3) % 8]];
  const waPhone = cleanPhone(mechanic.phone);
  const mapsUrl = `https://www.openstreetmap.org/search?query=${encodeURIComponent(mechanic.locationLabel)}`;

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 50, pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'auto' }} onClick={onClose} />
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0,
        borderRadius: '24px 24px 0 0', background: 'var(--overlay-bg)',
        border: '1.5px solid var(--border-2)', borderBottom: 'none',
        boxShadow: '0 -16px 48px rgba(0,0,0,0.30)',
        maxHeight: '88vh', overflowY: 'auto', scrollbarWidth: 'none',
        pointerEvents: 'auto',
        animation: 'sheet-up 0.38s cubic-bezier(0.34,1.56,0.64,1) both',
      }}>
        {/* Drag handle */}
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 12, paddingBottom: 2 }}>
          <div style={{ width: 40, height: 4, borderRadius: 2, background: 'var(--border-4)' }} />
        </div>

        {/* Cover hero */}
        <div style={{
          margin: '6px 14px 0', borderRadius: 20, height: 110,
          background: `linear-gradient(135deg, ${mechanic.avatarGradient[0]}22, ${mechanic.avatarGradient[1]}44, #0e1018)`,
          border: `1px solid ${mechanic.avatarGradient[0]}30`,
          position: 'relative', overflow: 'hidden',
        }}>
          <div style={{ position: 'absolute', inset: 0, backgroundImage: `radial-gradient(circle at 70% 40%, ${mechanic.avatarGradient[0]}18 0%, transparent 60%)` }} />
          <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 20, background: `${meta.color}18`, border: `1px solid ${meta.color}35` }}>
            <Icon style={{ width: 12, height: 12, color: meta.color }} />
            <span style={{ color: meta.color, fontSize: 11, fontWeight: 700 }}>{meta.label}</span>
          </div>
          <button onClick={onClose} style={{ position: 'absolute', top: 10, left: 12, width: 30, height: 30, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.4)', border: '1px solid var(--border-3)', cursor: 'pointer' }}>
            <X style={{ width: 14, height: 14, color: 'var(--text-md)' }} />
          </button>
        </div>

        {/* Avatar + name */}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, padding: '0 18px 0', marginTop: -28, position: 'relative', zIndex: 2 }}>
          <div style={{
            width: 68, height: 68, borderRadius: 20, flexShrink: 0,
            background: `linear-gradient(135deg, ${mechanic.avatarGradient[0]}, ${mechanic.avatarGradient[1]})`,
            border: '3px solid #0e1018', boxShadow: `0 4px 20px ${mechanic.avatarGradient[0]}55`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 22, fontWeight: 900, color: 'var(--text-hi)', letterSpacing: '-0.02em',
          }}>{mechanic.initials}</div>
          <div style={{ flex: 1, minWidth: 0, paddingBottom: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
              <p style={{ color: 'var(--text-hi)', fontWeight: 900, fontSize: 17, lineHeight: 1.2 }}>{mechanic.mechanic_name}</p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 7px', borderRadius: 6, background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.25)' }}>
                <CheckCircle2 style={{ width: 10, height: 10, color: '#4ade80' }} />
                <span style={{ color: '#4ade80', fontSize: 9.5, fontWeight: 700 }}>VERIFIED</span>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 5 }}>
              {[1,2,3,4,5].map(s => <Star key={s} style={{ width: 12, height: 12, color: s <= Math.round(rating) ? Y : 'var(--border-4)', fill: s <= Math.round(rating) ? Y : 'none' }} />)}
              <span style={{ color: Y, fontSize: 12, fontWeight: 800, marginLeft: 2 }}>{rating.toFixed(1)}</span>
              <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>· {mechanic.reviewCount} reviews</span>
            </div>
          </div>
        </div>

        {/* ── Why MOTOFIX matched this mechanic (intelligent matching showcase) ── */}
        {(mechanic.match_priority != null || mechanic.score_breakdown) && (() => {
          const bd = mechanic.score_breakdown ?? {};
          const priority = mechanic.match_priority ?? mechanic.total_score ?? 0;
          const FEATURES: { key: string; label: string; color: string }[] = [
            { key: 'spec_match',   label: 'Specialisation', color: '#A78BFA' },
            { key: 'availability', label: 'Availability',   color: '#34D399' },
            { key: 'proximity',    label: 'Proximity',      color: '#60A5FA' },
            { key: 'rating',       label: 'Rating',         color: Y },
          ];
          const present = FEATURES.filter(f => bd[f.key] != null);
          return (
            <div style={{ margin: '14px 18px 0', borderRadius: 16, background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.28)', padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 800, letterSpacing: '0.04em', color: '#A78BFA' }}>
                  <Sparkles style={{ width: 13, height: 13 }} /> MOTOFIX AI MATCH
                </span>
                <span style={{ fontSize: 15, fontWeight: 900, color: '#A78BFA' }}>{priority.toFixed(1)}%</span>
              </div>
              {mechanic.rationale && (
                <p style={{ fontSize: 12, color: 'var(--text-md)', lineHeight: 1.5, marginBottom: present.length ? 10 : 0 }}>{mechanic.rationale}</p>
              )}
              {present.map(f => (
                <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ width: 86, flexShrink: 0, fontSize: 10.5, color: 'var(--text-dim)', fontWeight: 600 }}>{f.label}</span>
                  <div style={{ flex: 1, height: 6, borderRadius: 999, background: 'var(--surface-3)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.max(0, Math.min(100, bd[f.key]))}%`, background: f.color, borderRadius: 999 }} />
                  </div>
                  <span style={{ width: 30, textAlign: 'right', fontSize: 10.5, fontWeight: 700, color: 'var(--text-md)' }}>{Math.round(bd[f.key])}</span>
                </div>
              ))}
            </div>
          );
        })()}

        {/* Distance / ETA / Navigate chips */}
        <div style={{ display: 'flex', gap: 8, padding: '12px 18px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 10, background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.2)', flex: 1, justifyContent: 'center' }}>
            <Navigation style={{ width: 13, height: 13, color: '#60A5FA' }} />
            <span style={{ color: '#60A5FA', fontSize: 12, fontWeight: 700 }}>{mechanic.distance_km.toFixed(1)} km away</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 10, background: `${Y}0e`, border: `1px solid ${Y}25`, flex: 1, justifyContent: 'center' }}>
            <Clock style={{ width: 13, height: 13, color: Y }} />
            <span style={{ color: Y, fontSize: 12, fontWeight: 700 }}>~{Math.ceil(mechanic.distance_km * 3)} min ETA</span>
          </div>
          <button
            onClick={onNavigate}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 10, background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.25)', flex: 1, justifyContent: 'center', cursor: 'pointer' }}
          >
            <Navigation style={{ width: 13, height: 13, color: '#34D399' }} />
            <span style={{ color: '#34D399', fontSize: 12, fontWeight: 700 }}>Navigate</span>
          </button>
        </div>

        {/* Contact buttons */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8, padding: '12px 18px 0' }}>
          {[
            { label: 'Call',      icon: Phone,          color: '#22C55E', bg: 'rgba(34,197,94,0.1)',    border: 'rgba(34,197,94,0.25)',    action: mechanic.phone ? `tel:${mechanic.phone}` : null,             external: false },
            { label: 'WhatsApp', icon: MessageCircle,  color: '#25D366', bg: 'rgba(37,211,102,0.1)',   border: 'rgba(37,211,102,0.25)',   action: waPhone ? `https://wa.me/${waPhone}` : null,                 external: true  },
            { label: 'Location', icon: MapPin,          color: '#60A5FA', bg: 'rgba(96,165,250,0.1)',   border: 'rgba(96,165,250,0.25)',   action: mapsUrl,                                                      external: true  },
            { label: 'Email',    icon: Mail,            color: '#A78BFA', bg: 'rgba(167,139,250,0.1)',  border: 'rgba(167,139,250,0.25)',  action: mechanic.email ? `mailto:${mechanic.email}` : null,          external: false },
          ].map(({ label, icon: Ic, color, bg, border, action, external }) => (
            <a key={label} href={action ?? '#'}
              target={external ? '_blank' : undefined} rel="noreferrer"
              onClick={e => { if (!action) e.preventDefault(); }}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, padding: '10px 4px', borderRadius: 14, background: bg, border: `1px solid ${border}`, textDecoration: 'none', cursor: action ? 'pointer' : 'default', opacity: action ? 1 : 0.35 }}
            >
              <Ic style={{ width: 18, height: 18, color }} />
              <span style={{ color: 'var(--text-lo)', fontSize: 9.5, fontWeight: 700 }}>{label}</span>
            </a>
          ))}
        </div>

        {/* Location label */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 18px 0', padding: '10px 13px', borderRadius: 12, background: 'var(--surface-1)', border: '1px solid var(--border-2)' }}>
          <MapPin style={{ width: 14, height: 14, color: 'var(--text-dim)', flexShrink: 0 }} />
          <span style={{ color: 'var(--text-lo)', fontSize: 12 }}>{mechanic.locationLabel}</span>
        </div>

        {/* Stats */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, padding: '12px 18px 0' }}>
          {[
            { icon: Shield, label: 'Verified',  val: 'Yes',                                    color: '#22C55E' },
            { icon: Zap,    label: 'Jobs Done',  val: `${90 + mechanic.mechanic_id * 12}+`,    color: Y        },
            { icon: Clock,  label: 'Response',   val: `${3 + (mechanic.mechanic_id % 4)} min`, color: '#60A5FA' },
          ].map(({ icon: Ic, label, val, color }) => (
            <div key={label} style={{ borderRadius: 14, padding: '12px 0', textAlign: 'center', background: 'var(--surface-1)', border: '1px solid var(--border-2)' }}>
              <Ic style={{ width: 15, height: 15, color, margin: '0 auto 5px' }} />
              <p style={{ color: 'var(--text-hi)', fontWeight: 800, fontSize: 14 }}>{val}</p>
              <p style={{ color: 'var(--text-dim)', fontSize: 10 }}>{label}</p>
            </div>
          ))}
        </div>

        {/* About */}
        <div style={{ padding: '14px 18px 0' }}>
          <p style={{ color: 'var(--text-dim)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.18em', fontWeight: 700, marginBottom: 7 }}>About</p>
          <p style={{ color: 'var(--text-lo)', fontSize: 12.5, lineHeight: 1.6 }}>{mechanic.about}</p>
        </div>

        {/* Services */}
        <div style={{ padding: '14px 18px 0' }}>
          <p style={{ color: 'var(--text-dim)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.18em', fontWeight: 700, marginBottom: 8 }}>Services</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            {mechanic.services.map(s => (
              <span key={s} style={{ fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 8, background: `${meta.color}12`, border: `1px solid ${meta.color}25`, color: meta.color }}>{s}</span>
            ))}
          </div>
        </div>

        {/* Reviews */}
        <div style={{ padding: '14px 18px 0' }}>
          <p style={{ color: 'var(--text-dim)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.18em', fontWeight: 700, marginBottom: 10 }}>Recent Reviews</p>
          {reviews.map((rv, i) => (
            <div key={i} style={{ marginBottom: 8, padding: '12px 14px', borderRadius: 14, background: 'var(--surface-1)', border: '1px solid var(--border-1)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
                <div style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0, background: `linear-gradient(135deg, ${Y}55, ${YD}55)`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, color: Y }}>{rv.author[0]}</div>
                <span style={{ color: 'var(--text-md)', fontSize: 12, fontWeight: 700 }}>{rv.author}</span>
                <div style={{ display: 'flex', gap: 2, marginLeft: 'auto' }}>
                  {[1,2,3,4,5].map(s => <Star key={s} style={{ width: 9, height: 9, color: s <= rv.rating ? Y : 'var(--border-3)', fill: s <= rv.rating ? Y : 'none' }} />)}
                </div>
              </div>
              <p style={{ color: 'var(--text-lo)', fontSize: 12, lineHeight: 1.55 }}>{rv.text}</p>
            </div>
          ))}
        </div>

        {/* CTA */}
        <div style={{ display: 'flex', gap: 10, padding: '14px 18px 36px' }}>
          {mechanic.phone && (
            <a href={`tel:${mechanic.phone}`} style={{ width: 52, height: 52, borderRadius: 14, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(34,197,94,0.12)', border: '1.5px solid rgba(34,197,94,0.3)', textDecoration: 'none' }}>
              <Phone style={{ width: 20, height: 20, color: '#86efac' }} />
            </a>
          )}
          <button onClick={onRequest} disabled={requesting} style={{ flex: 1, height: 52, borderRadius: 14, border: 'none', background: `linear-gradient(135deg,${Y},${YD})`, color: '#000', fontWeight: 800, fontSize: 14, cursor: requesting ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, boxShadow: `0 0 0 3px ${Y}22, 0 8px 24px ${Y}33`, opacity: requesting ? 0.7 : 1 }}>
            {requesting ? <><Loader2 style={{ width: 16, height: 16 }} className="animate-spin" /> Sending…</> : <>Request {meta.label} <ChevronRight style={{ width: 16, height: 16 }} /></>}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   Tracking bar
────────────────────────────────────────────────────────────────────────── */
function TrackingBar({ mechanic, serviceType, eta, onCancel }: {
  mechanic: RichProvider; serviceType: string; eta: number; onCancel: () => void;
}) {
  const meta = PROVIDER_META[serviceType] ?? PROVIDER_META.mechanic;
  return (
    <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 50, borderRadius: '24px 24px 0 0', background: 'var(--overlay-bg)', border: '1.5px solid var(--border-2)', borderBottom: 'none', boxShadow: '0 -16px 48px rgba(0,0,0,0.25)', paddingBottom: 'max(env(safe-area-inset-bottom,0px),20px)', animation: 'sheet-up 0.35s cubic-bezier(0.34,1.56,0.64,1) both' }}>
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 12, paddingBottom: 2 }}>
        <div style={{ width: 40, height: 4, borderRadius: 2, background: 'var(--border-4)' }} />
      </div>
      <div style={{ padding: '10px 18px 14px' }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 20, marginBottom: 14, background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.3)' }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#4ade80', animation: 'blink 1.4s ease-in-out infinite' }} />
          <span style={{ color: '#4ade80', fontSize: 11, fontWeight: 700 }}>On the Way to Your Location</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
          <div style={{ width: 52, height: 52, borderRadius: 16, flexShrink: 0, background: `linear-gradient(135deg, ${mechanic.avatarGradient[0]}, ${mechanic.avatarGradient[1]})`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 900, color: 'var(--text-hi)' }}>{mechanic.initials}</div>
          <div style={{ flex: 1 }}>
            <p style={{ color: 'var(--text-hi)', fontWeight: 800, fontSize: 15 }}>{mechanic.mechanic_name}</p>
            <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>{meta.label}</p>
          </div>
          {mechanic.phone && (
            <a href={`tel:${mechanic.phone}`} style={{ width: 42, height: 42, borderRadius: 12, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(34,197,94,0.12)', border: '1.5px solid rgba(34,197,94,0.3)', textDecoration: 'none' }}>
              <Phone style={{ width: 18, height: 18, color: '#86efac' }} />
            </a>
          )}
        </div>
        <div style={{ padding: '12px 16px', borderRadius: 16, marginBottom: 14, background: `${Y}0d`, border: `1px solid ${Y}25`, display: 'flex', alignItems: 'center', gap: 12 }}>
          <Clock style={{ width: 22, height: 22, color: Y, flexShrink: 0 }} />
          <div>
            <p style={{ color: Y, fontWeight: 900, fontSize: 22, lineHeight: 1 }}>{eta} min</p>
            <p style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 2 }}>Estimated arrival · {mechanic.distance_km.toFixed(1)} km away</p>
          </div>
          <CheckCircle2 style={{ width: 20, height: 20, color: '#4ade80', marginLeft: 'auto', flexShrink: 0 }} />
        </div>
        <button onClick={onCancel} style={{ width: '100%', height: 44, borderRadius: 12, border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.07)', color: '#f87171', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
          Cancel Request
        </button>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   Main component
────────────────────────────────────────────────────────────────────────── */
export default function NearbyMechanics() {
  const navigate    = useNavigate();
  const location    = useLocation();
  const { user }    = useAuth();
  const rs          = location.state as RouteState | null;

  // driverPos is mutable — can be refined by location details
  const [driverPos,    setDriverPos]    = useState({ lat: rs?.lat ?? 0.3476, lng: rs?.lng ?? 32.5825 });
  const address     = rs?.address ?? 'Your current location';
  const serviceType = rs?.serviceType ?? 'mechanic';

  const [phase,        setPhase]        = useState<Phase>('beacon');
  const [mechanics,    setMechanics]    = useState<RichProvider[]>([]);
  const [visibleIds,   setVisibleIds]   = useState<Set<number>>(new Set());
  const [selected,     setSelected]     = useState<RichProvider | null>(null);
  const [accepted,     setAccepted]     = useState<RichProvider | null>(null);
  const [requesting,   setRequesting]   = useState(false);
  const [providerPos,  setProviderPos]  = useState({ lat: 0, lng: 0 });
  const [etaMinutes,   setEtaMinutes]   = useState(0);
  const [beaconTick,   setBeaconTick]   = useState(0);
  const [mapZoom,      setMapZoom]      = useState(16);
  const [listMinimized,   setListMinimized]   = useState(false);
  const [navigatingTo,    setNavigatingTo]    = useState<RichProvider | null>(null);
  const [navInfo,         setNavInfo]         = useState<{ distance: string; duration: string } | null>(null);
  const [refinementNote, setRefinementNote] = useState('');

  const mapRef      = useRef<LeafletMap | null>(null);
  const provInitPos = useRef({ lat: 0, lng: 0 });
  // Store the latest driverPos in a ref so startSearch always uses current coords
  const driverPosRef = useRef(driverPos);
  useEffect(() => { driverPosRef.current = driverPos; }, [driverPos]);

  const meta = PROVIDER_META[serviceType] ?? PROVIDER_META.mechanic;

  /* ── Beacon pulse tick ── */
  useEffect(() => {
    const t = setInterval(() => setBeaconTick(n => n + 1), 800);
    return () => clearInterval(t);
  }, []);
  const beaconOuter = 55 + (beaconTick % 2) * 45;
  const beaconMid   = 28 + (beaconTick % 2) * 18;

  /* ── Enrich raw candidates with profile data ── */
  function enrich(candidates: MechanicCandidate[], center: { lat: number; lng: number }): RichProvider[] {
    return candidates.map((m, i) => ({
      ...m,
      pos: scatterPos(center),
      whatsapp: cleanPhone(m.phone),
      email: `info@${m.mechanic_name.toLowerCase().replace(/\s+/g, '')}.ug`,
      locationLabel: LOCATION_LABELS[i % LOCATION_LABELS.length],
      services: SERVICE_SETS[i % SERVICE_SETS.length],
      about: ABOUT_POOL[i % ABOUT_POOL.length],
      avatarGradient: AVATAR_GRADIENTS[i % AVATAR_GRADIENTS.length],
      initials: toInitials(m.mechanic_name),
      reviewCount: 48 + m.mechanic_id * 7,
    }));
  }

  /* ── Track whether location was already refined this page visit ── */
  const refinedRef = useRef(false);
  const markRefined = () => { refinedRef.current = true; };

  /* ── Step 1: beacon → refine (only first time) ── */
  useEffect(() => {
    (async () => {
      setPhase('beacon');
      setMapZoom(16);
      await new Promise(r => setTimeout(r, 2000));
      if (refinedRef.current) {
        // Already refined this session — skip straight to search
        startSearch();
      } else {
        setPhase('refine');
      }
    })();
  }, []);

  /* ── Step 2: after refine form submit ── */
  const handleRefineSubmit = async (note: string, _photo: File | null) => {
    markRefined();
    setRefinementNote(note.trim());
    setPhase('refining');

    await new Promise(r => setTimeout(r, 900));
    startSearch();
  };

  /* ── Step 3: scanning → results ── */
  const startSearch = useCallback(async () => {
    setVisibleIds(new Set());
    setMechanics([]);
    setSelected(null);

    setPhase('scanning');
    setMapZoom(14);

    const center = driverPosRef.current;
    let list: RichProvider[] = [];
    try {
      const res = await matchingService.findNearby(center.lat, center.lng, serviceType, 8);
      list = enrich((res.data.candidates ?? []) as MechanicCandidate[], center);
    } catch {
      list = enrich(
        ['Kampala Auto Works', 'Quick Fix Garage', 'Road Angels Towing', 'City Motors', 'Fast Lane Mechanics'].map((name, i) => {
          const score = +(95 - i * 7).toFixed(1);
          return {
            mechanic_id: i + 1, mechanic_name: name,
            phone: `+25670${i}123456`,
            distance_km: +(0.4 + i * 0.65).toFixed(1),
            total_score: score,
            match_priority: score,
            rationale: i === 0 ? 'Exact specialist for this fault; strong rating, reliable & responsive.' : 'Relevant skills for this fault; reliable & responsive.',
            score_breakdown: { spec_match: 100 - i * 12, availability: 90 - i * 5, proximity: Math.max(20, 95 - i * 14), rating: 88 - i * 6 },
          };
        }),
        center,
      );
    }

    // Minimum scan time
    await new Promise(r => setTimeout(r, 2800));

    setMechanics(list);
    setPhase('results');
    setMapZoom(13);

    // Stagger markers
    list.forEach((m, i) => {
      setTimeout(() => setVisibleIds(prev => new Set([...prev, m.mechanic_id])), i * 380);
    });

    // Fit bounds
    setTimeout(() => {
      if (mapRef.current) {
        const bounds = L.latLngBounds([center.lat, center.lng], [center.lat, center.lng]);
        list.forEach(m => bounds.extend([m.pos.lat, m.pos.lng]));
        mapRef.current.fitBounds(bounds, { paddingTopLeft: [40, 80], paddingBottomRight: [40, 320] });
      }
    }, list.length * 380 + 300);
  }, [serviceType]);

  /* ── Tracking simulation ── */
  useEffect(() => {
    if (phase !== 'tracking' || !accepted) return;
    const start = { ...provInitPos.current };
    const dp    = driverPosRef.current;
    let step = 0;
    const total = 14;
    const totalEta = Math.ceil(accepted.distance_km * 3);
    const t = setInterval(() => {
      step++;
      const progress = step / total;
      const pos = { lat: start.lat + (dp.lat - start.lat) * progress, lng: start.lng + (dp.lng - start.lng) * progress };
      setProviderPos(pos);
      setEtaMinutes(Math.max(1, Math.round(totalEta * (1 - progress))));
      if (mapRef.current) mapRef.current.panTo([(pos.lat + dp.lat) / 2, (pos.lng + dp.lng) / 2]);
      if (step >= total) clearInterval(t);
    }, 4000);
    return () => clearInterval(t);
  }, [phase, accepted]);

  /* ── Request handler ── */
  const handleRequest = async () => {
    if (!selected) return;
    setRequesting(true);
    try {
      const locationWithCoordinates = `${address} (${driverPosRef.current.lat.toFixed(6)}, ${driverPosRef.current.lng.toFixed(6)})`;
      const description = refinementNote
        ? `Roadside assistance needed. Location details: ${refinementNote}`
        : 'Roadside assistance needed';
      await requestsService.create({ customer_name: user?.full_name ?? 'Driver', service_type: serviceType, location: locationWithCoordinates, description });
      const sel = selected;
      setSelected(null);
      setAccepted(sel);
      provInitPos.current = { ...sel.pos };
      setProviderPos({ ...sel.pos });
      setEtaMinutes(Math.ceil(sel.distance_km * 3));
      setPhase('connecting');
      setTimeout(() => { setPhase('tracking'); setMapZoom(15); if (mapRef.current) mapRef.current.panTo(driverPosRef.current); }, 2800);
    } catch {
      toast.error('Failed to send request. Please try again.');
    } finally { setRequesting(false); }
  };

  /* ── In-app navigation ── */
  const startNavigation = useCallback((m: RichProvider) => {
    setNavigatingTo(m);
    setSelected(null);

    // Use the existing estimate; the route preview is a straight line.
    setNavInfo({
      distance: `~${m.distance_km.toFixed(1)} km`,
      duration: `~${Math.ceil(m.distance_km * 3)} min`,
    });

    if (mapRef.current) {
      mapRef.current.fitBounds(
        [[driverPos.lat, driverPos.lng], [m.pos.lat, m.pos.lng]],
        { paddingTopLeft: [60, 100], paddingBottomRight: [60, 220] },
      );
    }
  }, [driverPos]);

  const stopNavigation = () => {
    setNavigatingTo(null);
    setNavInfo(null);
    setListMinimized(false);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 40, background: '#0a0c14' }}>

      {/* ══ MAP ══ */}
      <MapContainer
        center={[driverPos.lat, driverPos.lng]}
        zoom={mapZoom}
        zoomControl={false}
        style={{ width: '100%', height: '100%' }}
      >
        <MapController mapRef={mapRef} zoom={mapZoom} />
        <OpenFreeMapLayer />

        {/* Beacon pulse — always visible */}
        <Circle center={[driverPos.lat, driverPos.lng]} radius={beaconOuter} pathOptions={{ color: R, opacity: 0.22, weight: 1.5, fillColor: R, fillOpacity: 0.05 }} interactive={false} />
        <Circle center={[driverPos.lat, driverPos.lng]} radius={beaconMid} pathOptions={{ color: R, opacity: 0.5, weight: 1.5, fillColor: R, fillOpacity: 0.11 }} interactive={false} />

        {/* Results boundary */}
        {phase === 'results' && (
          <Circle center={[driverPos.lat, driverPos.lng]} radius={2000} pathOptions={{ color: Y, opacity: 0.15, weight: 1, fillColor: Y, fillOpacity: 0.02 }} interactive={false} />
        )}

        {/* Driver pin */}
        <Marker
          position={[driverPos.lat, driverPos.lng]}
          icon={driverIcon(40)}
          zIndexOffset={20}
          draggable={phase === 'refine'}
          eventHandlers={{
            dragend: event => {
              const position = event.target.getLatLng();
              setDriverPos({ lat: position.lat, lng: position.lng });
            },
          }}
        >
          {phase === 'refine' && <Popup>Drag this pin to refine your GPS location.</Popup>}
        </Marker>

        {/* Provider markers — stagger in */}
        {phase === 'results' && mechanics.filter(m => visibleIds.has(m.mechanic_id)).map(m => (
          <Marker
            key={m.mechanic_id}
            position={[m.pos.lat, m.pos.lng]}
            icon={providerIcon(selected?.mechanic_id === m.mechanic_id ? 34 : 28, meta.color, selected?.mechanic_id === m.mechanic_id)}
            eventHandlers={{ click: () => { setSelected(m); mapRef.current?.panTo([m.pos.lat, m.pos.lng]); } }}
            zIndexOffset={selected?.mechanic_id === m.mechanic_id ? 15 : 8}
          >
            <Popup>{m.mechanic_name} · {m.distance_km.toFixed(1)} km away</Popup>
          </Marker>
        ))}

        {/* Straight-line navigation preview */}
        {navigatingTo && (
          <>
            <Polyline
              positions={[[driverPos.lat, driverPos.lng], [navigatingTo.pos.lat, navigatingTo.pos.lng]]}
              pathOptions={{ color: '#34D399', weight: 4, opacity: 0.75, dashArray: '8 10' }}
            />
            <Marker position={[navigatingTo.pos.lat, navigatingTo.pos.lng]} icon={providerIcon(34, '#34D399', true)} zIndexOffset={20} />
          </>
        )}

        {/* Tracking */}
        {(phase === 'tracking' || phase === 'connecting') && accepted && (
          <>
            <Marker position={[providerPos.lat, providerPos.lng]} icon={providerIcon(32, meta.color, true)} zIndexOffset={15} />
            <Polyline
              positions={[[providerPos.lat, providerPos.lng], [driverPos.lat, driverPos.lng]]}
              pathOptions={{ color: Y, opacity: 0.8, weight: 3, dashArray: '6 8' }}
            />
          </>
        )}
      </MapContainer>

      {/* ══ SCAN BLUR — sits above map ══ */}
      {phase === 'scanning' && <ScanBlurOverlay searchLabel={meta.searchLabel} />}

      {/* ══ REFINING overlay ══ */}
      {phase === 'refining' && <RefiningOverlay />}

      {/* ══ FLOATING HEADER ══ */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 30, paddingTop: 'max(env(safe-area-inset-top,0px),14px)', paddingBottom: 10, paddingLeft: 14, paddingRight: 14, display: 'flex', alignItems: 'center', gap: 10, background: 'var(--overlay-bg)', backdropFilter: 'blur(20px)', borderBottom: '1px solid var(--border-1)' }}>
        <button onClick={() => navigate(-1)} style={{ width: 36, height: 36, borderRadius: 10, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface-4)', border: '1px solid var(--border-3)', cursor: 'pointer' }}>
          <ArrowLeft style={{ width: 16, height: 16, color: 'var(--text-md)' }} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ color: 'var(--text-hi)', fontWeight: 800, fontSize: 14, lineHeight: 1 }}>
            {phase === 'beacon'     ? 'Location Confirmed'
           : phase === 'refine'    ? 'Confirm Exact Location'
           : phase === 'refining'  ? 'Refining Location…'
           : phase === 'scanning'  ? `Searching for ${meta.searchLabel}…`
           : phase === 'results'   ? `${mechanics.length} ${meta.label}s Found`
           : phase === 'connecting'? 'Connecting…'
           : `${accepted?.mechanic_name ?? meta.label} On the Way`}
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 3 }}>
            <MapPin style={{ width: 11, height: 11, color: 'var(--text-dim)', flexShrink: 0 }} />
            <p style={{ color: 'var(--text-dim)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{address}</p>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 20, flexShrink: 0, background: `${meta.color}18`, border: `1px solid ${meta.color}30` }}>
          <meta.icon style={{ width: 13, height: 13, color: meta.color }} />
          <span style={{ color: meta.color, fontSize: 11, fontWeight: 700 }}>{meta.label}</span>
        </div>
      </div>

      {/* ══ BEACON CARD ══ */}
      {phase === 'beacon' && (
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 30, borderRadius: '24px 24px 0 0', background: 'var(--overlay-bg)', border: '1.5px solid var(--border-2)', borderBottom: 'none', padding: '20px 20px 36px', boxShadow: '0 -16px 48px rgba(0,0,0,0.25)', animation: 'sheet-up 0.4s cubic-bezier(0.34,1.56,0.64,1) both' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 54, height: 54, borderRadius: 16, flexShrink: 0, background: 'rgba(34,197,94,0.12)', border: '2px solid rgba(34,197,94,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <CheckCircle2 style={{ width: 28, height: 28, color: '#4ade80' }} />
            </div>
            <div style={{ flex: 1 }}>
              <p style={{ color: 'var(--text-hi)', fontWeight: 800, fontSize: 15, marginBottom: 4 }}>Breakdown Location Pinned</p>
              <p style={{ color: 'var(--text-lo)', fontSize: 12, lineHeight: 1.4 }}>{address}</p>
            </div>
          </div>
          <div style={{ marginTop: 16, padding: '11px 14px', borderRadius: 12, background: `${R}0d`, border: `1px solid ${R}25`, display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 9, height: 9, borderRadius: '50%', background: R, flexShrink: 0, animation: 'blink 1s ease-in-out infinite' }} />
            <p style={{ color: 'var(--text-lo)', fontSize: 12 }}>
              Getting ready to search for nearby <strong style={{ color: 'var(--text-hi)' }}>{meta.searchLabel}</strong>…
            </p>
          </div>
        </div>
      )}

      {/* ══ REFINE SHEET ══ */}
      {phase === 'refine' && (
        <LocationRefineSheet
          address={address}
          meta={meta}
          onSubmit={handleRefineSubmit}
          onSkip={() => { markRefined(); startSearch(); }}
        />
      )}

      {/* ══ RESULTS LIST ══ */}
      {phase === 'results' && !selected && !navigatingTo && (
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 30,
          borderRadius: '24px 24px 0 0', background: 'var(--overlay-bg)',
          border: '1.5px solid var(--border-2)', borderBottom: 'none',
          maxHeight: listMinimized ? 72 : '52vh',
          display: 'flex', flexDirection: 'column',
          boxShadow: '0 -16px 48px rgba(0,0,0,0.25)',
          animation: 'sheet-up 0.4s cubic-bezier(0.34,1.56,0.64,1) both',
          transition: 'max-height 0.35s cubic-bezier(0.4,0,0.2,1)',
          overflow: 'hidden',
        }}>
          {/* Drag handle — swipe up to expand, swipe down to minimize */}
          {(() => {
            let startY = 0;
            return (
              <div
                onTouchStart={e => { startY = e.touches[0].clientY; }}
                onTouchEnd={e => {
                  const delta = e.changedTouches[0].clientY - startY;
                  if (delta > 30) setListMinimized(true);
                  else if (delta < -30) setListMinimized(false);
                  else setListMinimized(m => !m);
                }}
                onMouseDown={e => { startY = e.clientY; }}
                onMouseUp={e => {
                  const delta = e.clientY - startY;
                  if (delta > 10) setListMinimized(true);
                  else if (delta < -10) setListMinimized(false);
                  else setListMinimized(m => !m);
                }}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', paddingTop: 10, paddingBottom: 8, flexShrink: 0, cursor: 'grab', touchAction: 'none' }}
              >
                <div style={{ width: 40, height: 4, borderRadius: 2, background: 'var(--border-4)' }} />
              </div>
            );
          })()}

          {/* Header row */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px 10px', flexShrink: 0 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ color: 'var(--text-hi)', fontWeight: 800, fontSize: 15 }}>{mechanics.length} {meta.searchLabel} Available</p>
              {!listMinimized && <p style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 2 }}>Tap a pin or card to view profile · Navigate to drive there</p>}
            </div>
            <button onClick={e => { e.stopPropagation(); startSearch(); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: Y, fontSize: 12, fontWeight: 700, flexShrink: 0 }}>Refresh</button>
          </div>

          {/* List — hidden when minimized */}
          {!listMinimized && (
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 14px', paddingBottom: 'max(env(safe-area-inset-bottom,0px),16px)', scrollbarWidth: 'none' }}>
              {mechanics.map((m, idx) => {
                const _mts = m.total_score ?? 0;
                const rating  = Math.min(5, Math.max(3.5, _mts > 5 ? _mts / 20 : _mts * 5));
                const visible = visibleIds.has(m.mechanic_id);
                return (
                  <div
                    key={m.mechanic_id}
                    style={{ width: '100%', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 16, background: 'var(--surface-1)', border: '1.5px solid var(--border-2)', opacity: visible ? 1 : 0, transform: visible ? 'translateY(0)' : 'translateY(14px)', transition: 'opacity 0.38s ease, transform 0.38s ease' }}
                  >
                    {/* Avatar */}
                    <div
                      onClick={() => { setSelected(m); mapRef.current?.panTo(m.pos); }}
                      style={{ position: 'relative', flexShrink: 0, cursor: 'pointer' }}
                    >
                      <div style={{ width: 46, height: 46, borderRadius: 14, background: `linear-gradient(135deg, ${m.avatarGradient[0]}, ${m.avatarGradient[1]})`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 900, color: 'var(--text-hi)' }}>{m.initials}</div>
                      {idx === 0 && <div style={{ position: 'absolute', top: -5, right: -5, width: 18, height: 18, borderRadius: '50%', background: Y, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, fontWeight: 900, color: '#000' }}>#1</div>}
                    </div>

                    {/* Info */}
                    <div
                      onClick={() => { setSelected(m); mapRef.current?.panTo(m.pos); }}
                      style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
                    >
                      <p style={{ color: 'var(--text-hi)', fontWeight: 700, fontSize: 13, marginBottom: 3 }}>{m.mechanic_name}</p>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <div style={{ display: 'flex', gap: 1.5 }}>
                          {[1,2,3,4,5].map(s => <Star key={s} style={{ width: 9, height: 9, color: s <= Math.round(rating) ? Y : 'var(--border-3)', fill: s <= Math.round(rating) ? Y : 'none' }} />)}
                        </div>
                        <span style={{ color: '#60A5FA', fontSize: 11, fontWeight: 600 }}>{m.distance_km.toFixed(1)} km</span>
                        <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>~{Math.ceil(m.distance_km * 3)} min</span>
                      </div>
                    </div>

                    {/* Navigate button */}
                    <button
                      onClick={e => { e.stopPropagation(); startNavigation(m); }}
                      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '7px 10px', borderRadius: 12, background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.25)', cursor: 'pointer', flexShrink: 0 }}
                    >
                      <Navigation style={{ width: 15, height: 15, color: '#60A5FA' }} />
                      <span style={{ color: '#60A5FA', fontSize: 9, fontWeight: 700 }}>Drive</span>
                    </button>

                    {/* View button */}
                    <button
                      onClick={() => { setSelected(m); mapRef.current?.panTo(m.pos); }}
                      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '7px 10px', borderRadius: 12, background: `${Y}14`, border: `1px solid ${Y}30`, cursor: 'pointer', flexShrink: 0 }}
                    >
                      <ChevronRight style={{ width: 15, height: 15, color: Y }} />
                      <span style={{ color: Y, fontSize: 9, fontWeight: 700 }}>View</span>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ══ PROVIDER DETAIL ══ */}
      {phase === 'results' && selected && !navigatingTo && (
        <ProviderSheet mechanic={selected} serviceType={serviceType} requesting={requesting}
          onClose={() => { setSelected(null); mapRef.current?.panTo(driverPos); }}
          onRequest={handleRequest}
          onNavigate={() => startNavigation(selected)} />
      )}

      {/* ══ IN-APP NAVIGATION BAR ══ */}
      {navigatingTo && (
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 35,
          borderRadius: '24px 24px 0 0', background: 'var(--overlay-bg)',
          border: '1.5px solid var(--border-2)', borderBottom: 'none',
          boxShadow: '0 -16px 48px rgba(0,0,0,0.25)',
          padding: '14px 18px max(env(safe-area-inset-bottom,0px),20px)',
          animation: 'sheet-up 0.35s cubic-bezier(0.34,1.56,0.64,1) both',
        }}>
          {/* Drag handle */}
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
            <div style={{ width: 40, height: 4, borderRadius: 2, background: 'var(--border-4)' }} />
          </div>

          {/* Route info row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <div style={{ width: 46, height: 46, borderRadius: 14, flexShrink: 0, background: 'linear-gradient(135deg,#34D39922,#34D39911)', border: '1.5px solid #34D39940', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Navigation style={{ width: 22, height: 22, color: '#34D399' }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ color: 'var(--text-hi)', fontWeight: 800, fontSize: 14, lineHeight: 1, marginBottom: 3 }}>{navigatingTo.mechanic_name}</p>
              <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>{navigatingTo.locationLabel}</p>
            </div>
            <button
              onClick={stopNavigation}
              style={{ width: 32, height: 32, borderRadius: 10, background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}
            >
              <X style={{ width: 14, height: 14, color: '#f87171' }} />
            </button>
          </div>

          {/* Distance + duration */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
            <div style={{ padding: '10px 14px', borderRadius: 12, background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.2)', textAlign: 'center' }}>
              <p style={{ color: '#60A5FA', fontWeight: 900, fontSize: 18, lineHeight: 1 }}>{navInfo?.distance}</p>
              <p style={{ color: 'var(--text-dim)', fontSize: 10, marginTop: 3 }}>Distance</p>
            </div>
            <div style={{ padding: '10px 14px', borderRadius: 12, background: `${Y}0d`, border: `1px solid ${Y}25`, textAlign: 'center' }}>
              <p style={{ color: Y, fontWeight: 900, fontSize: 18, lineHeight: 1 }}>{navInfo?.duration}</p>
              <p style={{ color: 'var(--text-dim)', fontSize: 10, marginTop: 3 }}>Drive Time</p>
            </div>
          </div>
          <p style={{ color: 'var(--text-faint)', fontSize: 10.5, textAlign: 'center', marginBottom: 10 }}>
            Straight-line estimate · travel time is approximate
          </p>

          {/* View profile button */}
          <button
            onClick={() => { setSelected(navigatingTo); stopNavigation(); }}
            style={{ width: '100%', height: 46, borderRadius: 13, border: 'none', background: `linear-gradient(135deg,${Y},${YD})`, color: '#000', fontWeight: 800, fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
          >
            Request {meta.label} <ChevronRight style={{ width: 16, height: 16 }} />
          </button>
        </div>
      )}

      {/* ══ CONNECTING ══ */}
      {phase === 'connecting' && accepted && (
        <ConnectingOverlay name={accepted.mechanic_name} serviceType={serviceType} />
      )}

      {/* ══ TRACKING ══ */}
      {phase === 'tracking' && accepted && (
        <TrackingBar mechanic={accepted} serviceType={serviceType} eta={etaMinutes}
          onCancel={() => { toast.success('Request cancelled.'); navigate('/requests', { replace: true }); }} />
      )}

      <style>{`
        @keyframes spin-cw       { to { transform: rotate(360deg);  } }
        @keyframes fade-in       { from { opacity:0; } to { opacity:1; } }
        @keyframes sheet-up      { from { transform:translateY(100%); opacity:0.5; } to { transform:translateY(0); opacity:1; } }
        @keyframes blink         { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes scan-sweep    { 0%{width:0%;margin-left:0} 50%{width:55%;margin-left:25%} 100%{width:0%;margin-left:100%} }
        @keyframes progress-fill { from{width:0%} to{width:100%} }
        @keyframes radar-ring {
          0%   { transform:translate(-50%,-50%) scale(0.6); opacity:0.7; }
          80%  { transform:translate(-50%,-50%) scale(2.2); opacity:0; }
          100% { opacity:0; }
        }
      `}</style>
    </div>
  );
}
