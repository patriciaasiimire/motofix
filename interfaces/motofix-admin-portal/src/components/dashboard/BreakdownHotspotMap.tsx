// Highlights areas with the most breakdowns on an OpenStreetMap basemap.

import { useState } from 'react';
import { CircleMarker, MapContainer, Popup, useMapEvents } from 'react-leaflet';
import OpenFreeMapLayer from '@/components/OpenFreeMapLayer';
import { Flame, MapPin, Activity, X, TrendingUp } from 'lucide-react';

const C = {
  surface:  'var(--adm-surface)',
  surface2: 'var(--adm-surface-2)',
  border:   'var(--adm-border)',
  amber:    'var(--adm-amber)',
  text:     'var(--adm-text)',
  muted:    'var(--adm-muted)',
  green:    'var(--adm-green)',
  red:      'var(--adm-red)',
  orange:   'var(--adm-orange)',
} as const;

const KAMPALA_CENTER: [number, number] = [0.3136, 32.5811];

function MapClickHandler({ onMapClick }: { onMapClick: () => void }) {
  useMapEvents({
    click: (event) => {
      event.originalEvent.stopPropagation();
      onMapClick();
    },
  });
  return null;
}

interface Hotspot {
  id: number;
  name: string;
  area: string;
  lat: number;
  lng: number;
  count: number;
  avgDaily: number;
}

const HOTSPOTS: Hotspot[] = [
  { id:  1, name: 'Kampala Road',       area: 'Central',  lat: 0.3163, lng: 32.5822, count: 87, avgDaily: 2.9 },
  { id:  2, name: 'Jinja Rd / Nakawa',  area: 'Nakawa',   lat: 0.3200, lng: 32.6150, count: 73, avgDaily: 2.4 },
  { id:  3, name: 'Kibuye Junction',    area: 'Makindye', lat: 0.2880, lng: 32.5650, count: 64, avgDaily: 2.1 },
  { id:  4, name: 'Lugogo Bypass',      area: 'Central',  lat: 0.3320, lng: 32.5950, count: 61, avgDaily: 2.0 },
  { id:  5, name: 'Bombo Rd/Kawempe',   area: 'Kawempe',  lat: 0.3750, lng: 32.5590, count: 58, avgDaily: 1.9 },
  { id:  6, name: 'Kireka Road',        area: 'Kireka',   lat: 0.3250, lng: 32.6380, count: 52, avgDaily: 1.7 },
  { id:  7, name: 'Ntinda Road',        area: 'Ntinda',   lat: 0.3470, lng: 32.6120, count: 45, avgDaily: 1.5 },
  { id:  8, name: 'Ggaba Road',         area: 'Makindye', lat: 0.2750, lng: 32.5880, count: 41, avgDaily: 1.4 },
  { id:  9, name: 'Masaka Rd/Lubaga',   area: 'Lubaga',   lat: 0.3080, lng: 32.5480, count: 39, avgDaily: 1.3 },
  { id: 10, name: 'Old Portbell Rd',    area: 'Nakawa',   lat: 0.3000, lng: 32.6250, count: 35, avgDaily: 1.2 },
  { id: 11, name: 'Northern Bypass',    area: 'Kawempe',  lat: 0.3670, lng: 32.5350, count: 33, avgDaily: 1.1 },
  { id: 12, name: 'Namugongo Road',     area: 'Kira',     lat: 0.3600, lng: 32.6600, count: 28, avgDaily: 0.9 },
];

function hotspotColor(count: number) {
  if (count > 60) return '#f87171';
  if (count > 40) return '#FFB300';
  return '#34d399';
}

function RiskBadge({ count }: { count: number }) {
  const [label, bg, color] =
    count > 60 ? ['High',   'rgba(248,113,113,0.15)', '#f87171'] :
    count > 40 ? ['Medium', 'rgba(255,179,0,0.12)',  '#FFB300'] :
                 ['Low',    'rgba(52,211,153,0.12)',   '#34d399'];
  return (
    <span style={{
      fontSize: 9.5, fontWeight: 700, padding: '2px 7px', borderRadius: 20,
      background: bg, color, border: `1px solid ${color}30`,
      textTransform: 'uppercase', letterSpacing: '0.05em',
    }}>
      {label}
    </span>
  );
}

export function BreakdownHotspotMap() {
  const [selected, setSelected] = useState<Hotspot | null>(null);

  const total     = HOTSPOTS.reduce((s, h) => s + h.count, 0);
  const avgDay    = HOTSPOTS.reduce((s, h) => s + h.avgDaily, 0);
  const maxCount  = Math.max(...HOTSPOTS.map(h => h.count));
  const highRisk  = HOTSPOTS.filter(h => h.count > 60).length;
  const ranked    = [...HOTSPOTS].sort((a, b) => b.count - a.count);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: 16 }}>

      {/* ── Map card ────────────────────────────────────────── */}
      <div style={{
        background: C.surface, border: `2px solid var(--adm-card-border)`,
        boxShadow: 'var(--adm-card-shadow)',
        borderRadius: 16, overflow: 'hidden', display: 'flex', flexDirection: 'column',
        transition: 'border-color 0.2s ease, box-shadow 0.22s ease',
      }}
        onMouseEnter={e => {
          e.currentTarget.style.borderColor = 'var(--adm-border-hi)';
          e.currentTarget.style.boxShadow = 'var(--adm-hover-shadow)';
        }}
        onMouseLeave={e => {
          e.currentTarget.style.borderColor = 'var(--adm-card-border)';
          e.currentTarget.style.boxShadow = 'var(--adm-card-shadow)';
        }}
      >
        {/* Header */}
        <div style={{
          padding: '16px 22px', borderBottom: `1px solid ${C.border}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              background: C.amber, boxShadow: `0 0 6px ${C.amber}`,
            }} />
            <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Breakdown Hotspots</span>
            <span style={{ fontSize: 11, color: C.muted, fontWeight: 500 }}>— Kampala, Uganda</span>
          </div>
          {/* Legend */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            {([['#f87171','High'],['#FFB300','Medium'],['#34d399','Low']] as const).map(([col, lbl]) => (
              <div key={lbl} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: col }} />
                <span style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>{lbl}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Map */}
        <div style={{ position: 'relative', flex: 1, minHeight: 380 }}>
          <MapContainer
            className="h-full w-full"
            center={KAMPALA_CENTER}
            zoom={12}
            zoomControl
            scrollWheelZoom={false}
            style={{ height: '100%', width: '100%' }}
          >
            <OpenFreeMapLayer />
            <MapClickHandler onMapClick={() => setSelected(null)} />
            {HOTSPOTS.map(spot => {
              const isActive = selected?.id === spot.id;
              const color = hotspotColor(spot.count);
              return (
                <CircleMarker
                  key={spot.id}
                  center={[spot.lat, spot.lng]}
                  radius={spot.count > 60 ? 12 : spot.count > 40 ? 10 : 8}
                  pathOptions={{
                    color: '#fff',
                    weight: isActive ? 3 : 2,
                    fillColor: color,
                    fillOpacity: 0.9,
                  }}
                  eventHandlers={{ click: () => setSelected(spot) }}
                >
                  <Popup>
                    <strong>{spot.name}</strong><br />
                    {spot.area} · {spot.count} incidents · {spot.avgDaily} avg/day
                  </Popup>
                </CircleMarker>
              );
            })}
          </MapContainer>

          {/* Selected-spot tooltip overlay */}
          {selected && (
            <div style={{
              position: 'absolute', bottom: 16, left: 16,
              background: 'rgba(20,20,38,0.95)',
              backdropFilter: 'blur(10px)',
              border: `1px solid ${hotspotColor(selected.count)}55`,
              borderRadius: 12, padding: '12px 15px',
              minWidth: 220, zIndex: 10,
              boxShadow: `0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px ${hotspotColor(selected.count)}22`,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: C.text, lineHeight: 1.3 }}>{selected.name}</div>
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{selected.area} Division</div>
                </div>
                <button
                  onClick={() => setSelected(null)}
                  style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer', padding: 0, lineHeight: 1 }}
                >
                  <X size={14} />
                </button>
              </div>
              <div style={{ display: 'flex', gap: 12 }}>
                <div style={{ flex: 1, background: 'rgba(248,113,113,0.1)', borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
                  <div style={{ fontSize: 10, color: C.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Total</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: '#f87171', letterSpacing: '-0.5px' }}>{selected.count}</div>
                </div>
                <div style={{ flex: 1, background: 'rgba(255,179,0,0.08)', borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
                  <div style={{ fontSize: 10, color: C.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Avg/Day</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: C.amber, letterSpacing: '-0.5px' }}>{selected.avgDaily}</div>
                </div>
                <div style={{ flex: 1, background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
                  <div style={{ fontSize: 10, color: C.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Risk</div>
                  <div style={{ marginTop: 4 }}><RiskBadge count={selected.count} /></div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Stats panel ─────────────────────────────────────── */}
      <div style={{
        background: C.surface, border: `2px solid var(--adm-card-border)`,
        boxShadow: 'var(--adm-card-shadow)',
        borderRadius: 16, padding: '20px 22px',
        display: 'flex', flexDirection: 'column', gap: 20,
        transition: 'transform 0.22s ease, box-shadow 0.22s ease, border-color 0.2s ease',
      }}
        onMouseEnter={e => {
          e.currentTarget.style.borderColor = 'var(--adm-border-hi)';
          e.currentTarget.style.transform = 'translateY(-3px)';
          e.currentTarget.style.boxShadow = 'var(--adm-hover-shadow)';
        }}
        onMouseLeave={e => {
          e.currentTarget.style.borderColor = 'var(--adm-card-border)';
          e.currentTarget.style.transform = 'translateY(0)';
          e.currentTarget.style.boxShadow = 'var(--adm-card-shadow)';
        }}
      >
        {/* Title */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Flame size={15} style={{ color: C.amber }} />
            <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>City Statistics</span>
          </div>
          <div style={{ fontSize: 11.5, color: C.muted }}>All-time breakdown data · Kampala Metro</div>
        </div>

        {/* Summary chips 2×2 */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {[
            { label: 'Total Incidents', value: total.toLocaleString(), color: '#f87171', icon: <Activity size={13} /> },
            { label: 'Hotspot Zones',   value: HOTSPOTS.length,         color: C.amber,   icon: <MapPin size={13} /> },
            { label: 'Avg Daily Total', value: avgDay.toFixed(1),        color: C.green,   icon: <TrendingUp size={13} /> },
            { label: 'High-Risk Zones', value: highRisk,                 color: '#f59e0b', icon: <Flame size={13} /> },
          ].map(item => (
            <div key={item.label} style={{
              background: C.surface2, borderRadius: 11, padding: '13px 14px',
              border: `1.5px solid var(--adm-card-border)`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 7, color: item.color }}>
                {item.icon}
                <span style={{ fontSize: 10, fontWeight: 600, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {item.label}
                </span>
              </div>
              <div style={{ fontSize: 22, fontWeight: 800, color: item.color, letterSpacing: '-0.5px', lineHeight: 1 }}>
                {item.value}
              </div>
            </div>
          ))}
        </div>

        {/* Divider */}
        <div style={{ height: 1, background: C.border }} />

        {/* Ranked hotspot list */}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 12 }}>
            Top Hotspots
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {ranked.map((spot, i) => {
              const pct = Math.round((spot.count / maxCount) * 100);
              const col = hotspotColor(spot.count);
              const isActive = selected?.id === spot.id;
              return (
                <div
                  key={spot.id}
                  onClick={() => setSelected(isActive ? null : spot)}
                  style={{
                    cursor: 'pointer',
                    padding: '9px 11px', borderRadius: 10,
                    background: isActive ? `${col}12` : 'transparent',
                    border: `1px solid ${isActive ? col + '40' : 'transparent'}`,
                    transition: 'all 0.15s',
                  }}
                  onMouseEnter={e => {
                    if (!isActive) (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.03)';
                  }}
                  onMouseLeave={e => {
                    if (!isActive) (e.currentTarget as HTMLDivElement).style.background = 'transparent';
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <span style={{
                        width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
                        background: C.surface2, border: `1px solid ${C.border}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 8.5, fontWeight: 800, color: C.muted,
                      }}>
                        {i + 1}
                      </span>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: isActive ? C.text : C.muted, lineHeight: 1.2 }}>
                        {spot.name}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 800, color: col }}>{spot.count}</span>
                      <RiskBadge count={spot.count} />
                    </div>
                  </div>
                  <div style={{ height: 3, background: 'var(--adm-track-bg)', borderRadius: 99, overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', width: `${pct}%`,
                      background: col, borderRadius: 99,
                      transition: 'width 0.6s ease',
                    }} />
                  </div>
                  <div style={{ fontSize: 10, color: C.muted, marginTop: 4 }}>
                    {spot.area} · {spot.avgDaily} avg/day
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

    </div>
  );
}
