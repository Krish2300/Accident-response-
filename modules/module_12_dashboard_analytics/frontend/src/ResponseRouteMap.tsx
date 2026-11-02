import { useEffect, useMemo } from 'react';
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { PlannedRoute } from './api.js';

export default function ResponseRouteMap({ route, ambulance, pickup }: {
  route: PlannedRoute;
  ambulance: { latitude: number; longitude: number };
  pickup: { latitude: number; longitude: number };
}) {
  const geometryKey = route.polyline.map(([latitude, longitude]) => `${latitude},${longitude}`).join(';');
  const points = useMemo<L.LatLngExpression[]>(() => route.polyline.map(([latitude, longitude]) => [latitude, longitude]), [geometryKey]);
  const bounds = useMemo(() => L.latLngBounds(points), [geometryKey]);
  return <>
    <div style={{ height: 360, width: '100%', overflow: 'hidden', borderRadius: 8, marginTop: 12 }} aria-label="Interactive ambulance road route map">
      <MapContainer bounds={bounds} scrollWheelZoom style={{ height: '100%', width: '100%' }}>
        <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <Polyline positions={points} pathOptions={{ color: '#1769aa', weight: 6 }}><Popup>{route.provider} road route · {route.distanceKm.toFixed(1)} km · {route.estimatedMinutes == null ? 'ETA unavailable' : `${Math.round(route.estimatedMinutes)} min`}</Popup></Polyline>
        <Marker position={[ambulance.latitude, ambulance.longitude]}><Popup>Ambulance location{route.isSimulation ? ' · simulated' : ''}</Popup></Marker>
        <Marker position={[pickup.latitude, pickup.longitude]}><Popup>Patient pickup point</Popup></Marker>
        <FitMapBounds bounds={bounds} />
      </MapContainer>
    </div>
    <p style={{ color: '#566873' }}>Road geometry from {route.provider}; {route.isLiveTraffic ? 'traffic-aware ETA' : 'static-speed ETA, not live traffic'}{route.isSimulation ? ' · simulation coordinates' : ''}.</p>
  </>;
}

function FitMapBounds({ bounds }: { bounds: L.LatLngBounds }) {
  const map = useMap();
  useEffect(() => { map.fitBounds(bounds, { padding: [24, 24] }); }, [map, bounds]);
  return null;
}
