/* ==================================================================
   APD-MINAT V6.31 — Service Worker
   WhatsApp/Telegram-style notifications for new messages.

   Capabilities:
   - `push` event: handles true Web Push (VAPID) — future-ready
   - `message` event: bridge from page → SW to show notifications
     even when the page tab is hidden or minimized
   - `notificationclick`: focus existing tab or open new one,
     then navigate to the right conversation
   - `periodicsync`: best-effort periodic check (Chrome/Edge only)
     when the app is fully closed — fires ~every 12h by default
   - `install`/`activate`: skipWaiting + clients.claim for immediate
     activation on first registration
   ================================================================== */

const SW_VERSION = '6.33';
const SYNC_TAG = 'check-new-messages';
const SUPABASE_URL = 'https://lqtvpgqparhkxwmtaufh.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxxdHZwZ3FwYXJoa3h3bXRhdWZoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwMjc2NjMsImV4cCI6MjA5OTYwMzY2M30.AFN6CpGiiRBL-whNEiYSd5YfzwCv9gIR_N7DY5ZnvcA';
const SUPABASE_TABLE = 'amicale_data';
const SUPABASE_RECORD_ID = 'MINAT-19DFB2D9';

// ───────────────────────────────────────────────────────────────────
// INSTALL: activate immediately
// ───────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  console.log('[SW V' + SW_VERSION + '] install');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[SW V' + SW_VERSION + '] activate');
  event.waitUntil(self.clients.claim());
});

// ───────────────────────────────────────────────────────────────────
// PUSH: true Web Push (VAPID) — for future integration with a push
// service. Currently unused (no VAPID server), but ready.
// ───────────────────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  console.log('[SW V' + SW_VERSION + '] push event received');
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    try { payload = { body: event.data ? event.data.text() : '' }; }
    catch (_) { payload = {}; }
  }
  const title = payload.title || 'APD-MINAT';
  const options = {
    body: payload.body || 'Nouveau message',
    icon: payload.icon || '/favicon-192.png',
    badge: payload.badge || '/favicon-192.png',
    tag: payload.tag || 'apdminat-message',
    data: payload.data || {},
    requireInteraction: !!payload.requireInteraction,
    actions: payload.actions || [],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// ───────────────────────────────────────────────────────────────────
// MESSAGE: bridge from page → SW. Lets the page ask the SW to show
// a notification (which works even when the page tab is hidden).
// Payload: { type: 'show-notification', title, body, tag, data, icon? }
// ───────────────────────────────────────────────────────────────────
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'show-notification') {
    const title = data.title || 'APD-MINAT';
    const options = {
      body: data.body || '',
      icon: data.icon || '/favicon-192.png',
      badge: data.badge || '/favicon-192.png',
      tag: data.tag || 'apdminat-message',
      data: data.data || {},
      requireInteraction: !!data.requireInteraction,
      // 🔔 Vibration pattern (Android only) — short-long like WhatsApp
      vibrate: [200, 100, 200],
    };
    event.waitUntil(
      self.registration.showNotification(title, options)
        .catch(err => console.warn('[SW] showNotification failed:', err))
    );
    return;
  }
  if (data.type === 'skip-waiting') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'ping') {
    event.ports[0] && event.ports[0].postMessage({ type: 'pong', version: SW_VERSION });
    return;
  }
});

// ───────────────────────────────────────────────────────────────────
// NOTIFICATION CLICK: focus existing tab or open new one, then
// navigate to the conversation.
// ───────────────────────────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  console.log('[SW V' + SW_VERSION + '] notificationclick', event.notification.tag);
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  const conversationUser = (event.notification.data && event.notification.data.conversationUser) || null;

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Find a tab already running the app
      for (const client of allClients) {
        if (client.url.includes('/index.html') || client.url.includes('/APD-MINAT') || client.url.endsWith('/')) {
          try {
            await client.focus();
            // Tell the page to navigate to the conversation
            if (conversationUser) {
              client.postMessage({
                type: 'navigate-to-conversation',
                conversationUser: conversationUser,
              });
            } else {
              client.postMessage({ type: 'navigate-to-messages' });
            }
          } catch (e) {
            console.warn('[SW] focus failed:', e);
          }
          return;
        }
      }
      // No existing tab — open a new one
      try {
        const newClient = await self.clients.openWindow(targetUrl);
        if (newClient && conversationUser) {
          // Wait for the page to load, then ask it to navigate
          setTimeout(() => {
            try {
              newClient.postMessage({
                type: 'navigate-to-conversation',
                conversationUser: conversationUser,
              });
            } catch (e) {}
          }, 3000);
        }
      } catch (e) {
        console.warn('[SW] openWindow failed:', e);
      }
    })()
  );
});

// ───────────────────────────────────────────────────────────────────
// PERIODIC SYNC: best-effort periodic check when app is fully closed.
// Only Chrome/Edge + only after PWA install.
// Default minInterval ~12h, browser-controlled (not configurable).
// ───────────────────────────────────────────────────────────────────
self.addEventListener('periodicsync', (event) => {
  console.log('[SW V' + SW_VERSION + '] periodicsync:', event.tag);
  if (event.tag === SYNC_TAG) {
    event.waitUntil(checkForNewMessagesBackground());
  }
});

// ───────────────────────────────────────────────────────────────────
// Background check: fetch the latest messages from Supabase and
// compare with the last-seen timestamp stored in IndexedDB.
// If newer messages exist for our user, show a notification.
// ───────────────────────────────────────────────────────────────────
async function checkForNewMessagesBackground(){
  try {
    // Read the current user + last-seen timestamp from IndexedDB
    // (the page writes these on every login and every poll)
    const lastSeen = await readIdbKey('apd_msg_last_seen_ts');
    const currentUser = await readIdbKey('apd_current_user');
    if (!currentUser) {
      console.log('[SW] no current user — skipping background check');
      return;
    }
    // Fetch the cloud record
    const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?id=eq.${encodeURIComponent(SUPABASE_RECORD_ID)}&select=data`;
    const r = await fetch(url, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    if (!r.ok) {
      console.warn('[SW] supabase fetch failed:', r.status);
      return;
    }
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) return;
    const data = rows[0].data || {};
    const messages = Array.isArray(data.messages) ? data.messages : [];
    // Find messages destined to our user that are newer than lastSeen
    const cutoff = lastSeen || 0;
    const newOnes = messages.filter(m =>
      m.to === currentUser.username &&
      new Date(m.sentAt).getTime() > cutoff &&
      !(m.readBy || []).includes(currentUser.username)
    );
    if (newOnes.length === 0) return;
    // Show one notification per new message (WhatsApp-style)
    for (const m of newOnes.slice(0, 3)) {
      const senderLabel = m.from === 'admin' ? 'Administrateur' :
                          m.from === 'membre' ? 'Membre (compte commun)' :
                          (m.from || 'Inconnu');
      const preview = (m.body || m.subject || '(pièce jointe)').substring(0, 100);
      await self.registration.showNotification('💬 ' + senderLabel, {
        body: preview,
        icon: '/favicon-192.png',
        badge: '/favicon-192.png',
        tag: 'apdminat-msg-' + (m.id || Date.now()),
        data: {
          url: '/',
          conversationUser: m.from,
        },
        vibrate: [200, 100, 200],
      });
    }
    // Update last-seen to the latest message timestamp
    if (newOnes.length > 0) {
      const maxTs = Math.max(...newOnes.map(m => new Date(m.sentAt).getTime()));
      await writeIdbKey('apd_msg_last_seen_ts', maxTs);
    }
  } catch (e) {
    console.warn('[SW] background check error:', e);
  }
}

// ───────────────────────────────────────────────────────────────────
// IndexedDB helpers (minimal — for the SW's own state)
// ───────────────────────────────────────────────────────────────────
const IDB_NAME = 'apdminat_sw';
const IDB_STORE = 'kv';

function idbOpen(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readIdbKey(key){
  try {
    const db = await idbOpen();
    return await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const r = store.get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    });
  } catch (e) { return null; }
}

async function writeIdbKey(key, value){
  try {
    const db = await idbOpen();
    return await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      store.put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch (e) { return false; }
}
