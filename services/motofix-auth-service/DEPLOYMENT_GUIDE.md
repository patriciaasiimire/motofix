# Auth Service Deployment Guide - JAN 23 2026

## Summary of Changes

Enhanced logging and debugging capabilities in the auth service to diagnose persistent login issues.

### Files Modified

1. **app/main.py**
   - Added logging setup
   - Added startup event to confirm CORS is enabled
   - Added global exception handler

2. **app/routers/auth.py**
   - Added detailed logging to login endpoint
   - Added detailed logging to /auth/me endpoint
   - Added detailed logging to token verification

---

## Why These Changes?

**Problem:** Users being redirected to login on page reload despite persistent login implementation.

**Root Cause Investigation:** Need to see:
- Is token being created on login?
- Is token being sent with /auth/me request?
- Is /auth/me endpoint being called?
- Is CORS blocking the request?
- Is token validation succeeding or failing?

**Solution:** Add comprehensive logging to trace the entire auth flow.

---

## Deployment Checklist

### Production driver browser CORS

The production V1 driver is served from `https://motofixug.netlify.app`. This
origin is explicitly allowed by `app/core/cors.py` with credentialed requests
still enabled. After changing the CORS allowlist, push the auth-service change
and redeploy `motofix-auth-service` on Render; the running service does not
pick up repository changes until it has deployed the new revision.

### Before Deploying

- [ ] Python syntax validated ✅
- [ ] No import errors ✅
- [ ] Logging module available in FastAPI ✅
- [ ] All changes are backward-compatible ✅

### Deploy to Render

1. **Push code to GitHub**
   ```bash
   git add app/main.py app/routers/auth.py
   git commit -m "JAN 23: Add comprehensive auth debugging logs"
   git push origin main
   ```

2. **Render automatically redeploys**
   - Monitor deploy status: https://dashboard.render.com
   - Check for Python syntax errors in build logs

3. **Verify Deployment**
   - Check Render logs for startup message:
     ```
     ============================================================
     🚀 MOTOFIX Auth Service Starting
     ============================================================
     ✅ CORS Enabled for:
        • https://motofix-driver-assist.onrender.com
     ```

### After Deploying

1. **Test login flow**
   ```bash
   # Open browser console on driver app
   # Login with phone + OTP
   # Watch console logs
   ```

2. **Check Render logs**
   - Should see `🔐 [POST /auth/login] Login attempt for phone: ...`
   - Should see `✅ [POST /auth/login] Login successful...`

3. **Test /auth/me**
   ```bash
   # After login, reload page
   # Should see `✅ [GET /auth/me] Successfully verified user`
   ```

4. **Monitor for errors**
   - Look for `❌` entries in logs
   - Look for `401 Not authenticated`
   - Look for database errors

---

## Testing After Deployment

### Test 1: Browser Console Logging

1. Go to https://motofix-driver-assist.onrender.com
2. Open DevTools → Console
3. Login with phone + OTP
4. Reload page

**Expected console output:**
```
✅ Auth verification succeeded: {id: 123, phone: "+256..."}
```

### Test 2: Render Logs

1. Go to Render dashboard
2. Open logs for motofix-auth-service
3. Filter for your phone number

**Expected log entries:**
```
🔐 [POST /auth/login] Login attempt for phone: +256701234567
✅ [POST /auth/login] Login successful for phone: +256701234567, token issued
🔍 [get_current_user] Origin: https://motofix-driver-assist.onrender.com
✅ [GET /auth/me] Successfully verified user: +256701234567
```

### Test 3: Persistent Login

1. Login successfully
2. Reload page
3. Should NOT see login page
4. Check Render logs for /auth/me call
5. Should see success logs

### Test 4: New Tab/Window

1. Login in tab 1
2. Open new tab and go to driver app
3. Should be already logged in
4. Renders logs should show /auth/me verification

---

## Troubleshooting During Testing

### If Logs Don't Appear

**Check:**
1. Render deploy succeeded (check build log)
2. Service is running (not crashed)
3. You're looking at the right Render service
4. Logs are being streamed in real-time

### If You See 401 Errors

**Check:**
1. SECRET_KEY environment variable set on Render
2. Database connection working
3. JWT expiry hasn't passed

### If CORS Error

**Check:**
1. Driver app URL exactly matches in allow_origins
2. Startup logs show CORS enabled
3. Preflight OPTIONS request succeeding

---

## Performance Impact

- **Added logging:** Minimal CPU overhead
- **New startup event:** One-time on service start
- **Global exception handler:** Only on errors
- **No database changes:** Uses existing schema

---

## Rollback Plan

If issues occur, revert these changes:
```bash
git revert HEAD
git push origin main
# Render automatically redeploys
```

---

## Related Files

- **Frontend debugging:** See `motofix-driver-assist/AUTH_DEBUG_GUIDE.md`
- **Frontend code:** `src/hooks/useAuth.ts`, `src/config/api.ts`
- **Backend code:** `app/routers/auth.py`, `app/main.py`

---

## Environment Variables to Verify

Before deploying, ensure these are set on Render:

| Variable | Value | Purpose |
|----------|-------|---------|
| `DATABASE_URL` | PostgreSQL connection string | User database |
| `SECRET_KEY` | Strong random string | JWT signing |
| `ALGORITHM` | `HS256` | JWT algorithm |
| `ACCESS_TOKEN_EXPIRE_SECONDS` | `2592000` (30 days) | Token lifetime |
| `ENV` | `production` | Use secure cookies |

---

## Success Criteria

✅ All steps below should be true after deployment:

- [ ] Render deploy succeeds without errors
- [ ] Startup logs show CORS enabled
- [ ] Login creates token (logs show success)
- [ ] /auth/me succeeds on reload (logs show 200)
- [ ] User stays logged in across reloads
- [ ] No 401 or CORS errors in logs
- [ ] No unhandled exceptions logged

---

## Questions?

Refer to `AUTH_DEBUG_GUIDE.md` in motofix-driver-assist for:
- Step-by-step debugging
- Console output examples
- Network tab analysis
- Common issues & fixes

---

**Deployed by:** GitHub Copilot  
**Date:** JAN 23 2026  
**Status:** Ready for deployment
