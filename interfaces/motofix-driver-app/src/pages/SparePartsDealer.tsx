// SparePartsDealer.tsx — the spare-parts hub screen: find nearby parts dealers on a map
// (admin-registered dealers first, then OSM/branded fallbacks), browse self-fix guides,
// ask MOTOBOT, and open the order flow. Pulls together several parts-related features.

import { useState, useCallback, useEffect, useMemo, useRef, type MutableRefObject } from "react";
import type { ElementType } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import SelfFixGuides from "@/components/SelfFixGuides";
import OrderPartsShop from "@/components/OrderPartsShop";
import { MapContainer, Marker, Polyline, Popup, useMap } from "react-leaflet";
import OpenFreeMapLayer from "@/components/OpenFreeMapLayer";
import { divIcon, type Map as LeafletMap } from "leaflet";
import { ArrowLeft, Phone, Star, MapPin, X, Navigation, ShoppingBag, Loader2, ChevronRight, MessageCircle, ReceiptText, Clock, Store, Plus, Check, Wrench, Bot, Truck } from "lucide-react";
import { useTheme } from "@/contexts/ThemeContext";
import { useAuth } from "@/hooks/useAuth";
import { partsService, motobotService, dealerService, PartsOrder, PartPriceItem } from "@/config/api";
import { MOTOBOT_ENABLED } from "@/config/features";
import { generateSimDealers, enrichDealer, SimDealer } from "@/lib/simDealers";
import { toast } from "sonner";

const AMBER = "#F59E0B";
const AMBER_D = "#D97706";
const AMBER_GRAD = `linear-gradient(135deg, ${AMBER}, ${AMBER_D})`;
const DRIVER_NAV_CLEARANCE = "calc(104px + env(safe-area-inset-bottom, 0px))";

const driverLeafletIcon = divIcon({
  className: "",
  html: '<span style="display:grid;place-items:center;width:32px;height:32px;border:3px solid white;border-radius:50%;background:#3B82F6;color:white;font-size:16px;box-shadow:0 2px 8px #0008">●</span>',
  iconSize: [32, 32],
  iconAnchor: [16, 16],
});
const dealerLeafletIcon = divIcon({
  className: "",
  html: `<span style="display:grid;place-items:center;width:38px;height:38px;border:3px solid white;border-radius:50%;background:#F59E0B;color:white;font-size:20px;box-shadow:0 2px 8px #0008">${"⚙"}</span>`,
  iconSize: [38, 38],
  iconAnchor: [19, 19],
});

type LL = { lat: number; lng: number };

const KAMPALA: LL = { lat: 0.3476, lng: 32.5825 };
const LEAFLET_BASE_CSS = `
  .leaflet-container{position:relative;overflow:hidden;background:#e5e7eb;outline:0;font-family:Arial,sans-serif}
  .leaflet-pane,.leaflet-tile,.leaflet-marker-icon,.leaflet-marker-shadow,.leaflet-tile-container,.leaflet-pane>svg,.leaflet-pane>canvas{position:absolute;left:0;top:0}
  .leaflet-pane{z-index:400}.leaflet-tile-pane{z-index:200}.leaflet-overlay-pane{z-index:400}.leaflet-shadow-pane{z-index:500}.leaflet-marker-pane{z-index:600}.leaflet-tooltip-pane{z-index:650}.leaflet-popup-pane{z-index:700}
  .leaflet-tile{visibility:hidden;max-width:none!important}.leaflet-tile-loaded{visibility:inherit}.leaflet-container img{max-width:none!important;max-height:none!important}
  .leaflet-control-container{position:absolute;inset:0;pointer-events:none}.leaflet-top,.leaflet-bottom{position:absolute;z-index:1000;pointer-events:none}.leaflet-top{top:0}.leaflet-bottom{bottom:0}.leaflet-left{left:0}.leaflet-right{right:0}.leaflet-control{position:relative;pointer-events:auto}
  .leaflet-control-attribution{background:#ffffffd9;padding:2px 5px;font:11px Arial,sans-serif}.leaflet-popup-content-wrapper{border-radius:10px}.leaflet-popup-content{margin:10px 12px}
`;

function haversineKm(a: LL, b: LL): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return (R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))) / 1000;
}

function MapViewport({ mapRef, center, points, zoom = 13 }: {
  mapRef: MutableRefObject<LeafletMap | null>;
  center: LL;
  points?: LL[];
  zoom?: number;
}) {
  const map = useMap();
  const pointsKey = points?.map(({ lat, lng }) => `${lat},${lng}`).join(";") ?? "";
  useEffect(() => {
    mapRef.current = map;
    return () => {
      if (mapRef.current === map) mapRef.current = null;
    };
  }, [map, mapRef]);
  useEffect(() => {
    if (points && points.length > 1) {
      map.fitBounds(points.map(({ lat, lng }) => [lat, lng]), { padding: [36, 36], maxZoom: 16 });
    } else {
      map.setView(center, zoom);
    }
    // pointsKey tracks coordinate changes without refitting on unrelated renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, pointsKey, center.lat, center.lng, zoom]);
  return null;
}

const QUICK_PARTS = ["Tyre", "Inner tube", "Car battery", "Brake pads", "Spark plugs", "Headlight bulb", "Wiper blades", "Engine oil", "Air filter", "Fan belt", "Side mirror", "Shock absorber", "Radiator", "Fuel pump", "Clutch plate", "Fuses"];

type Pose = "grad" | "detective" | "think" | "ready" | "files" | "wave" | "salute" | "curious" | "scan";

interface Question {
  id: "parts" | "vehicle" | "fulfilment";
  pose: Pose;
  text: string;
  hint?: string;
  type: "multi" | "single";
  options: string[];
}

const QUESTIONS: Question[] = [
  { id: "parts", pose: "curious", text: "What spare part are you looking for?", hint: "Pick all that apply — or type your own", type: "multi", options: QUICK_PARTS },
  { id: "vehicle", pose: "think", text: "What car brand is it for?", hint: "Select one", type: "single", options: ["Toyota", "Nissan", "Subaru", "Mitsubishi", "Mazda", "Honda", "Isuzu", "Suzuki", "Volkswagen", "Mercedes-Benz", "BMW", "Land Rover", "Hyundai", "Other"] },
  { id: "fulfilment", pose: "ready", text: "How would you like to get the parts?", type: "single", options: ["I'll pick them up", "Deliver them to me"] },
];

const PROC_MSGS = MOTOBOT_ENABLED
  ? ["Pricing the parts you need", "Checking current market rates", "Finding the best options near you", "Putting it all together"]
  : ["Preparing your parts list", "Using catalogue estimates", "Finding the best options near you", "Putting it all together"];
const DELIVERY_FEE = 10000; // flat MOTOFIX delivery fee (UGX)

function waDigits(raw?: string): string {
  if (!raw) return "";
  let d = raw.replace(/[^\d]/g, "");
  if (d.startsWith("0")) d = "256" + d.slice(1);
  else if (!d.startsWith("256") && d.length === 9) d = "256" + d;
  return d;
}
const fmtUGX = (n: number) => (n >= 1000 ? `UGX ${(n / 1000).toFixed(n % 1000 ? 1 : 0)}K` : `UGX ${n}`);
const range = (a: number, b: number) => (a === b ? fmtUGX(a) : `${fmtUGX(a)} – ${fmtUGX(b)}`);

function Stars({ rating, size = 12 }: { rating: number; size?: number }) {
  const f = Math.round(rating);
  return (
    <span style={{ display: "inline-flex", gap: 1 }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} size={size} style={{ color: AMBER, fill: i <= f ? AMBER : "none" }} />
      ))}
    </span>
  );
}


type Stage = "questions" | "processing" | "results" | "cart";

// ── MOTOFIX circular-rings scanning splash (same look as the mechanic-request animation) ──
function RingsScanner() {
  return (
    <div style={{ position: "relative", width: 168, height: 168, margin: "0 auto" }}>
      <div style={{ position: "absolute", inset: 0 }}>
        <svg width="168" height="168" viewBox="0 0 168 168" fill="none">
          <circle cx="84" cy="84" r="80" stroke={`${AMBER}30`} strokeWidth="1" strokeDasharray="8 6" />
        </svg>
      </div>
      <div style={{ position: "absolute", inset: 0, animation: "mb-spincw 1.8s linear infinite" }}>
        <svg width="168" height="168" viewBox="0 0 168 168" fill="none">
          <circle cx="84" cy="84" r="76" stroke={AMBER} strokeWidth="2.5" strokeLinecap="round" strokeDasharray="95 382" style={{ filter: `drop-shadow(0 0 6px ${AMBER}bb)` }} />
        </svg>
      </div>
      <div style={{ position: "absolute", inset: 26, animation: "mb-spinccw 3.2s linear infinite" }}>
        <svg width="116" height="116" viewBox="0 0 116 116" fill="none">
          <circle cx="58" cy="58" r="54" stroke={`${AMBER}44`} strokeWidth="1.5" strokeDasharray="5 9" />
        </svg>
      </div>
      <div style={{ position: "absolute", inset: 46, animation: "mb-spincw 1.1s linear infinite" }}>
        <svg width="76" height="76" viewBox="0 0 76 76" fill="none">
          <circle cx="38" cy="38" r="34" stroke={`${AMBER}66`} strokeWidth="2" strokeLinecap="round" strokeDasharray="32 182" />
        </svg>
      </div>
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: 76, height: 76, borderRadius: 20, background: "var(--page-bg)", border: `2px solid ${AMBER}dd`, boxShadow: `0 0 0 1px ${AMBER}22, 0 0 24px ${AMBER}88, 0 0 48px ${AMBER}33`, display: "flex", alignItems: "center", justifyContent: "center", animation: "mb-badge 2s ease-in-out infinite" }}>
          <img src="/motofix-logo.png" alt="MOTOFIX" style={{ width: 60, height: 60, objectFit: "contain" }} onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
        </div>
      </div>
    </div>
  );
}

export default function SparePartsDealer() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isDark } = useTheme();
  const mapRef = useRef<LeafletMap | null>(null);
  const [routeTo, setRouteTo] = useState<SimDealer | null>(null);
  const [directions, setDirections] = useState<LL[] | null>(null);
  const [routeInfo, setRouteInfo] = useState<{ distance: string; duration: string } | null>(null);
  const routeState = useLocation().state as { lat?: number; lng?: number; address?: string; order?: { fault_category?: string; fault_label?: string; parts: { name: string; price_min: number; price_max: number }[] } } | null;
  const firstName = user?.full_name?.trim().split(/\s+/)[0] || "there";
  const preOrder = routeState?.order;

  const [stage, setStage] = useState<Stage>(preOrder?.parts?.length ? "processing" : "questions");
  const [tab, setTab] = useState<"selffix" | "parts">("parts");
  const [qIndex, setQIndex] = useState(0);
  const [picked, setPicked] = useState<string[]>([]);
  const [customItems, setCustomItems] = useState<string[]>([]);
  const [otherInput, setOtherInput] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [priced, setPriced] = useState<PartPriceItem[]>(preOrder?.parts?.length ? preOrder.parts.map((p) => ({ name: p.name, price_min: p.price_min, price_max: p.price_max, note: null })) : []);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(routeState?.lat != null && routeState?.lng != null ? { lat: routeState.lat, lng: routeState.lng } : null);
  const [dealers, setDealers] = useState<SimDealer[]>([]);
  const dealerMapPoints = useMemo<LL[]>(
    () => [...(coords ? [coords] : []), ...dealers.slice(0, 10).map((d) => ({ lat: d.lat, lng: d.lng }))],
    [coords, dealers],
  );
  const [selected, setSelected] = useState<SimDealer | null>(null);
  const [heroIdx, setHeroIdx] = useState(0);
  const [ordersOpen, setOrdersOpen] = useState(false);
  const [orders, setOrders] = useState<PartsOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [procMsg, setProcMsg] = useState(0);
  // delivery checkout
  const [qty, setQty] = useState<Record<string, number>>({});
  const [carModel, setCarModel] = useState("");
  const [payOpen, setPayOpen] = useState(false);
  const [payPhone, setPayPhone] = useState<string>(((user as { phone_number?: string; phone?: string } | null)?.phone_number || (user as { phone?: string } | null)?.phone || ""));
  const [payState, setPayState] = useState<"idle" | "sending" | "done">("idle");

  const items = useMemo(() => [...picked, ...customItems], [picked, customItems]);
  const q = QUESTIONS[qIndex];

  const togglePick = (p: string) => setPicked((s) => (s.includes(p) ? s.filter((x) => x !== p) : [...s, p]));
  const addCustom = () => {
    const v = otherInput.trim();
    if (!v) return;
    if (![...picked, ...customItems].some((x) => x.toLowerCase() === v.toLowerCase())) setCustomItems((s) => [...s, v]);
    setOtherInput("");
  };
  const removeCustom = (v: string) => setCustomItems((s) => s.filter((x) => x !== v));

  const advance = useCallback(() => {
    if (qIndex < QUESTIONS.length - 1) setQIndex((i) => i + 1);
    else setStage("processing");
  }, [qIndex]);
  const answerSingle = (val: string) => {
    setAnswers((a) => ({ ...a, [q.id]: val }));
    setTimeout(advance, 280);
  };

  useEffect(() => {
    if (stage !== "processing") return;
    setProcMsg(0);
    const deliver = (answers.fulfilment || "").toLowerCase().includes("deliver");
    const msgT = setInterval(() => setProcMsg((i) => Math.min(i + 1, PROC_MSGS.length)), 800);
    const started = Date.now();
    let done = false;
    const finish = (pr: PartPriceItem[], c: { lat: number; lng: number } | null, dl: SimDealer[]) => {
      if (done) return;
      done = true;
      if (pr.length) setPriced(pr);
      if (c) setCoords(c);
      if (dl.length) setDealers(dl);
      const wait = Math.max(0, 3600 - (Date.now() - started));
      setTimeout(() => {
        clearInterval(msgT);
        setStage(deliver ? "cart" : "results");
      }, wait);
    };
    (async () => {
      let pr = priced;
      if (MOTOBOT_ENABLED && !pr.length && items.length) {
        try {
          const res = await motobotService.priceItems(items);
          pr = res.data.items?.length ? res.data.items : items.map((n) => ({ name: n, price_min: 0, price_max: 0, note: null }));
        } catch {
          pr = items.map((n) => ({ name: n, price_min: 0, price_max: 0, note: null }));
        }
      }
      // Delivery → straight to the shopping cart (no map / no dealer pick).
      if (deliver) {
        finish(pr, coords, []);
        return;
      }
      let c = coords;
      if (!c && "geolocation" in navigator) {
        c = await new Promise<{ lat: number; lng: number } | null>((resolve) =>
          navigator.geolocation.getCurrentPosition(
            (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
            () => resolve(null),
            { enableHighAccuracy: true, timeout: 10000 },
          ),
        );
      }
      let dl: SimDealer[] = [];
      if (c) {
        try {
          // Admin-registered dealer directory first — these are the real businesses.
          const res = await dealerService.searchNearby(c.lat, c.lng);
          const raw = res.data?.dealers ?? [];
          dl = raw.length
            ? raw
                .map((d) =>
                  enrichDealer({
                    place_id: `dealer-${d.id}`,
                    name: d.name,
                    vicinity: d.address || d.location || "Kampala",
                    lat: d.latitude ?? c!.lat,
                    lng: d.longitude ?? c!.lng,
                    distance_km: d.distance_km ?? 0,
                    phone: d.phone || null,
                    category: "",
                    specialization: d.specialty || null,
                    tagline: d.description || null,
                  }),
                )
                .sort((a, b) => a.distance_km - b.distance_km)
            : generateSimDealers(c);
        } catch {
          dl = generateSimDealers(c);
        }
      }
      finish(pr, c, dl);
    })();
    return () => clearInterval(msgT);
  }, [stage]); // eslint-disable-line react-hooks/exhaustive-deps

  const openDealer = (d: SimDealer) => {
    setSelected(d);
    setHeroIdx(0);
  };
  const imgsOf = (d: SimDealer) => (d.photos.length ? d.photos : d.art);
  const wantsDelivery = (answers.fulfilment || "").toLowerCase().includes("deliver");

  const placeOrder = useCallback(() => {
    if (!selected) return;
    const ctx = answers.vehicle || "";
    const lines = [`Hello ${selected.name}, I'd like to order spare parts via MOTOFIX.`, ""];
    if (ctx) lines.push(`For: ${ctx}`, "");
    if (priced.length) {
      lines.push("Parts needed:");
      priced.forEach((p) => lines.push(`• ${p.name}${p.price_min || p.price_max ? ` (est. ${range(p.price_min, p.price_max)})` : ""}`));
    }
    if (coords) lines.push("", `My location: https://www.openstreetmap.org/?mlat=${coords.lat}&mlon=${coords.lng}#map=16/${coords.lat}/${coords.lng}`);
    lines.push("", "Are these available, and how much in total?");
    const text = encodeURIComponent(lines.join("\n"));
    const digits = waDigits(selected.whatsapp || selected.phone);
    window.open(digits ? `https://wa.me/${digits}?text=${text}` : `https://wa.me/?text=${text}`, "_blank");
    const min = priced.reduce((s, p) => s + (p.price_min || 0), 0),
      max = priced.reduce((s, p) => s + (p.price_max || 0), 0);
    partsService
      .createOrder({
        fault_category: preOrder?.fault_category ?? undefined,
        fault_label: ctx ? `Spare parts · ${ctx}` : "Spare parts",
        parts: priced.map((p) => ({ name: p.name, price_min: p.price_min, price_max: p.price_max, qty: 1 })),
        dealer_name: selected.name,
        dealer_phone: selected.phone,
        dealer_place_id: selected.place_id,
        estimated_total_min: min || null,
        estimated_total_max: max || null,
      })
      .then(() => toast.success("Order saved to your history"))
      .catch(() => {});
  }, [selected, priced, coords, answers, preOrder?.fault_category]);

  const requestDelivery = useCallback(() => {
    if (!selected) return;
    const ctx = answers.vehicle || "";
    const lines = [`Hello ${selected.name}, I'd like to *request delivery* of spare parts via MOTOFIX.`, ""];
    if (ctx) lines.push(`For: ${ctx}`, "");
    if (priced.length) {
      lines.push("Parts needed:");
      priced.forEach((p) => lines.push(`• ${p.name}${p.price_min || p.price_max ? ` (est. ${range(p.price_min, p.price_max)})` : ""}`));
    }
    if (coords) lines.push("", `Please deliver to my location: https://www.openstreetmap.org/?mlat=${coords.lat}&mlon=${coords.lng}#map=16/${coords.lat}/${coords.lng}`);
    else lines.push("", "Please advise on delivery to my location.");
    lines.push("", "How much for the parts + delivery, and how soon can you get here?");
    const text = encodeURIComponent(lines.join("\n"));
    const digits = waDigits(selected.whatsapp || selected.phone);
    window.open(digits ? `https://wa.me/${digits}?text=${text}` : `https://wa.me/?text=${text}`, "_blank");
    const min = priced.reduce((s, p) => s + (p.price_min || 0), 0),
      max = priced.reduce((s, p) => s + (p.price_max || 0), 0);
    partsService
      .createOrder({
        fault_category: preOrder?.fault_category ?? undefined,
        fault_label: ctx ? `Spare parts (delivery) · ${ctx}` : "Spare parts delivery",
        parts: priced.map((p) => ({ name: p.name, price_min: p.price_min, price_max: p.price_max, qty: 1 })),
        dealer_name: selected.name,
        dealer_phone: selected.phone,
        dealer_place_id: selected.place_id,
        estimated_total_min: min || null,
        estimated_total_max: max || null,
      })
      .then(() => toast.success("Delivery request saved to your history"))
      .catch(() => {});
  }, [selected, priced, coords, answers, preOrder?.fault_category]);

  // Show an estimated straight-line route and keep distance/ETA estimates local.
  const showDirections = (d: SimDealer) => {
    if (!coords) {
      toast.error("We need your location to draw the route.");
      return;
    }
    setSelected(null);
    setRouteTo(d);
    const destination = { lat: d.lat, lng: d.lng };
    setDirections([coords, destination]);
    const distanceKm = Math.max(haversineKm(coords, destination), d.distance_km || 0);
    const durationMinutes = Math.max(1, Math.round((distanceKm / 30) * 60));
    setRouteInfo({
      distance: `${distanceKm.toFixed(1)} km`,
      duration: durationMinutes < 60
        ? `${durationMinutes} min`
        : `${Math.floor(durationMinutes / 60)} hr ${durationMinutes % 60} min`,
    });
  };
  const closeDirections = () => {
    setRouteTo(null);
    setDirections(null);
    setRouteInfo(null);
  };

  // ── Delivery checkout (shopping cart + 50/50 deposit) ──
  const qOf = (name: string) => qty[name] ?? 1;
  const setQ = (name: string, d: number) => setQty((m) => ({ ...m, [name]: Math.max(1, (m[name] ?? 1) + d) }));
  const unitPrice = (p: PartPriceItem) => {
    const lo = p.new_min || p.price_min || 0;
    const hi = p.new_max || p.price_max || 0;
    const mid = (lo + hi) / 2;
    return mid ? Math.max(500, Math.round(mid / 500) * 500) : 0;
  };
  const subtotal = priced.reduce((s, p) => s + unitPrice(p) * qOf(p.name), 0);
  const cartTotal = subtotal ? subtotal + DELIVERY_FEE : 0;
  const deposit = cartTotal ? Math.round(cartTotal / 2 / 500) * 500 : 0;
  const balance = cartTotal - deposit;

  const payDeposit = () => {
    if (payState === "sending") return;
    setPayState("sending");
    partsService
      .createOrder({
        fault_category: preOrder?.fault_category ?? undefined,
        fault_label: `Spare-parts delivery · ${[answers.vehicle, carModel].filter(Boolean).join(" ")}`.trim(),
        parts: priced.map((p) => ({ name: p.name, price_min: unitPrice(p), price_max: unitPrice(p), qty: qOf(p.name) })),
        dealer_name: "MOTOFIX Delivery",
        dealer_phone: "",
        dealer_place_id: "motofix-delivery",
        estimated_total_min: cartTotal || null,
        estimated_total_max: cartTotal || null,
      })
      .catch(() => {});
    // MoMo deposit prompt — approve-on-phone step (demo simulation)
    setTimeout(() => setPayState("done"), 1700);
  };

  const openOrders = () => {
    setOrdersOpen(true);
    setOrdersLoading(true);
    partsService
      .listOrders()
      .then((r) => setOrders(r.data || []))
      .catch(() => setOrders([]))
      .finally(() => setOrdersLoading(false));
  };

  // ── theme tokens (match the rest of the app) ──
  const pageBg = "var(--page-bg)";
  const surface = "var(--surface-1)";
  const surface2 = "var(--surface-2)";
  const textHi = "var(--text-hi)";
  const textMd = "var(--text-md)";
  const textLo = "var(--text-dim)";
  const border = "var(--border-2)";

  // ════════ PROCESSING — full-screen scanner ════════
  if (stage === "processing") {
    return (
      <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: DRIVER_NAV_CLEARANCE, overflow: "hidden", background: pageBg, display: "flex", flexDirection: "column", boxSizing: "border-box" }}>
        <div style={{ position: "relative", zIndex: 5, flexShrink: 0, display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", paddingTop: "max(14px, env(safe-area-inset-top, 14px))" }}>
          <button onClick={() => setStage("questions")} style={{ width: 36, height: 36, borderRadius: 10, border: "none", cursor: "pointer", background: surface, color: textHi, boxShadow: "0 2px 8px rgba(0,0,0,0.08)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <ArrowLeft size={18} />
          </button>
          <div style={{ flex: 1, fontSize: 12, fontWeight: 800, letterSpacing: "0.26em", color: AMBER_D }}>
            {MOTOBOT_ENABLED ? "MOTOFIX · MOTOBOT" : "MOTOFIX · SPARE PARTS"}
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 18px 26px" }}>
          <div style={{ maxWidth: 380, width: "100%", margin: "0 auto", display: "flex", flexDirection: "column", alignItems: "center" }}>
            <RingsScanner />
            <h2 style={{ fontSize: 21, fontWeight: 900, color: textHi, margin: "22px 0 18px", textAlign: "center" }}>Finding spare-part dealers near you…</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 13, alignItems: "flex-start" }}>
              {PROC_MSGS.map((m, i) => {
                const done = i < procMsg;
                const active = i === procMsg;
                return (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, opacity: done || active ? 1 : 0.42, transition: "opacity 0.35s" }}>
                    <span style={{ width: 26, height: 26, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: done ? AMBER : "transparent", border: done ? "none" : `2px solid ${active ? AMBER : textLo}` }}>
                      {done ? <Check size={15} style={{ color: "#fff" }} /> : active ? <Loader2 size={15} className="mb-spin" style={{ color: AMBER_D }} /> : <span style={{ width: 7, height: 7, borderRadius: "50%", background: textLo }} />}
                    </span>
                    <span style={{ fontSize: 14.5, fontWeight: done || active ? 700 : 600, color: done ? textHi : active ? AMBER_D : textMd }}>{m}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <Styles />
      </div>
    );
  }

  // ════════ HUB — Self-Fix guides · MOTOBOT · Order parts (resembles the mechanic app) ════════
  if (stage === "questions") {
    const TABS: { id: "selffix" | "motobot" | "parts"; label: string; Icon: ElementType }[] = [
      { id: "selffix", label: "Self-Fix", Icon: Wrench },
      ...(MOTOBOT_ENABLED ? [{ id: "motobot" as const, label: "MOTOBOT", Icon: Bot }] : []),
      { id: "parts", label: "Order Parts", Icon: ShoppingBag },
    ];
    return (
      <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: DRIVER_NAV_CLEARANCE, width: "min(100%, 480px)", margin: "0 auto", background: pageBg, display: "flex", flexDirection: "column", boxSizing: "border-box" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", background: "var(--header-bg)", borderBottom: `1px solid ${border}`, flexShrink: 0, paddingTop: "max(14px, env(safe-area-inset-top, 14px))" }}>
          <button onClick={() => navigate(-1)} style={{ width: 38, height: 38, borderRadius: 12, flexShrink: 0, background: surface2, border: `1px solid ${border}`, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
            <ArrowLeft style={{ width: 18, height: 18, color: textHi }} />
          </button>
          <div style={{ flex: 1 }}>
            <p style={{ color: textHi, fontWeight: 900, fontSize: 17, lineHeight: 1 }}>Spare Parts &amp; Self-Fix</p>
            <p style={{ color: textLo, fontSize: 11, marginTop: 2 }}>
              {MOTOBOT_ENABLED ? 'Self-fix guides · MOTOBOT · Order parts' : 'Self-fix guides · Order parts'}
            </p>
          </div>
          <div style={{ width: 38, height: 38, borderRadius: 12, flexShrink: 0, background: `${AMBER}18`, border: `1px solid ${AMBER}40`, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <ShoppingBag style={{ width: 18, height: 18, color: AMBER }} />
          </div>
        </div>
        {/* Tab bar */}
        <div style={{ display: "flex", borderBottom: `1px solid ${border}`, flexShrink: 0, background: "var(--bg)" }}>
          {TABS.map(({ id, label, Icon }) => {
            const active = id !== "motobot" && tab === id;
            return (
              <button key={id} onClick={() => { if (id === "motobot") navigate("/fault-chat"); else setTab(id); }} style={{
                flex: 1, height: 46, background: "transparent", border: "none",
                borderBottom: active ? `2px solid ${AMBER}` : "2px solid transparent",
                color: active ? AMBER : textLo, fontWeight: active ? 800 : 600,
                fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
              }}>
                <Icon style={{ width: 15, height: 15 }} /> {label}
              </button>
            );
          })}
        </div>
        {/* Content */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", WebkitOverflowScrolling: "touch" }}>
          {tab === "selffix" && <SelfFixGuides />}
          {tab === "parts" && <OrderPartsShop />}
        </div>
        <Styles />
      </div>
    );
  }

  // ════════ DELIVERY CHECKOUT (cart) ════════
  if (stage === "cart") {
    const canPay = !!carModel.trim() && cartTotal > 0;
    return (
      <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: DRIVER_NAV_CLEARANCE, background: pageBg, display: "flex", flexDirection: "column", boxSizing: "border-box" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", paddingTop: "max(12px, env(safe-area-inset-top, 12px))", flexShrink: 0, background: surface, borderBottom: `1px solid ${border}` }}>
          <button onClick={() => { setQIndex(QUESTIONS.length - 1); setStage("questions"); }} style={{ width: 36, height: 36, borderRadius: 10, border: "none", cursor: "pointer", background: surface2, color: textHi, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <ArrowLeft size={18} />
          </button>
          <div style={{ width: 32, height: 32, borderRadius: "50%", background: AMBER_GRAD, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <ShoppingBag size={17} style={{ color: "#fff" }} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: textHi }}>Your delivery order</div>
            <div style={{ fontSize: 11, color: textLo }}>Delivered to you · pay 50% now, 50% on delivery</div>
          </div>
          <button onClick={openOrders} title="My orders" style={{ width: 34, height: 34, borderRadius: 10, border: "none", cursor: "pointer", background: surface2, color: textHi, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <ReceiptText size={16} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          <div style={{ background: surface, border: `1px solid ${border}`, borderRadius: 16, padding: 16, marginBottom: 14 }}>
            <div style={{ fontSize: 12.5, fontWeight: 800, color: textHi, marginBottom: 10 }}>Your car</div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: AMBER_D, background: "rgba(245,158,11,0.12)", border: `1px solid ${AMBER}44`, borderRadius: 20, padding: "5px 12px" }}>{answers.vehicle || "Car"}</span>
              <span style={{ fontSize: 11.5, color: textLo }}>Brand selected earlier</span>
            </div>
            <label style={{ fontSize: 11.5, fontWeight: 700, color: textMd, display: "block", marginBottom: 6 }}>Which model? <span style={{ color: "#EF4444" }}>*</span></label>
            <input value={carModel} onChange={(e) => setCarModel(e.target.value)} placeholder="e.g. Corolla, Premio, Noah, Wish…" style={{ width: "100%", boxSizing: "border-box", height: 44, borderRadius: 12, border: `1.5px solid ${border}`, background: surface2, color: textHi, padding: "0 12px", fontSize: 13.5, outline: "none" }} />
            <div style={{ fontSize: 10.5, color: textLo, marginTop: 6 }}>We need the exact model so the supplier sends parts that fit.</div>
          </div>

          <div style={{ background: surface, border: `1px solid ${border}`, borderRadius: 16, padding: 16, marginBottom: 14 }}>
            <div style={{ fontSize: 12.5, fontWeight: 800, color: textHi, marginBottom: 12 }}>Your cart</div>
            {priced.length === 0 && <div style={{ fontSize: 13, color: textLo }}>No parts selected.</div>}
            {priced.map((p, i) => {
              const u = unitPrice(p);
              return (
                <div key={i} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, paddingBottom: 12, marginBottom: 12, borderBottom: i < priced.length - 1 ? `1px solid ${border}` : "none" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: textHi }}>{p.name}</div>
                    <div style={{ fontSize: 11.5, color: textLo, marginTop: 2 }}>{u ? `${fmtUGX(u)} each` : "Price on request"}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", border: `1px solid ${border}`, borderRadius: 10, overflow: "hidden" }}>
                    <button onClick={() => setQ(p.name, -1)} style={{ width: 30, height: 30, border: "none", background: surface2, color: textHi, cursor: "pointer", fontSize: 17, fontWeight: 800, lineHeight: 1 }}>−</button>
                    <span style={{ minWidth: 26, textAlign: "center", fontSize: 13, fontWeight: 800, color: textHi }}>{qOf(p.name)}</span>
                    <button onClick={() => setQ(p.name, 1)} style={{ width: 30, height: 30, border: "none", background: surface2, color: textHi, cursor: "pointer", fontSize: 16, fontWeight: 800, lineHeight: 1 }}>+</button>
                  </div>
                  <div style={{ minWidth: 74, textAlign: "right", fontSize: 13, fontWeight: 800, color: AMBER_D }}>{u ? fmtUGX(u * qOf(p.name)) : "—"}</div>
                </div>
              );
            })}
          </div>

          <div style={{ background: surface, border: `1px solid ${border}`, borderRadius: 16, padding: 16, marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: textMd, marginBottom: 8 }}><span>Subtotal</span><span style={{ fontWeight: 700, color: textHi }}>{fmtUGX(subtotal)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: textMd }}><span>Delivery fee</span><span style={{ fontWeight: 700, color: textHi }}>{subtotal ? fmtUGX(DELIVERY_FEE) : "—"}</span></div>
            <div style={{ height: 1, background: border, margin: "10px 0" }} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, fontWeight: 900, color: textHi }}><span>Total</span><span>{fmtUGX(cartTotal)}</span></div>
            <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
              <div style={{ flex: 1, padding: "10px 12px", borderRadius: 12, background: "rgba(245,158,11,0.12)", border: `1px solid ${AMBER}44` }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: textLo }}>PAY NOW (50%)</div>
                <div style={{ fontSize: 15, fontWeight: 900, color: AMBER_D }}>{fmtUGX(deposit)}</div>
              </div>
              <div style={{ flex: 1, padding: "10px 12px", borderRadius: 12, background: surface2, border: `1px solid ${border}` }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: textLo }}>ON DELIVERY (50%)</div>
                <div style={{ fontSize: 15, fontWeight: 900, color: textHi }}>{fmtUGX(balance)}</div>
              </div>
            </div>
          </div>
          <div style={{ fontSize: 10.5, color: textLo, lineHeight: 1.5, padding: "0 4px" }}>
            {MOTOBOT_ENABLED ? "Prices are MOTOBOT estimates" : "Prices are catalogue estimates"}; the supplier confirms the final amount before delivery. A 50% deposit secures your order — the balance is paid on delivery.
          </div>
        </div>

        <div style={{ flexShrink: 0, padding: 12, borderTop: `1px solid ${border}`, background: surface }}>
          <button onClick={() => canPay && setPayOpen(true)} disabled={!canPay} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "15px 0", borderRadius: 14, border: "none", cursor: canPay ? "pointer" : "not-allowed", background: canPay ? AMBER_GRAD : surface2, color: canPay ? "#fff" : textLo, fontSize: 14.5, fontWeight: 800 }}>
            <Truck size={17} /> {canPay ? `Pay ${fmtUGX(deposit)} deposit & order` : !carModel.trim() ? "Enter your car model to continue" : "Add parts to continue"}
          </button>
        </div>

        {payOpen && (
          <div style={{ position: "absolute", inset: 0, zIndex: 60, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "flex-end" }} onClick={() => payState === "idle" && setPayOpen(false)}>
            <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxHeight: "calc(100dvh - 120px - env(safe-area-inset-bottom, 0px))", overflowY: "auto", overscrollBehavior: "contain", boxSizing: "border-box", background: surface, borderRadius: "22px 22px 0 0", padding: 20, paddingBottom: "max(20px, env(safe-area-inset-bottom, 20px))", boxShadow: "0 -16px 56px rgba(0,0,0,0.32)" }}>
              {payState === "done" ? (
                <div style={{ textAlign: "center", padding: "8px 0" }}>
                  <div style={{ width: 56, height: 56, borderRadius: "50%", background: "rgba(16,185,129,0.14)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}>
                    <Check size={30} style={{ color: "#10B981" }} />
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 900, color: textHi, marginBottom: 6 }}>Order placed!</div>
                  <div style={{ fontSize: 13, color: textMd, lineHeight: 1.5, marginBottom: 18 }}>Deposit of <strong style={{ color: AMBER_D }}>{fmtUGX(deposit)}</strong> received. The supplier will prepare your parts and deliver to you — pay the balance of <strong>{fmtUGX(balance)}</strong> on delivery.</div>
                  <button onClick={() => { setPayOpen(false); openOrders(); }} style={{ width: "100%", padding: "14px 0", borderRadius: 14, border: "none", cursor: "pointer", background: AMBER_GRAD, color: "#fff", fontSize: 14, fontWeight: 800 }}>View my orders</button>
                </div>
              ) : (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                    <div style={{ fontSize: 16, fontWeight: 900, color: textHi }}>Pay 50% deposit</div>
                    <button onClick={() => payState !== "sending" && setPayOpen(false)} style={{ width: 30, height: 30, borderRadius: 8, border: "none", cursor: "pointer", background: surface2, color: textHi, display: "flex", alignItems: "center", justifyContent: "center" }}><X size={16} /></button>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 12px", borderRadius: 12, background: "rgba(245,158,11,0.1)", border: `1px solid ${AMBER}33`, marginBottom: 14 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: textHi }}>Deposit due now</span>
                    <span style={{ fontSize: 15, fontWeight: 900, color: AMBER_D }}>{fmtUGX(deposit)}</span>
                  </div>
                  <label style={{ fontSize: 11.5, fontWeight: 700, color: textMd, display: "block", marginBottom: 6 }}>Mobile Money number</label>
                  <input value={payPhone} onChange={(e) => setPayPhone(e.target.value)} placeholder="07XX XXX XXX" inputMode="tel" style={{ width: "100%", boxSizing: "border-box", height: 46, borderRadius: 12, border: `1.5px solid ${border}`, background: surface2, color: textHi, padding: "0 12px", fontSize: 14, outline: "none", marginBottom: 14 }} />
                  <button onClick={payDeposit} disabled={payState === "sending" || !payPhone.trim()} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "15px 0", borderRadius: 14, border: "none", cursor: payState === "sending" || !payPhone.trim() ? "not-allowed" : "pointer", background: payState === "sending" || !payPhone.trim() ? surface2 : "#25D366", color: payState === "sending" || !payPhone.trim() ? textLo : "#fff", fontSize: 14.5, fontWeight: 800 }}>
                    {payState === "sending" ? (<><Loader2 size={17} className="sp-spin2" /> Check your phone to approve…</>) : (<>Pay {fmtUGX(deposit)} via MoMo</>)}
                  </button>
                  <div style={{ fontSize: 10.5, color: textLo, textAlign: "center", marginTop: 10 }}>A payment prompt is sent to your phone. The balance {fmtUGX(balance)} is paid on delivery.</div>
                </>
              )}
            </div>
            <style>{`@keyframes sp-spin2 { to { transform: rotate(360deg); } } .sp-spin2 { animation: sp-spin2 0.9s linear infinite; }`}</style>
          </div>
        )}
      </div>
    );
  }

  // ════════ RESULTS ════════
  return (
    <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: DRIVER_NAV_CLEARANCE, background: pageBg, display: "flex", flexDirection: "column", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", paddingTop: "max(12px, env(safe-area-inset-top, 12px))", flexShrink: 0, background: surface, borderBottom: `1px solid ${border}` }}>
        <button onClick={() => navigate(-1)} style={{ width: 36, height: 36, borderRadius: 10, border: "none", cursor: "pointer", background: surface2, color: textHi, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <ArrowLeft size={18} />
        </button>
        <div style={{ width: 32, height: 32, borderRadius: "50%", background: AMBER_GRAD, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Store size={17} style={{ color: "#fff" }} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: textHi }}>Spare-part dealers near you</div>
          <div style={{ fontSize: 11, color: textLo }}>
            {Math.min(dealers.length, 10)} closest · {priced.length} part{priced.length === 1 ? "" : "s"} priced
          </div>
        </div>
        <button onClick={openOrders} title="My orders" style={{ width: 34, height: 34, borderRadius: 10, border: "none", cursor: "pointer", background: surface2, color: textHi, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <ReceiptText size={16} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        <div className="sp-map" style={{ position: "relative", height: "clamp(240px,42dvh,540px)", borderRadius: 16, overflow: "hidden", border: `1px solid ${border}`, marginBottom: 16 }}>
          <style>{LEAFLET_BASE_CSS}</style>
          <MapContainer
            center={coords ?? KAMPALA}
            zoom={13}
            style={{ width: "100%", height: "100%" }}
            scrollWheelZoom
          >
            <MapViewport mapRef={mapRef} center={coords ?? KAMPALA} points={dealerMapPoints} />
            <OpenFreeMapLayer />
            {coords && (
              <Marker position={coords} icon={driverLeafletIcon}>
                <Popup>Your location</Popup>
              </Marker>
            )}
            {dealers.slice(0, 10).map((d) => (
              <Marker
                key={d.place_id}
                position={{ lat: d.lat, lng: d.lng }}
                icon={dealerLeafletIcon}
                eventHandlers={{ click: () => openDealer(d) }}
              >
                <Popup>
                  <strong>{d.name}</strong>
                  <br />
                  {d.vicinity}
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        </div>
        {priced.length > 0 && (
          <div style={{ background: surface, border: `1px solid ${border}`, borderRadius: 16, padding: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: textHi, marginBottom: 10 }}>Estimated prices in Kampala</div>
            {priced.map((p, i) => {
              const lo = p.price_min || p.new_min || p.used_min || 0;
              const hi = p.price_max || p.new_max || p.used_max || 0;
              return (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 10, paddingBottom: 8, marginBottom: 8, borderBottom: i < priced.length - 1 ? `1px solid ${border}` : "none" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: textHi }}>{p.name}</div>
                    {p.note && <div style={{ fontSize: 11, color: textLo }}>{p.note}</div>}
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 800, color: AMBER_D, whiteSpace: "nowrap" }}>{lo || hi ? range(lo, hi) : "—"}</span>
                </div>
              );
            })}
            <div style={{ fontSize: 10.5, color: textLo, lineHeight: 1.5 }}>Rough public estimates, not a binding quote. Used-part prices depend on the spare-parts supplier.</div>
          </div>
        )}
        <div style={{ fontSize: 13, fontWeight: 800, color: textHi, marginBottom: 10 }}>Dealers near you — tap to view &amp; order</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {dealers.slice(0, 10).map((d) => (
            <button key={d.place_id} onClick={() => openDealer(d)} style={{ display: "flex", alignItems: "center", gap: 12, padding: 10, borderRadius: 16, cursor: "pointer", textAlign: "left", background: surface, border: `1px solid ${border}` }}>
              <div style={{ width: 58, height: 58, borderRadius: 12, flexShrink: 0, overflow: "hidden", border: `1px solid ${border}` }}>
                <img
                  src={imgsOf(d)[0]}
                  alt={d.name}
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).src = d.art[0];
                  }}
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: textHi, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 2 }}>
                  <Stars rating={d.rating} size={11} />
                  <span style={{ fontSize: 11, color: AMBER, fontWeight: 700 }}>{d.rating.toFixed(1)}</span>
                  <span style={{ fontSize: 11, color: textLo }}>· {d.distance_km} km</span>
                </div>
                <div style={{ fontSize: 11, color: textLo, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.specialization}</div>
              </div>
              <ChevronRight size={16} style={{ color: textLo, flexShrink: 0 }} />
            </button>
          ))}
        </div>
      </div>

      {selected && (
        <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 45, background: surface, borderRadius: "24px 24px 0 0", maxHeight: "calc(100dvh - 120px - env(safe-area-inset-bottom, 0px))", overflowY: "auto", overscrollBehavior: "contain", boxShadow: "0 -16px 56px rgba(0,0,0,0.32)" }}>
          <div style={{ position: "relative", height: 188, overflow: "hidden", borderRadius: "24px 24px 0 0" }}>
            <img
              src={imgsOf(selected)[heroIdx] ?? selected.art[0]}
              alt={selected.name}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).src = selected.art[Math.min(heroIdx, selected.art.length - 1)];
              }}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
            <button onClick={() => setSelected(null)} style={{ position: "absolute", top: 12, right: 12, width: 34, height: 34, borderRadius: "50%", background: "rgba(0,0,0,0.52)", border: "none", cursor: "pointer", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <X size={16} />
            </button>
            <div style={{ position: "absolute", bottom: 10, left: 12, display: "flex", gap: 6 }}>
              {imgsOf(selected).map((a, i) => (
                <button key={i} onClick={() => setHeroIdx(i)} style={{ width: 34, height: 26, borderRadius: 6, overflow: "hidden", border: `2px solid ${i === heroIdx ? "#fff" : "rgba(255,255,255,0.5)"}`, cursor: "pointer", padding: 0, background: "none" }}>
                  <img
                    src={a}
                    alt=""
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).src = selected.art[Math.min(i, selected.art.length - 1)];
                    }}
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  />
                </button>
              ))}
            </div>
          </div>
          <div style={{ padding: "18px 16px 36px" }}>
            <h2 style={{ fontSize: 19, fontWeight: 800, color: textHi, margin: "0 0 6px" }}>{selected.name}</h2>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10, flexWrap: "wrap" }}>
              <Stars rating={selected.rating} size={14} />
              <span style={{ fontSize: 14, fontWeight: 700, color: AMBER }}>{selected.rating.toFixed(1)}</span>
              <span style={{ fontSize: 12, color: textLo }}>
                ({selected.user_ratings_total}) · {selected.distance_km} km away
              </span>
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "4px 11px",
                  borderRadius: 20,
                  fontSize: 11,
                  fontWeight: 700,
                  background: selected.open_now ? "rgba(16,185,129,0.12)" : "rgba(239,68,68,0.1)",
                  color: selected.open_now ? "#10B981" : "#EF4444",
                  border: `1px solid ${selected.open_now ? "rgba(16,185,129,0.3)" : "rgba(239,68,68,0.3)"}`,
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: selected.open_now ? "#10B981" : "#EF4444" }} />
                {selected.open_now ? "Open now" : "Closed"}
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 11px", borderRadius: 20, fontSize: 11, fontWeight: 700, background: "rgba(245,158,11,0.14)", color: AMBER_D, border: `1px solid ${AMBER}55` }}>
                <ShoppingBag size={11} /> {selected.specialization}
              </span>
            </div>
            <div style={{ display: "flex", gap: 9, alignItems: "flex-start", marginBottom: 8 }}>
              <MapPin size={14} style={{ color: AMBER, flexShrink: 0, marginTop: 2 }} />
              <span style={{ fontSize: 13, color: textMd, lineHeight: 1.5 }}>{selected.vicinity}</span>
            </div>
            <div style={{ display: "flex", gap: 9, alignItems: "center", marginBottom: 8 }}>
              <Clock size={14} style={{ color: AMBER, flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: textMd }}>{selected.hours}</span>
            </div>
            <div style={{ display: "flex", gap: 9, alignItems: "center", marginBottom: 16 }}>
              <Phone size={14} style={{ color: AMBER, flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: textMd }}>{selected.phone}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7, marginBottom: 18 }}>
              {selected.services.map((s, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 12.5, color: textMd }}>
                  <span style={{ fontSize: 15 }}>{s.icon}</span> {s.label}
                </div>
              ))}
            </div>
            {priced.length > 0 && (
              <div style={{ padding: "10px 12px", borderRadius: 12, marginBottom: 10, background: "rgba(245,158,11,0.1)", border: `1px solid ${AMBER}40` }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: AMBER_D, marginBottom: 4 }}>YOUR LIST</div>
                <div style={{ fontSize: 12, color: textMd, lineHeight: 1.5 }}>{priced.map((p) => p.name).join(", ")}</div>
              </div>
            )}
            {/* chosen mode banner */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", borderRadius: 12, marginBottom: 12, background: "rgba(245,158,11,0.1)", border: `1px solid ${AMBER}33`, fontSize: 12.5, fontWeight: 700, color: AMBER_D }}>
              {wantsDelivery ? <Truck size={15} /> : <Navigation size={15} />}
              {wantsDelivery ? "Delivery — the shop gets your live location" : "Pick-up — directions to the shop are ready"}
            </div>
            {/* PRIMARY action — follows the pickup/delivery choice */}
            {wantsDelivery ? (
              <button onClick={requestDelivery} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "15px 0", borderRadius: 14, border: "none", cursor: "pointer", background: AMBER_GRAD, color: "#fff", fontSize: 14.5, fontWeight: 800, marginBottom: 10 }}>
                <Truck size={17} /> Request delivery to my location
              </button>
            ) : (
              <button onClick={() => showDirections(selected)} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "15px 0", borderRadius: 14, border: "none", cursor: "pointer", background: AMBER_GRAD, color: "#fff", fontSize: 14.5, fontWeight: 800, marginBottom: 10 }}>
                <Navigation size={17} /> Get directions to the shop
              </button>
            )}
            {/* Order / enquire via WhatsApp — always available */}
            <button onClick={placeOrder} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "14px 0", borderRadius: 14, border: "none", cursor: "pointer", background: "#25D366", color: "#fff", fontSize: 14, fontWeight: 800, marginBottom: 10 }}>
              <MessageCircle size={17} /> {wantsDelivery ? "Message the shop on WhatsApp" : "Order via WhatsApp"}
            </button>
            {/* secondary row — Call + the other action */}
            <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
              <a
                href={`tel:${selected.phone.replace(/[\s\-()]/g, "")}`}
                style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "12px 0", borderRadius: 14, background: "rgba(245,158,11,0.14)", border: `1.5px solid ${AMBER}55`, color: AMBER_D, textDecoration: "none", fontSize: 13, fontWeight: 700 }}
              >
                <Phone size={15} /> Call
              </a>
              {wantsDelivery ? (
                <button onClick={() => showDirections(selected)} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "12px 0", borderRadius: 14, background: surface2, border: `1.5px solid ${border}`, color: textMd, cursor: "pointer", fontSize: 13, fontWeight: 700 }}>
                  <Navigation size={15} /> Directions
                </button>
              ) : (
                <button onClick={requestDelivery} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "12px 0", borderRadius: 14, background: surface2, border: `1.5px solid ${border}`, color: textMd, cursor: "pointer", fontSize: 13, fontWeight: 700 }}>
                  <Truck size={15} /> Delivery
                </button>
              )}
            </div>
            <a
              href={selected.online_store_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ width: "100%", boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "12px 0", borderRadius: 14, background: surface2, border: `1.5px solid ${border}`, color: textMd, textDecoration: "none", fontSize: 13, fontWeight: 700 }}
            >
              <Store size={15} /> Visit online store
            </a>
          </div>
        </div>
      )}

      {routeTo && (
        <div style={{ position: "absolute", inset: 0, zIndex: 60, background: pageBg, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", paddingTop: "max(12px, env(safe-area-inset-top, 12px))", flexShrink: 0, background: surface, borderBottom: `1px solid ${border}` }}>
            <button onClick={closeDirections} style={{ width: 36, height: 36, borderRadius: 10, border: "none", cursor: "pointer", background: surface2, color: textHi, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <ArrowLeft size={18} />
            </button>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14.5, fontWeight: 800, color: textHi, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Directions to {routeTo.name}</div>
              <div style={{ fontSize: 11.5, color: AMBER_D, fontWeight: 700 }}>{routeInfo ? `${routeInfo.distance} · ${routeInfo.duration} estimated drive` : "—"}</div>
            </div>
          </div>
          <div className="sp-map" style={{ flex: "0 0 46%", position: "relative" }}>
            <style>{LEAFLET_BASE_CSS}</style>
            <MapContainer
              center={coords ?? { lat: routeTo.lat, lng: routeTo.lng }}
              zoom={14}
              style={{ width: "100%", height: "100%" }}
              scrollWheelZoom
            >
              <MapViewport
                mapRef={mapRef}
                center={coords ?? { lat: routeTo.lat, lng: routeTo.lng }}
                points={directions ?? undefined}
              />
              <OpenFreeMapLayer />
              {coords && (
                <Marker position={coords} icon={driverLeafletIcon}>
                  <Popup>Your location</Popup>
                </Marker>
              )}
              <Marker position={{ lat: routeTo.lat, lng: routeTo.lng }} icon={dealerLeafletIcon}>
                <Popup>{routeTo.name}</Popup>
              </Marker>
              {directions && <Polyline positions={directions} pathOptions={{ color: AMBER, weight: 6, opacity: 0.95 }} />}
            </MapContainer>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
            {directions && (
              <>
                <div style={{ fontSize: 11, fontWeight: 800, color: textHi, marginBottom: 10, letterSpacing: "0.05em" }}>ROUTE ESTIMATE</div>
                <div style={{ fontSize: 13, color: textMd, lineHeight: 1.5, padding: "11px 0", borderBottom: `1px solid ${border}` }}>
                  Follow the highlighted straight-line route toward {routeTo.name}. Use local roads and signs to complete the trip.
                </div>
                <div style={{ display: "flex", gap: 12, padding: "11px 0", alignItems: "center" }}>
                  <span style={{ width: 24, height: 24, borderRadius: "50%", flexShrink: 0, background: AMBER, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <MapPin size={13} />
                  </span>
                  <div style={{ fontSize: 13, fontWeight: 700, color: textHi }}>Arrive at {routeTo.name}</div>
                </div>
              </>
            )}
          </div>
          {/* Optional external route using OpenStreetMap routing. */}
          <div style={{ flexShrink: 0, padding: 12, borderTop: `1px solid ${border}`, background: surface }}>
            <a
              href={`https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${coords ? `${coords.lat}%2C${coords.lng}%3B` : ""}${routeTo.lat}%2C${routeTo.lng}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ width: "100%", boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "13px 0", borderRadius: 14, background: surface2, border: `1.5px solid ${border}`, color: textMd, textDecoration: "none", fontSize: 13.5, fontWeight: 700 }}
            >
              <Navigation size={16} /> Open route in OpenStreetMap
            </a>
          </div>
          <style>{`
            @keyframes sp-spin { to { transform: rotate(360deg); } }
            .sp-spin { animation: sp-spin 0.9s linear infinite; }
          `}</style>
        </div>
      )}

      {ordersOpen && (
        <div style={{ position: "absolute", inset: 0, zIndex: 50, background: pageBg, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", paddingTop: "max(14px, env(safe-area-inset-top, 14px))", background: surface, borderBottom: `1px solid ${border}` }}>
            <button onClick={() => setOrdersOpen(false)} style={{ width: 36, height: 36, borderRadius: 10, border: "none", cursor: "pointer", background: surface2, color: textHi, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <ArrowLeft size={18} />
            </button>
            <div style={{ fontSize: 15, fontWeight: 700, color: textHi }}>My Parts Orders</div>
          </div>
          {ordersLoading ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Loader2 size={26} style={{ color: AMBER, animation: "mb-spin 1s linear infinite" }} />
            </div>
          ) : orders.length === 0 ? (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 32, textAlign: "center" }}>
              <ShoppingBag size={34} style={{ color: textLo, opacity: 0.6 }} />
              <div style={{ fontSize: 14, fontWeight: 700, color: textHi }}>No orders yet</div>
            </div>
          ) : (
            <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
              {orders.map((o) => (
                <div key={o.id} style={{ background: surface, borderRadius: 14, padding: 14, border: `1px solid ${border}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <ShoppingBag size={15} style={{ color: AMBER, flexShrink: 0 }} />
                    <span style={{ fontSize: 14, fontWeight: 700, color: textHi }}>{o.fault_label || "Spare parts"}</span>
                  </div>
                  {o.dealer_name && (
                    <div style={{ fontSize: 12.5, color: textMd, marginBottom: 4 }}>
                      Dealer: <strong>{o.dealer_name}</strong>
                    </div>
                  )}
                  <div style={{ fontSize: 12, color: textLo, marginBottom: 6 }}>{o.parts.map((p) => p.name).join(", ")}</div>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: textLo }}>
                    <Clock size={11} /> {new Date(o.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <Styles />
    </div>
  );
}

function Styles() {
  return (
    <style>{`
      @keyframes mb-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      @keyframes mb-floaty { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-13px); } }
      .mb-float { animation: mb-floaty 3s ease-in-out infinite; }
      @keyframes mb-sway { 0%,100% { transform: translateX(-16px); } 50% { transform: translateX(16px); } }
      .mb-sway { animation: mb-sway 5.5s ease-in-out infinite; }
      /* per-pose action animations (distinct behaviour each question) */
      .mb-act { transform-origin: 50% 92%; }
      @keyframes mb-nod { 0%,100% { transform: translateY(-3px) rotate(-1deg); } 50% { transform: translateY(7px) rotate(1deg); } }
      .mb-act-grad { animation: mb-nod 1.9s ease-in-out infinite; }
      @keyframes mb-curious { 0%,100% { transform: rotate(-3.5deg); } 50% { transform: rotate(3.5deg); } }
      .mb-act-curious { animation: mb-curious 3.2s ease-in-out infinite; }
      @keyframes mb-tilt { 0%,15%,100% { transform: rotate(-6deg); } 55%,70% { transform: rotate(6deg); } }
      .mb-act-think { animation: mb-tilt 3s ease-in-out infinite; }
      @keyframes mb-scan { 0%,100% { transform: translateX(-13px) rotate(-2deg); } 50% { transform: translateX(13px) rotate(2deg); } }
      .mb-act-detective { animation: mb-scan 1.9s ease-in-out infinite; }
      .mb-act-scan { animation: mb-scan 1.9s ease-in-out infinite; }
      @keyframes mb-radar { 0% { transform: scale(0.5); opacity: 0.6; } 100% { transform: scale(1.9); opacity: 0; } }
      .mb-radar { animation: mb-radar 1.6s ease-out infinite; }
      .mb-radar2 { animation: mb-radar 1.6s 0.8s ease-out infinite; }
      .mb-spin { animation: mb-spin 0.9s linear infinite; }
      @keyframes mb-spincw { to { transform: rotate(360deg); } }
      @keyframes mb-spinccw { to { transform: rotate(-360deg); } }
      @keyframes mb-badge { 0%,100% { box-shadow: 0 0 0 1px rgba(245,158,11,0.18), 0 0 24px rgba(245,158,11,0.5), 0 0 48px rgba(245,158,11,0.2); } 50% { box-shadow: 0 0 0 1px rgba(245,158,11,0.4), 0 0 40px rgba(245,158,11,0.68), 0 0 66px rgba(245,158,11,0.35); } }
      @keyframes mb-excite { 0%,100% { transform: scale(1) translateY(0) rotate(-2deg); } 50% { transform: scale(1.07) translateY(-8px) rotate(2deg); } }
      .mb-act-ready { animation: mb-excite 0.8s ease-in-out infinite; }
      @keyframes mb-chin { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
      .mb-chin { animation: mb-chin 1.6s ease-in-out infinite; }
      @keyframes mb-wavebig { 0%,100% { transform: rotate(-8deg); } 50% { transform: rotate(30deg); } }
      .mb-wavebig { animation: mb-wavebig 0.85s ease-in-out infinite; }
      @keyframes mb-salute { 0%,68%,100% { transform: rotate(0deg); } 80% { transform: rotate(-8deg); } 90% { transform: rotate(-3deg); } }
      .mb-salute { animation: mb-salute 3s ease-in-out infinite; }
      @keyframes mb-blink { 0%,92%,100% { transform: scaleY(1); } 96% { transform: scaleY(0.1); } }
      .mb-eye { transform-box: fill-box; transform-origin: center; animation: mb-blink 3.4s ease-in-out infinite; }
      @keyframes mb-antPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
      .mb-ant { transform-box: fill-box; transform-origin: center; animation: mb-antPulse 1.2s ease-in-out infinite; }
      @keyframes mb-wave { 0%,100% { transform: rotate(8deg); } 50% { transform: rotate(-24deg); } }
      .mb-wave { animation: mb-wave 1.5s ease-in-out infinite; }
      @keyframes mb-toolWave { 0%,100% { transform: rotate(-7deg); } 50% { transform: rotate(9deg); } }
      .mb-tool { animation: mb-toolWave 1.8s ease-in-out infinite; }
      @keyframes mb-think { 0%,100% { transform: translateY(0); opacity: 0.92; } 50% { transform: translateY(-4px); opacity: 1; } }
      .mb-think { animation: mb-think 2s ease-in-out infinite; }
      @keyframes mb-page { 0%,100% { transform: scaleX(1); } 50% { transform: scaleX(-1); } }
      .mb-page { transform-box: fill-box; transform-origin: left center; animation: mb-page 1.5s ease-in-out infinite; }
      .mb-page2 { transform-box: fill-box; transform-origin: left center; animation: mb-page 1.5s 0.75s ease-in-out infinite; }
      @keyframes mb-read { 0%,100% { transform: rotate(-1.5deg); } 50% { transform: rotate(1.5deg); } }
      .mb-act-files { animation: mb-read 3.4s ease-in-out infinite; }
      @keyframes mb-drift { 0%,100% { transform: translateY(0); opacity: 0.2; } 50% { transform: translateY(-26px); opacity: 0.5; } }
      @keyframes mb-bgfloat { 0%,100% { transform: translate(0,0); } 50% { transform: translate(7px,-22px); } }
      @keyframes mb-qIn { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes mb-load { from { width: 0; } to { width: 100%; } }
      .mb-loadbar { animation: mb-load 3.5s linear both; }
    `}</style>
  );
}
