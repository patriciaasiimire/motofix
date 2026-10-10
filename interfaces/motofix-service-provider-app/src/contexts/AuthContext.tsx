// AuthContext.tsx — app-wide login state for the provider. Any screen calls useAuth() to
// read the current user/token or to log in/out. On login it saves the token + user to the
// browser (so the session survives refreshes) and starts the inactivity clock; on logout it
// clears them. The token lives under 'motofix_sp_token'.

import { createContext, useContext, useState } from 'react'
import type { User } from '@/types'

interface AuthCtx {
  user: User | null
  token: string | null
  isAuthenticated: boolean
  login: (token: string, user: User) => void
  logout: () => void
}

const AuthContext = createContext<AuthCtx>({} as AuthCtx)

// Storage-safe helpers — Safari with storage blocked throws; must not crash boot.
function lsGet(k: string): string | null { try { return localStorage.getItem(k) } catch { return null } }
function lsSet(k: string, v: string): void { try { localStorage.setItem(k, v) } catch { /* ignore */ } }
function lsDel(k: string): void { try { localStorage.removeItem(k) } catch { /* ignore */ } }

function readStoredUser(): User | null {
  try {
    const raw = lsGet('motofix_sp_user')
    return raw ? (JSON.parse(raw) as User) : null
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(() => lsGet('motofix_sp_token'))
  const [user, setUser] = useState<User | null>(readStoredUser)

  const login = (newToken: string, newUser: User) => {
    lsSet('motofix_sp_token', newToken)
    lsSet('motofix_sp_user', JSON.stringify(newUser))
    sessionStorage.removeItem('motofix_sp_greeting')  // fresh home-screen headline each login
    setToken(newToken)
    setUser(newUser)
  }

  const logout = () => {
    lsDel('motofix_sp_token')
    lsDel('motofix_sp_user')
    setToken(null)
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{
      user, token,
      isAuthenticated: !!token,
      login, logout,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
