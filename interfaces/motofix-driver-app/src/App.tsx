// App.tsx — the root of the driver app.
//
// Two jobs:
//   1. AppContent below maps every URL to the page that should show (the <Routes>).
//      Pages wrapped in <PrivateRoute> require the user to be logged in; the rest
//      (splash, welcome, login, signup...) are public.
//   2. The App component at the bottom wraps everything in "providers" — shared
//      services any page can tap into. Order matters (outer wraps inner):
//        Theme (light/dark) → WebSocket (live server updates) → Request (the
//        driver's active/past requests). So a page can read requests, which can
//        react to WebSocket events, which respect the theme.
//
// New screen? Add its page import, then a <Route> here. The bottom nav is shown
// consistently on authenticated screens and omitted from public/auth screens.

import { useEffect } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Capacitor } from "@capacitor/core";
import { BrowserRouter, HashRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { BottomNav } from "@/components/BottomNav";
import { MotobotFab } from "@/components/MotobotFab";
import { PrivateRoute } from "@/components/PrivateRoute";
import { NetworkBanner } from "@/components/NetworkBanner";
import { RequestProvider, useRequests } from "@/contexts/RequestContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { WebSocketProvider } from "@/contexts/WebSocketContext";
import { AuthProvider, useAuth } from "@/hooks/useAuth";
import { useFcmToken } from "@/hooks/useFcmToken";
import { useReminderScheduler } from "@/hooks/useReminderScheduler";
import { MOTOBOT_ENABLED } from "@/config/features";
import { toast } from "sonner";
import Splash from "./pages/Splash";
import Welcome from "./pages/Welcome";
import DriverEntry from "./pages/DriverEntry";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import Verifying from "./pages/Verifying";
import Onboarding from "./pages/Onboarding";
import Home from "./pages/Home";
import RequestsList from "./pages/RequestsList";
import Profile from "./pages/Profile";
import RequestDetail from "./pages/RequestDetail";
import LocatingUser from "./pages/LocatingUser";
import DescribeIssue from "./pages/DescribeIssue";
import FaultChat from "./pages/FaultChat";
import GetHelp from "./pages/GetHelp";
import GetHelpLocation from "./pages/GetHelpLocation";
import NearbyMechanics from "./pages/NearbyMechanics";
import EmergencyAlert from "./pages/EmergencyAlert";
import InsurancePage from "./pages/InsurancePage";
import Reminders from "./pages/Reminders";
import ReminderSettings from "./pages/ReminderSettings";
import NotificationsPage from "./pages/Notifications";
import Settings from "./pages/Settings";
import TermsOfService from "./pages/TermsOfService";
import PrivacyPolicy from "./pages/PrivacyPolicy";
import RateMotofix from "./pages/RateMotofix";
import ContactSupport from "./pages/ContactSupport";
import DriverChat from "./pages/DriverChat";
import SparePartsDealer from "./pages/SparePartsDealer";
import PartsNeeded from "./pages/PartsNeeded";
import PartsOrders from "./pages/PartsOrders";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();
const AppRouter = Capacitor.isNativePlatform() ? HashRouter : BrowserRouter;

function AppContent() {
  const location = useLocation();
  const { isAuthenticated } = useAuth();
  const { requests } = useRequests();
  useEffect(() => {
    const toastId = 'motofix-api-retry';
    const handleRetryState = (event: Event) => {
      const active = (event as CustomEvent<{ active: boolean }>).detail.active;
      if (active) {
        toast.loading('Server is waking up, this can take up to a minute', { id: toastId, duration: Infinity });
      } else {
        toast.dismiss(toastId);
      }
    };
    window.addEventListener('motofix:api-retry', handleRetryState);
    return () => window.removeEventListener('motofix:api-retry', handleRetryState);
  }, []);
  useFcmToken(isAuthenticated);
  // Never fire reminder pop-ups on public/auth screens (splash, welcome, login,
  // signup, verifying, onboarding) — even if a stale token leaves isAuthenticated true.
  const onPublicScreen = ['/', '/welcome', '/driver-entry', '/login', '/signup', '/verifying', '/onboarding'].includes(location.pathname);
  // Don't interrupt an active job with reminder pop-ups. A job is "in progress" from
  // the moment a request is placed until it's done — i.e. any request that isn't yet
  // completed or cancelled (the post-completion rating modal fires on its own).
  const jobInProgress = requests.some((r) => r.status !== 'completed' && r.status !== 'cancelled');
  useReminderScheduler(isAuthenticated && !onPublicScreen && !jobInProgress);
  const publicNavExcludedRoutes = ['/', '/welcome', '/driver-entry', '/login', '/signup', '/verifying'];
  const showBottomNav = isAuthenticated && !publicNavExcludedRoutes.includes(location.pathname);

  return (
    <>
      <NetworkBanner />
      {/* QuoteModal retired — replaced by the in-job FinalPaymentFlow (see RequestDetail). */}
      <div
        style={{
          paddingBottom: showBottomNav ? 'calc(112px + env(safe-area-inset-bottom, 0px))' : undefined,
        }}
      >
      <Routes>
        <Route path="/" element={<Splash />} />
        <Route path="/welcome" element={<Welcome />} />
        <Route path="/driver-entry" element={<DriverEntry />} />
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/verifying" element={<Verifying />} />
        <Route
          path="/onboarding"
          element={
            <PrivateRoute>
              <Onboarding />
            </PrivateRoute>
          }
        />
        <Route
          path="/requests"
          element={
            <PrivateRoute>
              <Home />
            </PrivateRoute>
          }
        />
        <Route
          path="/requests/:id"
          element={
            <PrivateRoute>
              <RequestDetail />
            </PrivateRoute>
          }
        />
        <Route
          path="/history"
          element={
            <PrivateRoute>
              <RequestsList />
            </PrivateRoute>
          }
        />
        <Route
          path="/locating"
          element={
            <PrivateRoute>
              <LocatingUser />
            </PrivateRoute>
          }
        />
        <Route
          path="/describe-issue"
          element={
            <PrivateRoute>
              {MOTOBOT_ENABLED
                ? <DescribeIssue />
                : <Navigate to="/get-help" replace />}
            </PrivateRoute>
          }
        />
        <Route
          path="/sos"
          element={<Navigate to="/get-help" replace />}
        />
        <Route
          path="/get-help"
          element={
            <PrivateRoute>
              <GetHelp />
            </PrivateRoute>
          }
        />
        <Route
          path="/get-help/location"
          element={
            <PrivateRoute>
              <GetHelpLocation />
            </PrivateRoute>
          }
        />
        <Route
          path="/emergency"
          element={
            <PrivateRoute>
              <EmergencyAlert />
            </PrivateRoute>
          }
        />
        <Route
          path="/insurance"
          element={
            <PrivateRoute>
              <InsurancePage />
            </PrivateRoute>
          }
        />
        <Route
          path="/fault-chat"
          element={
            <PrivateRoute>
              {MOTOBOT_ENABLED
                ? <FaultChat />
                : <Navigate to="/get-help" replace state={location.state} />}
            </PrivateRoute>
          }
        />
        <Route
          path="/nearby-mechanics"
          element={
            <PrivateRoute>
              <NearbyMechanics />
            </PrivateRoute>
          }
        />
        <Route
          path="/profile"
          element={
            <PrivateRoute>
              <Profile />
            </PrivateRoute>
          }
        />
        <Route
          path="/reminders"
          element={
            <PrivateRoute>
              <Reminders />
            </PrivateRoute>
          }
        />
        <Route
          path="/reminder-settings"
          element={
            <PrivateRoute>
              <ReminderSettings />
            </PrivateRoute>
          }
        />
        <Route
          path="/notifications"
          element={
            <PrivateRoute>
              <NotificationsPage />
            </PrivateRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <PrivateRoute>
              <Settings />
            </PrivateRoute>
          }
        />
        <Route
          path="/terms-of-service"
          element={
            <PrivateRoute>
              <TermsOfService />
            </PrivateRoute>
          }
        />
        <Route
          path="/privacy-policy"
          element={
            <PrivateRoute>
              <PrivacyPolicy />
            </PrivateRoute>
          }
        />
        <Route
          path="/rate-motofix"
          element={
            <PrivateRoute>
              <RateMotofix />
            </PrivateRoute>
          }
        />
        <Route
          path="/contact-support"
          element={
            <PrivateRoute>
              <ContactSupport />
            </PrivateRoute>
          }
        />
        <Route
          path="/requests/:requestId/chat"
          element={
            <PrivateRoute>
              <DriverChat />
            </PrivateRoute>
          }
        />
        <Route
          path="/spare-parts"
          element={
            <PrivateRoute>
              <SparePartsDealer />
            </PrivateRoute>
          }
        />
        <Route
          path="/parts-needed"
          element={
            <PrivateRoute>
              <PartsNeeded />
            </PrivateRoute>
          }
        />
        <Route
          path="/parts-orders"
          element={
            <PrivateRoute>
              <PartsOrders />
            </PrivateRoute>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Routes>
      </div>
      {showBottomNav && <BottomNav />}
      {MOTOBOT_ENABLED && showBottomNav && isAuthenticated && <MotobotFab />}
    </>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster
        position="top-center"
        richColors
        visibleToasts={1}
        duration={3500}
        closeButton
        toastOptions={{
          style: {
            background: 'var(--overlay-bg)',
            border: '1px solid var(--border-3)',
            color: 'var(--text-hi)',
          },
        }}
      />
      <AppRouter>
        <ThemeProvider>
          <AuthProvider>
            <WebSocketProvider>
              <RequestProvider>
                <AppContent />
              </RequestProvider>
            </WebSocketProvider>
          </AuthProvider>
        </ThemeProvider>
      </AppRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
