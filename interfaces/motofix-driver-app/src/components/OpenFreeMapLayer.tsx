// OpenFreeMapLayer.tsx — renders an OpenFreeMap (OFM) vector-tile basemap inside a
// react-leaflet map. OFM only serves vector tiles (no raster PNGs), so we use
// MapLibre GL through the @maplibre/maplibre-gl-leaflet adapter, which drops a
// MapLibre layer into the existing Leaflet map. All existing Leaflet markers,
// popups, polylines and circles keep working on top of it.
import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import { maplibreGL } from '@maplibre/maplibre-gl-leaflet';
import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';

// MapLibre parses vector tiles in a Web Worker; in Vite the worker is imported as
// a URL and registered once at module load.
setWorkerUrl(workerUrl);

// Positron: OFM's light/minimal style — clean and readable under markers/routes.
const OFM_STYLE = 'https://tiles.openfreemap.org/styles/positron';

const ATTRIBUTION =
  '&copy; <a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a>,' +
  ' &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors';

export default function OpenFreeMapLayer() {
  const map = useMap();

  useEffect(() => {
    const layer = maplibreGL({ style: OFM_STYLE, attributionControl: false });
    layer.addTo(map);

    // MapLibre's own attribution control sits inside the embedded canvas; instead we
    // add OFM's required attribution to Leaflet's control so it's reliably visible.
    const control = map.attributionControl ?? L.control.attribution({ prefix: false }).addTo(map);
    control.setPrefix(false);
    control.addAttribution(ATTRIBUTION);

    return () => {
      map.removeLayer(layer);
      control.removeAttribution(ATTRIBUTION);
    };
  }, [map]);

  return null;
}
