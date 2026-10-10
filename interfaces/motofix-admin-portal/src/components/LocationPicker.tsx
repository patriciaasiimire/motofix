import { useCallback, useEffect, useState } from 'react';
import { MapContainer, Marker, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import { Loader2 } from 'lucide-react';
import { reverseGeocode } from '@/utils/geocode';

const DEFAULT_CENTER: [number, number] = [0.3476, 32.5825]; // Kampala
const MAP_CONTAINER_CLASS = 'w-full rounded-xl overflow-hidden border-2 border-border h-[300px]';

interface LocationPickerProps {
  onLocationChange: (lat: number, lng: number, address: string) => void;
}

interface LocationPickerMapProps {
  markerPos: [number, number];
  onPositionChange: (lat: number, lng: number) => void;
}

function LocationPickerMap({ markerPos, onPositionChange }: LocationPickerMapProps) {
  const map = useMap();

  useEffect(() => {
    if (!navigator.geolocation) {
      onPositionChange(...DEFAULT_CENTER);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const position: [number, number] = [coords.latitude, coords.longitude];
        map.setView(position, map.getZoom());
        onPositionChange(...position);
      },
      () => onPositionChange(...DEFAULT_CENTER),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  }, [map, onPositionChange]);

  useMapEvents({
    click: ({ latlng }) => onPositionChange(latlng.lat, latlng.lng),
  });

  return <Marker position={markerPos} draggable eventHandlers={{
    dragend: (event) => {
      const { lat, lng } = event.target.getLatLng();
      onPositionChange(lat, lng);
    },
  }} />;
}

export function LocationPicker({ onLocationChange }: LocationPickerProps) {
  const [markerPos, setMarkerPos] = useState<[number, number]>(DEFAULT_CENTER);
  const [address, setAddress] = useState('');
  const [addressStatus, setAddressStatus] = useState<'loading' | 'done' | 'error'>('loading');

  const updatePosition = useCallback(async (lat: number, lng: number) => {
    setMarkerPos([lat, lng]);
    setAddressStatus('loading');

    const resolved = await reverseGeocode(lat, lng);
    const displayAddress = resolved === 'Pinned location'
      ? `${lat.toFixed(5)}, ${lng.toFixed(5)}`
      : resolved;
    setAddress(displayAddress);
    setAddressStatus(resolved === 'Pinned location' ? 'error' : 'done');
    onLocationChange(lat, lng, displayAddress);
  }, [onLocationChange]);

  return (
    <div className="space-y-2">
      <MapContainer
        className={MAP_CONTAINER_CLASS}
        center={DEFAULT_CENTER}
        zoom={16}
        scrollWheelZoom
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <LocationPickerMap markerPos={markerPos} onPositionChange={updatePosition} />
      </MapContainer>
      <div className="text-sm text-muted-foreground flex items-start gap-2 min-h-[1.5rem]">
        {addressStatus === 'loading' ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin shrink-0 mt-0.5" />
            <span>Finding address…</span>
          </>
        ) : (
          <span className="line-clamp-2" title={address}>
            📍 {address || 'Drag the pin to set your location'}
          </span>
        )}
      </div>
    </div>
  );
}
