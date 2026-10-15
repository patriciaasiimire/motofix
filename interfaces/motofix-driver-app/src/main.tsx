import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "leaflet/dist/leaflet.css";
import "./index.css";
import L from "leaflet";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import { AUTH_BASE_URL, REQUESTS_BASE_URL, MATCHING_BASE_URL, MECHANICS_BASE_URL } from "./config/api";
import { warmServices } from "./utils/warmup";

// Apply the theme before first paint (light is the default) to avoid a dark flash.
const theme = localStorage.getItem("motofix_theme2") || "light";
document.documentElement.classList.remove("dark", "light");
document.documentElement.classList.add(theme);

L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

// Render's free tier puts idle services to sleep. Wake them now, in the background, so
// that by the time the driver has typed a number, entered the code and picked an area,
// auth, dispatch, matching and mechanic verification are all awake.
const warmAll = () => warmServices([AUTH_BASE_URL, REQUESTS_BASE_URL, MATCHING_BASE_URL, MECHANICS_BASE_URL]);
warmAll();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") warmAll(); // throttled to once per 5 minutes
});

createRoot(document.getElementById("root")!).render(<App />);
