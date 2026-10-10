import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import L from 'leaflet'
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from 'react-leaflet'
import { Maximize2, Minimize2 } from 'lucide-react'
import { useJobSim } from '@/hooks/useJobSim'

type LL = { lat: number; lng: number }
const FALLBACK_CENTER: LL = { lat: 0.3476, lng: 32.5825 }
const DRIVER_ICON = L.divIcon({
  className: 'motofix-leaflet-marker',
  html: '<span class="motofix-map-pin motofix-map-pin-driver">D</span>',
  iconSize: [34, 42],
  iconAnchor: [17, 40],
})
const MECHANIC_ICON = L.divIcon({
  className: 'motofix-leaflet-marker',
  html: '<span class="motofix-map-pin motofix-map-pin-mechanic">🔧</span>',
  iconSize: [38, 46],
  iconAnchor: [19, 44],
})

function FitMap({ points }: { points: LL[] }) {
  const map = useMap()
  useEffect(() => {
    if (points.length > 1) {
      map.fitBounds(points.map(point => [point.lat, point.lng]), { padding: [42, 42], maxZoom: 16 })
    } else if (points.length === 1) {
      map.setView([points[0].lat, points[0].lng], 15)
    }
  }, [map, points])
  return null
}

function MapView({
  driverPos, mechPos, route, expanded, onToggle,
}: {
  driverPos: LL | null
  mechPos: LL | null
  route: LL[] | null
  expanded: boolean
  onToggle: () => void
}) {
  const points = [driverPos, mechPos].filter((point): point is LL => point != null)
  const center = points[0] ?? FALLBACK_CENTER

  return (
    <div style={{ width: '100%', height: expanded ? '100%' : 320, position: 'relative' }}>
      <MapContainer
        center={[center.lat, center.lng]}
        zoom={15}
        scrollWheelZoom
        style={{ width: '100%', height: '100%' }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <FitMap points={points} />
        {route && route.length > 1 && (
          <Polyline positions={route.map(point => [point.lat, point.lng])} pathOptions={{ color: '#F59E0B', weight: 6, opacity: 0.9 }} />
        )}
        {driverPos && (
          <Marker position={[driverPos.lat, driverPos.lng]} icon={DRIVER_ICON}>
            <Popup>Driver location</Popup>
          </Marker>
        )}
        {mechPos && (
          <Marker position={[mechPos.lat, mechPos.lng]} icon={MECHANIC_ICON}>
            <Popup>Service provider</Popup>
          </Marker>
        )}
      </MapContainer>
      <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 1000 }}>
        <button
          aria-label={expanded ? 'Collapse map' : 'Expand map'}
          onClick={onToggle}
          style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(10,14,30,0.86)', border: '1px solid rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
        >
          {expanded
            ? <Minimize2 style={{ width: 15, height: 15, color: '#fff' }} />
            : <Maximize2 style={{ width: 15, height: 15, color: '#fff' }} />}
        </button>
      </div>
    </div>
  )
}

export default function TrackingMap({
  driverLat, driverLng,
  arrived, assigned, simActive, requestId, enRouteAt,
  onRouteUpdate, onProgress,
}: {
  driverLat?: number | null; driverLng?: number | null
  arrived?: boolean
  assigned?: boolean
  simActive?: boolean
  requestId?: string | number | null
  enRouteAt?: string | null
  onRouteUpdate?: (info: { duration: string; distance: string } | null) => void
  onProgress?: (fraction: number) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const hasDriver = driverLat != null && driverLng != null
  const driverPos = hasDriver ? { lat: driverLat, lng: driverLng } : null
  const enRoute = !!simActive && !arrived
  const showJourney = !!(assigned ?? simActive) && !arrived

  const sim = useJobSim({
    active: showJourney,
    advancing: enRoute,
    driver: driverPos,
    seed: String(requestId ?? ''),
    enRouteAt: enRouteAt ?? null,
  })
  const mechPos = arrived ? driverPos : sim.mechPos
  const points = showJourney ? sim.remaining : null

  useEffect(() => { if (enRoute) onProgress?.(sim.progress) }, [sim.progress, enRoute, onProgress])
  useEffect(() => {
    if (!enRoute || sim.etaMinutes == null || sim.distanceKm == null) {
      onRouteUpdate?.(null)
      return
    }
    onRouteUpdate({
      duration: sim.etaMinutes <= 0 ? 'Arriving' : `${sim.etaMinutes} min`,
      distance: sim.distanceKm >= 1 ? `${sim.distanceKm.toFixed(1)} km` : `${Math.round(sim.distanceKm * 1000)} m`,
    })
  }, [enRoute, sim.etaMinutes, sim.distanceKm, onRouteUpdate])

  const viewProps = { driverPos, mechPos, route: points, onToggle: () => setExpanded(value => !value) }
  return (
    <>
      <div style={{ height: 320, borderRadius: 16, overflow: 'hidden', border: '1px solid var(--border-2, rgba(0,0,0,0.1))', visibility: expanded ? 'hidden' : 'visible' }}>
        <MapView key={`embedded-${String(requestId ?? '')}`} {...viewProps} expanded={false} />
      </div>
      {expanded && createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: '#000' }}>
          <MapView key={`expanded-${String(requestId ?? '')}`} {...viewProps} expanded />
        </div>,
        document.body,
      )}
    </>
  )
}
