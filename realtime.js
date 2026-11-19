import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.1/+esm';

const URL = 'https://mksqwvaeafjsfjezmntc.supabase.co';
const KEY = 'sb_publishable_MCPrDNjK2z3LVKTJYlE3JA_wWg-cDTx';
const ROOM = 'same-sea:shore:v1';
const DEVICE_KEY = 'same-sea-device-id';
const LEASE_KEY = 'same-sea-active-tab';
const tabId = crypto.randomUUID();
let deviceId;
try {
  deviceId = localStorage.getItem(DEVICE_KEY);
  if (!deviceId || !/^[0-9a-f-]{36}$/i.test(deviceId)) {
    deviceId = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, deviceId);
  }
} catch {
  deviceId = crypto.randomUUID();
}

const client = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const validPose = p => p && Number.isFinite(p.x) && p.x >= -22 && p.x <= 22 && Number.isFinite(p.z) && p.z >= .55 && p.z <= 27 && Number.isFinite(p.heading) && Math.abs(p.heading) <= Math.PI * 2 && typeof p.sitting === 'boolean';
const validId = id => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id);
const cleanPose = p => ({ x: +p.x.toFixed(2), z: +p.z.toFixed(2), heading: +p.heading.toFixed(3), sitting: !!p.sitting });

export function connectSea({ getPose, onPeople, onMove, onGesture, onStatus, onActive }) {
  let channel = null, active = false, status = 'connecting', lastPose = '', lastSent = 0, lastLease = 0, disposed = false;
  const readLease = () => { try { return JSON.parse(localStorage.getItem(LEASE_KEY)); } catch { return null; } };
  const ownLease = () => { const lease = readLease(); return lease?.tab === tabId && Date.now() - lease.at < 5000; };
  const claim = () => {
    const lease = readLease();
    if (lease && lease.tab !== tabId && Date.now() - lease.at < 5000) return false;
    try { localStorage.setItem(LEASE_KEY, JSON.stringify({ tab: tabId, at: Date.now() })); } catch { /* private mode */ }
    return true;
  };
  const peers = new Map();
  const emitPeers = () => onPeople(new Map(peers));
  const updatePresence = () => {
    if (!channel || !active) return;
    const state = channel.presenceState();
    peers.clear();
    for (const [id, entries] of Object.entries(state)) {
      if (!validId(id) || id === deviceId || peers.size >= 24) continue;
      const entry = entries.find(item => validPose(item.pose));
      if (entry) peers.set(id, cleanPose(entry.pose));
    }
    emitPeers();
  };
  const leave = async () => {
    active = false; onActive(false); peers.clear(); emitPeers();
    const old = channel; channel = null;
    if (old) { try { await old.untrack(); await client.removeChannel(old); } catch {} }
  };
  const join = () => {
    if (disposed || active) return;
    if (!claim()) { onActive(false); return; }
    active = true; onActive(true); onStatus('connecting');
    channel = client.channel(ROOM, { config: { presence: { key: deviceId }, broadcast: { self: false } } });
    channel.on('presence', { event: 'sync' }, updatePresence);
    channel.on('broadcast', { event: 'move' }, ({ payload }) => {
      if (validId(payload?.id) && peers.has(payload.id) && validPose(payload.pose)) onMove(payload.id, cleanPose(payload.pose));
    });
    channel.on('broadcast', { event: 'gesture' }, ({ payload }) => {
      if (validId(payload?.id) && peers.has(payload.id) && ['heart', 'wave'].includes(payload.kind) && validPose(payload.pose)) onGesture(payload.id, payload.kind, cleanPose(payload.pose));
    });
    channel.subscribe(async next => {
      if (disposed || !active) return;
      if (next === 'SUBSCRIBED') {
        status = 'connected'; onStatus(status);
        await channel.track({ pose: cleanPose(getPose()) });
        updatePresence();
      } else if (next === 'CHANNEL_ERROR' || next === 'TIMED_OUT' || next === 'CLOSED') {
        status = 'offline'; onStatus(status); peers.clear(); emitPeers();
        const failed = channel;
        setTimeout(() => { if (active && channel === failed && !disposed) leave().then(join); }, 1500);
      }
    });
  };
  const tick = () => {
    if (disposed) return;
    if (active && !ownLease()) { leave(); return; }
    if (!active) { join(); return; }
    if (Date.now() - lastLease > 1500) { try { localStorage.setItem(LEASE_KEY, JSON.stringify({ tab: tabId, at: Date.now() })); lastLease = Date.now(); } catch {} }
    if (status !== 'connected') return;
    const pose = cleanPose(getPose()), serialized = JSON.stringify(pose);
    if ((serialized !== lastPose && Date.now() - lastSent > 120) || Date.now() - lastSent > 2000) {
      lastPose = serialized; lastSent = Date.now();
      channel.send({ type: 'broadcast', event: 'move', payload: { id: deviceId, pose } });
    }
  };
  const pulse = setInterval(tick, 130);
  const storage = event => { if (event.key === LEASE_KEY && active && !ownLease()) leave(); };
  window.addEventListener('storage', storage);
  const unloading = () => { if (ownLease()) { try { localStorage.removeItem(LEASE_KEY); } catch {} } leave(); };
  window.addEventListener('pagehide', unloading);
  join();
  return {
    sendGesture(kind) { if (active && status === 'connected' && ['heart', 'wave'].includes(kind)) channel.send({ type: 'broadcast', event: 'gesture', payload: { id: deviceId, kind, pose: cleanPose(getPose()) } }); },
    updatePose() { if (active && status === 'connected') { const pose = cleanPose(getPose()); lastPose = JSON.stringify(pose); lastSent = Date.now(); channel.send({ type: 'broadcast', event: 'move', payload: { id: deviceId, pose } }); } },
    dispose() { disposed = true; clearInterval(pulse); window.removeEventListener('storage', storage); window.removeEventListener('pagehide', unloading); unloading(); }
  };
}
