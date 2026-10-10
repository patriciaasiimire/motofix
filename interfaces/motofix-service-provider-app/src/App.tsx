// App.tsx — the root of the service-provider (mechanic / tow provider) app.
//
// It maps URLs to pages in <Routes> and wraps everything in providers (outer→inner):
//   Theme (light/dark) → Auth (who's logged in). The live WebSocket is only opened
//   inside the logged-in area (see ProtectedArea), so public screens don't connect.
//
// Route protection:
//   • <ProtectedRoute> — requires the provider to be logged in.
//   • <ProtectedArea> — ProtectedRoute PLUS the WebSocketProvider, used for screens that
//     need live job updates (dashboard, chat, notifications).
//   • RootRedirect — sends "/" to the dashboard if a token exists, else the intro flow.
// The provider's login token is stored under 'motofix_sp_token' (sp = service provider).

import { Navigate, Route, Routes } from 'react-router-dom'
import { Toaster } from 'sonner'
import { ThemeProvider, useTheme } from '@/contexts/ThemeContext'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import { WebSocketProvider } from '@/contexts/WebSocketContext'
import ProtectedRoute from '@/components/ProtectedRoute'
import { useFcmToken } from '@/hooks/useFcmToken'
import ChangePassword from '@/pages/ChangePassword'
import Login from '@/pages/Login'
import ProviderEntry from '@/pages/ProviderEntry'
import Splash from '@/pages/Splash'
import ProviderSplash from '@/pages/ProviderSplash'
import WelcomeSplash from '@/pages/WelcomeSplash'
import Apply from '@/pages/Apply'
import Dashboard from '@/pages/Dashboard'
import Chat from '@/pages/Chat'
import Notifications from '@/pages/Notifications'
import TermsConditions from '@/pages/TermsConditions'
import ContactSupport from '@/pages/ContactSupport'
import SpareParts from '@/pages/SpareParts'

function Placeholder({ name }: { name: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: 'var(--page-bg)', color: '#F59E0B', fontSize: 18, fontWeight: 700 }}>
      {name} — coming soon
    </div>
  )
}

function RootRedirect() {
  let token: string | null = null
  try { token = localStorage.getItem('motofix_sp_token') } catch { /* storage blocked */ }
  return <Navigate to={token ? '/dashboard' : '/intro'} replace />
}

function ProtectedArea({ children }: { children: React.ReactNode }) {
  return (
    <ProtectedRoute>
      <WebSocketProvider>
        {children}
      </WebSocketProvider>
    </ProtectedRoute>
  )
}

function AppRoutes() {
  const { theme } = useTheme()
  const { isAuthenticated } = useAuth()
  useFcmToken(isAuthenticated)
  return (
    <>
      <Toaster
        position="top-center"
        theme={theme}
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
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        <Route path="/intro" element={<Splash />} />
        <Route path="/splash" element={<ProviderSplash />} />
        <Route path="/welcome" element={<WelcomeSplash />} />
        <Route path="/entry" element={<ProviderEntry />} />
        <Route path="/login" element={<Login />} />
        <Route path="/apply" element={<Apply />} />
        <Route path="/pending-review" element={<Placeholder name="Pending Review" />} />
        <Route path="/change-password" element={
          <ProtectedRoute><ChangePassword /></ProtectedRoute>
        } />
        <Route path="/dashboard" element={
          <ProtectedArea><Dashboard /></ProtectedArea>
        } />
        <Route path="/chat/:requestId" element={
          <ProtectedArea><Chat /></ProtectedArea>
        } />
        <Route path="/notifications" element={
          <ProtectedArea><Notifications /></ProtectedArea>
        } />
        <Route path="/terms" element={
          <ProtectedArea><TermsConditions /></ProtectedArea>
        } />
        <Route path="/contact-support" element={
          <ProtectedArea><ContactSupport /></ProtectedArea>
        } />
        <Route path="/spare-parts" element={
          <ProtectedRoute><SpareParts /></ProtectedRoute>
        } />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </ThemeProvider>
  )
}
