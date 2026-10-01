/**
 * ResQAlloc Emergency Control Room & AI Dynamic Resource Reallocation System
 * Full-Viewport Mapbox GL JS Geospatial Canvas
 * Strict Lifecycle & Ref Management: Zero memory leaks, 60fps real-time vehicle animation,
 * dynamic Haversine distance & ETA telemetry, Mapbox real-time traffic layer, and map style switcher.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import {
  WorldState,
  Incident,
  Resource,
  Hospital,
  MapStyleId,
  RouteGeometry,
  TrafficSegment,
} from '../../types/emergency';
import {
  createIncidentMarkerElement,
  createResourceMarkerElement,
  createHospitalMarkerElement,
  createTrafficBottleneckMarkerElement,
} from './MapMarkers';
import {
  syncRouteLayers,
  clearAllRouteLayers,
  updateVehicleLivePath,
  removeVehicleLivePath,
  clearAllVehicleLivePaths,
} from './RouteLayers';
import {
  initTrafficLayers,
  setTrafficVisibility,
  clearTrafficLayers,
  BENGALURU_DEFAULT_TRAFFIC_CORRIDORS,
} from './TrafficLayers';
import { slicePolylineAtProgress } from '../../utils/geoUtils';
import { Satellite, Map as MapIcon, Moon } from 'lucide-react';

export interface MapViewProps {
  worldState: WorldState;
  selectedIncidentId?: string | null;
  selectedResourceId?: string | null;
  simulationSpeed?: number;
  activeMapStyle?: MapStyleId;
  showTrafficOverlay?: boolean;
  onSelectMapStyle?: (style: MapStyleId) => void;
  onToggleTrafficOverlay?: () => void;
  onSelectIncident?: (incident: Incident) => void;
  onSelectResource?: (resource: Resource) => void;
  onSelectHospital?: (hospital: Hospital) => void;
  onSelectTrafficSegment?: (segment: TrafficSegment) => void;
}

const BENGALURU_CENTER: [number, number] = [77.6186, 12.9650];

const MAPBOX_STYLES: Record<MapStyleId, { label: string; url: string; icon: React.ReactNode }> = {
  dark: {
    label: 'Tactical Dark',
    url: 'mapbox://styles/mapbox/dark-v11',
    icon: <Moon className="w-3.5 h-3.5" />,
  },
  satellite: {
    label: 'Satellite Hybrid',
    url: 'mapbox://styles/mapbox/satellite-streets-v12',
    icon: <Satellite className="w-3.5 h-3.5" />,
  },
  streets: {
    label: 'Nav Streets',
    url: 'mapbox://styles/mapbox/streets-v12',
    icon: <MapIcon className="w-3.5 h-3.5" />,
  },
};

export const MapView: React.FC<MapViewProps> = ({
  worldState,
  selectedIncidentId,
  selectedResourceId,
  simulationSpeed = 1,
  activeMapStyle: externalMapStyle,
  showTrafficOverlay: externalShowTraffic,
  onSelectIncident,
  onSelectResource,
  onSelectHospital,
  onSelectTrafficSegment,
}) => {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<mapboxgl.Marker[]>([]);
  const vehicleMarkersMapRef = useRef<Map<string, { marker: mapboxgl.Marker; element: HTMLElement }>>(new Map());

  // Active Map Style state
  const [internalMapStyle] = useState<MapStyleId>('dark');
  const currentMapStyle = externalMapStyle ?? internalMapStyle;
  const currentAppliedStyleRef = useRef<MapStyleId>('dark');

  // Active Traffic Overlay state
  const [internalShowTraffic] = useState<boolean>(true);
  const showTraffic = externalShowTraffic ?? internalShowTraffic;

  // Token management: Ingest from env or allow runtime fallback configuration
  const envToken = import.meta.env.VITE_MAPBOX_TOKEN;
  const isPlaceholderToken = (tok?: string) => !tok || tok.includes('...') || tok.trim().length < 25;
  const validEnvToken = isPlaceholderToken(envToken) ? '' : envToken!.trim();
  const [activeToken, setActiveToken] = useState<string>(() => validEnvToken);
  const [manualTokenInput, setManualTokenInput] = useState<string>('');
  const [isTokenMissing, setIsTokenMissing] = useState<boolean>(() => !validEnvToken);

  // Vehicle along-route animation progress references (0.0 to 1.0) and on-scene pause timers
  const unitProgressRef = useRef<Record<string, number>>({});
  const unitPauseTimerRef = useRef<Record<string, number>>({});
  const animationFrameRef = useRef<number | null>(null);
  const lastTickTimeRef = useRef<number>(performance.now());

  // Simulation speed reference for live 60fps velocity scaling
  const simulationSpeedRef = useRef<number>(simulationSpeed);
  useEffect(() => {
    simulationSpeedRef.current = simulationSpeed;
  }, [simulationSpeed]);

  /**
   * 1. Initialize Mapbox GL Instance
   */
  useEffect(() => {
    if (!activeToken || !mapContainerRef.current) {
      setIsTokenMissing(true);
      return;
    }

    setIsTokenMissing(false);
    mapboxgl.accessToken = activeToken;

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: MAPBOX_STYLES[currentMapStyle].url,
      center: BENGALURU_CENTER,
      zoom: 12.8,
      pitch: 35,
      bearing: -8,
      attributionControl: false,
    });

    mapRef.current = map;
    currentAppliedStyleRef.current = currentMapStyle;

    map.on('load', () => {
      // Synchronize traffic overlay and routes on map load
      initTrafficLayers(map, showTraffic, worldState.trafficSegments ?? BENGALURU_DEFAULT_TRAFFIC_CORRIDORS);
      syncRouteLayers(map, worldState.activeRoutes, selectedIncidentId, selectedResourceId);
    });

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      clearTrafficLayers(map);
      clearAllRouteLayers(map);
      clearAllVehicleLivePaths(map);
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      vehicleMarkersMapRef.current.clear();
      map.remove();
      mapRef.current = null;
    };
  }, [activeToken]);

  /**
   * 2. Synchronize Mapbox Style when changed (from TopNav or MapView controls)
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (currentAppliedStyleRef.current === currentMapStyle) return;

    const targetStyle = MAPBOX_STYLES[currentMapStyle];
    if (!targetStyle) return;

    currentAppliedStyleRef.current = currentMapStyle;

    const applyStyle = () => {
      map.setStyle(targetStyle.url);
      map.once('style.load', () => {
        clearAllRouteLayers(map);
        initTrafficLayers(map, showTraffic, worldState.trafficSegments ?? BENGALURU_DEFAULT_TRAFFIC_CORRIDORS);
        syncRouteLayers(map, worldState.activeRoutes, selectedIncidentId, selectedResourceId);
      });
    };

    if (map.isStyleLoaded()) {
      applyStyle();
    } else {
      map.once('load', applyStyle);
    }
  }, [currentMapStyle, showTraffic, worldState.trafficSegments, worldState.activeRoutes, selectedIncidentId, selectedResourceId]);

  /**
   * 3. Synchronize Traffic Visibility when toggled
   */
  useEffect(() => {
    const map = mapRef.current;
    if (map && map.isStyleLoaded()) {
      if (showTraffic) {
        initTrafficLayers(map, true, worldState.trafficSegments ?? BENGALURU_DEFAULT_TRAFFIC_CORRIDORS);
      }
      setTrafficVisibility(map, showTraffic);
    }
  }, [showTraffic, worldState.trafficSegments]);

  /**
   * 3. Synchronize DOM Markers & Multi-Leg Routes on World State Update
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Purge existing markers deterministically to prevent memory leaks and ghost markers
    markersRef.current.forEach((marker) => marker.remove());
    markersRef.current = [];
    vehicleMarkersMapRef.current.clear();

    const newMarkers: mapboxgl.Marker[] = [];

    // Render Hospital Markers
    worldState.hospitals.forEach((hospital) => {
      const el = createHospitalMarkerElement(hospital, onSelectHospital);
      const marker = new mapboxgl.Marker({ element: el, anchor: 'center' })
        .setLngLat([hospital.location.lng, hospital.location.lat])
        .addTo(map);
      newMarkers.push(marker);
    });

    // Render Active Incidents
    worldState.activeIncidents.forEach((incident) => {
      const el = createIncidentMarkerElement(incident, onSelectIncident);
      const marker = new mapboxgl.Marker({ element: el, anchor: 'center' })
        .setLngLat([incident.location.lng, incident.location.lat])
        .addTo(map);
      newMarkers.push(marker);
    });

    // Render Response Fleet Resources
    worldState.resources.forEach((resource) => {
      const el = createResourceMarkerElement(resource, onSelectResource);
      const marker = new mapboxgl.Marker({ element: el, anchor: 'center' })
        .setLngLat([resource.location.lng, resource.location.lat])
        .addTo(map);
      newMarkers.push(marker);
      vehicleMarkersMapRef.current.set(resource.id, { marker, element: el });

      // Initialize animation progress if not present
      if (unitProgressRef.current[resource.id] === undefined) {
        unitProgressRef.current[resource.id] = resource.status === 'DISPATCHED' ? 0.25 : 0;
      }
    });

    // Render Traffic Bottleneck Markers when traffic overlay or congestion is active
    if (showTraffic) {
      const segments = worldState.trafficSegments ?? BENGALURU_DEFAULT_TRAFFIC_CORRIDORS;
      // Focus on severe bottlenecks
      segments
        .filter((seg) => seg.congestion === 'severe')
        .forEach((seg) => {
          const midIdx = Math.floor(seg.coordinates.length / 2);
          const midCoord = seg.coordinates[midIdx];
          if (midCoord) {
            const el = createTrafficBottleneckMarkerElement(seg, onSelectTrafficSegment);
            const marker = new mapboxgl.Marker({ element: el, anchor: 'center' })
              .setLngLat([midCoord[0], midCoord[1]])
              .addTo(map);
            newMarkers.push(marker);
          }
        });
    }

    markersRef.current = newMarkers;

    // Synchronize route polylines and traffic layers
    if (map.isStyleLoaded()) {
      initTrafficLayers(map, showTraffic, worldState.trafficSegments ?? BENGALURU_DEFAULT_TRAFFIC_CORRIDORS);
      syncRouteLayers(map, worldState.activeRoutes, selectedIncidentId, selectedResourceId);

      // Clean up live paths of inactive fleet units
      const activeUnitIds = new Set(
        worldState.resources
          .filter((r) => r.status === 'DISPATCHED' || r.status === 'REROUTED')
          .map((r) => r.id)
      );
      worldState.resources.forEach((r) => {
        if (!activeUnitIds.has(r.id)) {
          removeVehicleLivePath(map, r.id);
        }
      });
    }
  }, [worldState, showTraffic, selectedIncidentId, selectedResourceId, onSelectIncident, onSelectResource, onSelectHospital, onSelectTrafficSegment]);

  /**
   * 4. 60fps Real-Time Vehicle Along-Route Animation & Dynamic Distance/ETA Telemetry
   * Calibrated strictly to real travel time / ETA so units move at physical proportional speeds.
   */
  useEffect(() => {
    let isCancelled = false;

    const animateVehicles = (now: number) => {
      if (isCancelled) return;

      const deltaSec = Math.min(0.1, (now - lastTickTimeRef.current) / 1000);
      lastTickTimeRef.current = now;

      worldState.resources.forEach((resource) => {
        // Only active dispatched / rerouted units travel along routes
        if (resource.status !== 'DISPATCHED' && resource.status !== 'REROUTED') {
          return;
        }

        // Locate assigned route: prioritize detour route if rerouted, otherwise dispatch route
        const activeRoute: RouteGeometry | undefined =
          worldState.activeRoutes.find((r) => r.resourceId === resource.id && r.type === 'DETOUR') ||
          worldState.activeRoutes.find(
            (r) => r.resourceId === resource.id && !r.id.includes('ORIGINAL') && !r.id.includes('CONGESTED')
          );

        if (!activeRoute || activeRoute.coordinates.length < 2) {
          return;
        }

        // Speed calibration: 1 emergency response minute = 6.0 seconds in simulation.
        // Units with smaller ETAs move proportionally faster and arrive sooner than distant units!
        const baseEtaMinutes = resource.currentEtaMinutes ?? 4.0;
        const totalTripDurationSec = Math.max(10, baseEtaMinutes * 6.0);
        const speedMultiplier = Math.max(0, simulationSpeedRef.current ?? 1.0);
        const speedProgressPerSec = (1 / totalTripDurationSec) * speedMultiplier;

        let currentProgress = unitProgressRef.current[resource.id] ?? 0;
        const currentPause = unitPauseTimerRef.current[resource.id] ?? 0;

        if (currentProgress >= 1.0) {
          // Unit reached scene: pause on scene for 3.0 seconds to simulate scene arrival / triage
          if (currentPause < 3.0) {
            unitPauseTimerRef.current[resource.id] = currentPause + deltaSec * speedMultiplier;
            currentProgress = 1.0;
          } else {
            // Restart loop smoothly from staging base
            unitPauseTimerRef.current[resource.id] = 0;
            currentProgress = 0.0;
          }
        } else {
          currentProgress += speedProgressPerSec * deltaSec;
          if (currentProgress >= 1.0) {
            currentProgress = 1.0;
            unitPauseTimerRef.current[resource.id] = 0;
          }
        }

        unitProgressRef.current[resource.id] = currentProgress;

        // Slice road polyline into:
        // 1. sliced.travelled: Path segment already travelled by vehicle (Solid Sapphire Blue Line)
        // 2. sliced.remaining: Path segment which will be travelled by vehicle (Glowing Electric Blue Line)
        const sliced = slicePolylineAtProgress(
          activeRoute.coordinates,
          currentProgress,
          baseEtaMinutes
        );

        // Update real-time blue lines on map canvas at 60fps
        const map = mapRef.current;
        if (map && map.isStyleLoaded()) {
          const isSelected = selectedResourceId === resource.id || selectedIncidentId === resource.assignedIncidentId;
          updateVehicleLivePath(
            map,
            resource.id,
            sliced.travelled,
            sliced.remaining,
            Boolean(isSelected),
            resource.type
          );
        }

        const vehicleEntry = vehicleMarkersMapRef.current.get(resource.id);
        if (vehicleEntry) {
          // 1. Update marker position on Mapbox canvas directly at 60fps
          vehicleEntry.marker.setLngLat([sliced.position[0], sliced.position[1]]);

          // 2. Rotate vehicle body and forward compass pointer to face exact road direction
          const headingWrapper = vehicleEntry.element.querySelector<HTMLElement>(`[data-heading-wrapper="${resource.id}"]`);
          if (headingWrapper) {
            headingWrapper.style.transform = `rotate(${sliced.bearing}deg)`;
          }

          // 3. Update live distance & ETA pill in DOM without heavy React re-renders
          const etaEl = vehicleEntry.element.querySelector(`[data-eta-text="${resource.id}"]`);
          const distEl = vehicleEntry.element.querySelector(`[data-dist-text="${resource.id}"]`);
          const hoverEtaEl = vehicleEntry.element.querySelector(`[data-hover-eta="${resource.id}"]`);
          const hoverDistEl = vehicleEntry.element.querySelector(`[data-hover-dist="${resource.id}"]`);

          const isArrived = currentProgress >= 0.99;
          const isImminent = !isArrived && sliced.etaMinutes <= 0.2;

          if (etaEl) {
            etaEl.textContent = isArrived ? 'ON SCENE' : isImminent ? 'ARRIVING' : `${sliced.etaMinutes}m`;
          }
          if (distEl) {
            distEl.textContent = `${sliced.distanceRemainingKm}km`;
          }
          if (hoverEtaEl) {
            hoverEtaEl.textContent = isArrived ? 'On Scene' : isImminent ? 'Arriving' : `${sliced.etaMinutes} mins`;
          }
          if (hoverDistEl) {
            hoverDistEl.textContent = `${sliced.distanceRemainingKm} km`;
          }
        }
      });

      animationFrameRef.current = requestAnimationFrame(animateVehicles);
    };

    lastTickTimeRef.current = performance.now();
    animationFrameRef.current = requestAnimationFrame(animateVehicles);

    return () => {
      isCancelled = true;
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [worldState.resources, worldState.activeRoutes, selectedResourceId, selectedIncidentId]);

  /**
   * 5. Handle Smooth Camera Pan (flyTo) when selection changes
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (selectedIncidentId) {
      const target = worldState.activeIncidents.find((i) => i.id === selectedIncidentId);
      if (target) {
        map.flyTo({
          center: [target.location.lng, target.location.lat],
          zoom: 14.2,
          pitch: 45,
          duration: 1800,
          essential: true,
        });
      }
    } else if (selectedResourceId) {
      const target = worldState.resources.find((r) => r.id === selectedResourceId);
      if (target) {
        map.flyTo({
          center: [target.location.lng, target.location.lat],
          zoom: 14.5,
          pitch: 40,
          duration: 1600,
          essential: true,
        });
      }
    }
  }, [selectedIncidentId, selectedResourceId, worldState]);

  const handleManualTokenSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (manualTokenInput.trim()) {
      setActiveToken(manualTokenInput.trim());
      setIsTokenMissing(false);
    }
  };

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#0b0f19]">
      {/* 100vw x 100vh Full Viewport Canvas */}
      <div ref={mapContainerRef} className="absolute inset-0 w-full h-full z-0" />

      {/* Grid Scanline Overlay for Cybernetic Tactical Command Room Aesthetic */}
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_center,transparent_0%,rgba(11,15,25,0.4)_100%)] z-1" />





      {/* Missing Mapbox Token Fallback Overlay */}
      {isTokenMissing && (
        <div className="absolute inset-0 z-50 flex items-center justify-center p-4 bg-[#06080C]/90 backdrop-blur-md">
          <div className="max-w-md w-full p-6 tactical-surface-glass border border-[#FF2A3B] corner-crosshair shadow-2xl text-center">
            <div className="w-12 h-12 mx-auto mb-4 bg-[#1e070a] border border-[#FF2A3B] flex items-center justify-center text-[#FF2A3B]">
              <svg className="w-6 h-6 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <h2 className="text-base font-bold text-[#EDECE8] uppercase tracking-wider mb-2 font-display">
              MAPBOX ACCESS TOKEN REQUIRED
            </h2>
            <p className="text-xs text-[#7A8394] mb-5 leading-relaxed font-sans">
              To activate the real-time Bengaluru geospatial vector canvas, provide a valid Mapbox Public Access Token in <code className="text-[#00F0FF] font-mono">.env</code> as <code className="text-[#00F0FF] font-mono">VITE_MAPBOX_TOKEN</code> or enter below:
            </p>
            <form onSubmit={handleManualTokenSubmit} className="space-y-3">
              <input
                type="text"
                value={manualTokenInput}
                onChange={(e) => setManualTokenInput(e.target.value)}
                placeholder="pk.eyJ1IjoieW91cnVzZXIiLCJhIjoi..."
                className="w-full px-3 py-2 text-xs font-mono bg-[#0D1017] border border-[#1E2532] text-[#EDECE8] placeholder-[#4A5568] focus:outline-none focus:border-[#00F0FF]"
              />
              <button
                type="submit"
                className="w-full py-2 px-4 bg-[#00F0FF] hover:bg-[#38F9D7] text-[#0A0C10] font-black text-xs uppercase tracking-wider transition-colors shadow-lg cursor-pointer"
              >
                INITIALIZE CONTROL MAP
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
