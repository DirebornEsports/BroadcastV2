// Local stand-in for the part of Cloudflare Realtime (SFU) that lib/camcore.mjs uses, so player cams can run over the
// venue's own network with no internet (npm run lan). Same calls, same answers:
//   POST /sessions/new                                   -> { sessionId }
//   POST /sessions/:id/tracks/new  { sessionDescription offer, tracks: local }   publish  -> { sessionDescription answer, tracks }
//   POST /sessions/:id/tracks/new  { tracks: remote }                            pull     -> { sessionDescription offer, requiresImmediateRenegotiation, tracks }
//   PUT  /sessions/:id/renegotiate { sessionDescription answer }
//   PUT  /sessions/:id/tracks/close
// Media is forwarded packet by packet (no re-encoding); keyframe requests from a viewer go back to the sender.
import crypto from 'node:crypto';
import dgram from 'node:dgram';
// A 1080p keyframe from a GPU encoder arrives as one burst of 100+ packets; Windows' default 64 KB UDP buffer
// drops part of it and the keyframe never completes. werift calls dgram.createSocket at runtime, so this reaches it.
const createSocket = dgram.createSocket;
dgram.createSocket = (o, cb) => createSocket({ recvBufferSize: 8 << 20, sendBufferSize: 8 << 20, ...(typeof o === 'string' ? { type: o } : o) }, cb);
import { RTCPeerConnection, RTCRtpCodecParameters, useH264, useVP8, useOPUS, useTWCC, useSdesMid, useTransportWideCC } from 'werift';

// from a sender: transport-wide congestion feedback, without it Chrome never raises its bitrate above a few hundred kbps
const twcc = (c) => { c.rtcpFeedback = [...c.rtcpFeedback, useTWCC()]; return c; };
const PUB_EXT = { video: [useSdesMid(), useTransportWideCC()], audio: [useSdesMid(), useTransportWideCC()] };
// the sender's own preference decides (its offer lists the codec it wants first): Codec cam in the panel
function pubCodecs(sdp) {
  const m = /m=video \d+ \S+ (\d+)/.exec(sdp), first = m && new RegExp(`a=rtpmap:${m[1]} ([\\w-]+)/`).exec(sdp);
  const h264 = twcc(useH264()), vp8 = twcc(useVP8());
  return { video: first && /vp8/i.test(first[1]) ? [vp8, h264] : [h264, vp8], audio: [twcc(useOPUS())] };
}
const sessions = new Map();    // id -> { pc, pub: Map(trackName -> { kind, track, transceiver, codec }), subs: [unsubscribe] }

const gathered = (pc) => (pc.iceGatheringState === 'complete' ? Promise.resolve()
  : new Promise((ok) => { const t = setTimeout(ok, 3000); pc.iceGatheringStateChange.subscribe((s) => { if (s === 'complete') { clearTimeout(t); ok(); } }); }));
const until = async (fn, ms) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) { const v = fn(); if (v) return v; } return fn(); };
function closeSession(id) {
  const s = sessions.get(id); if (!s) return;
  sessions.delete(id);
  for (const u of s.subs) { try { u(); } catch {} }
  try { s.pc && s.pc.close(); } catch {}
}
function watch(id, pc) {
  pc.connectionStateChange.subscribe((st) => { if (st === 'failed' || st === 'closed') closeSession(id); });
}

async function publish(s, id, offer, tracks) {
  // ICE-lite like Cloudflare Realtime: ffmpeg's WHIP muxer never answers werift's consent checks, so a full
  // agent here dropped every ffmpeg sender after 30 s (RFC 7675 consent expiry)
  const pc = s.pc = new RTCPeerConnection({ codecs: pubCodecs(offer.sdp), headerExtensions: PUB_EXT, iceUseIpv6: false, iceLite: true });
  watch(id, pc);
  const byMid = new Map(tracks.map((t) => [String(t.mid), t.trackName]));
  pc.ontrack = ({ track, transceiver }) => {
    const name = byMid.get(transceiver.mid); if (!name) return;
    const p = { kind: track.kind, track, transceiver, codec: null };
    s.pub.set(name, p);
    // the codec the browser really sends (it may list several): the payload type of its first packet
    const sub = track.onReceiveRtp.subscribe((rtp) => {
      s.lastRtp = Date.now();
      // packets missing between the player and this bridge (vs. between here and the studio receiver)
      const q = rtp.header.sequenceNumber, d = p.seq === undefined ? 1 : (q - p.seq) & 0xffff;
      if (d < 0x8000) { if (d > 1) s.lost = (s.lost || 0) + d - 1; p.seq = q; }
      if (p.codec) return;
      p.codec = transceiver.codecs.find((c) => c.payloadType === rtp.header.payloadType) || transceiver.codecs[0];
    });
    s.subs.push(() => sub.unSubscribe());
  };
  await pc.setRemoteDescription(offer);
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc);
  return { sessionDescription: { type: 'answer', sdp: pc.localDescription.sdp }, tracks: tracks.map((t) => ({ mid: String(t.mid), trackName: t.trackName })) };
}

async function pull(s, id, tracks) {
  // each wanted track: its sender must be here and have sent a first packet (so its codec is known)
  const srcs = [];
  for (const t of tracks) {
    const src = await until(() => { const p = sessions.get(t.sessionId)?.pub.get(t.trackName); return p && p.codec ? p : null; }, 4000);
    srcs.push({ t, src });
  }
  const bad = srcs.filter((x) => !x.src);
  if (bad.length) return { tracks: srcs.map(({ t, src }) => ({ trackName: t.trackName, sessionId: t.sessionId, ...(src ? {} : { errorCode: 'not_found', errorDescription: 'track belum ada' }) })) };
  const codec = (kind) => { const p = srcs.find((x) => x.src.kind === kind); return p ? [new RTCRtpCodecParameters({ mimeType: p.src.codec.mimeType, clockRate: p.src.codec.clockRate, channels: p.src.codec.channels, parameters: p.src.codec.parameters, rtcpFeedback: p.src.codec.rtcpFeedback.filter((f) => f.type !== 'transport-cc') })] : []; };
  const pc = s.pc = new RTCPeerConnection({ codecs: { video: codec('video'), audio: codec('audio') }, iceUseIpv6: false });
  watch(id, pc);
  const out = [];
  for (const { t, src } of srcs) {
    const tr = pc.addTransceiver(src.kind, { direction: 'sendonly' });
    // an a=msid line per track (cam + mic as one stream): without it a viewer only sees the first track
    tr.sender.streamId = t.sessionId;
    const fwd = src.track.onReceiveRtp.subscribe((rtp) => { tr.sender.sendRtp(rtp).catch(() => {}); });
    // a viewer asking for a keyframe (PLI / FIR): ask the sender
    const fb = tr.sender.onRtcp.subscribe((pkt) => { if (pkt && pkt.type === 206 && src.track.ssrc) src.transceiver.receiver.sendRtcpPLI(src.track.ssrc).catch(() => {}); });
    s.subs.push(() => fwd.unSubscribe(), () => fb.unSubscribe());
    out.push({ trackName: t.trackName, sessionId: t.sessionId, mid: null, tr });
  }
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  // a viewer that never answers (closed tab) must not keep forwarding
  setTimeout(() => { if (pc.connectionState !== 'connected') closeSession(id); }, 30000);
  return { requiresImmediateRenegotiation: true, sessionDescription: { type: 'offer', sdp: pc.localDescription.sdp },
    tracks: out.map((x) => ({ trackName: x.trackName, sessionId: x.sessionId, mid: x.tr.mid })) };
}

// (method, path under /v1/apps/<app>, parsed JSON body) -> [status, json]
export async function localSfu(method, path, body) {
  const m = path.match(/^\/sessions\/(new|[\w-]+)(?:\/(tracks\/new|tracks\/close|renegotiate))?$/);
  if (!m) return [404, { errorCode: 'not_found' }];
  if (m[1] === 'new') { const id = crypto.randomUUID().replace(/-/g, ''); sessions.set(id, { pc: null, pub: new Map(), subs: [] }); return [200, { sessionId: id }]; }
  const id = m[1], s = sessions.get(id);
  if (!s) return [404, { errorCode: 'session_not_found', errorDescription: 'sesi tidak ada' }];
  try {
    if (m[2] === 'tracks/new') {
      const tracks = Array.isArray(body && body.tracks) ? body.tracks : [];
      if (body && body.sessionDescription && body.sessionDescription.type === 'offer') return [200, await publish(s, id, body.sessionDescription, tracks.filter((t) => t.location === 'local'))];
      return [200, await pull(s, id, tracks.filter((t) => t.location === 'remote'))];
    }
    if (m[2] === 'renegotiate') { await s.pc.setRemoteDescription(body.sessionDescription); return [200, {}]; }
    if (m[2] === 'tracks/close') { closeSession(id); return [200, { tracks: [] }]; }
  } catch (e) { return [500, { errorCode: 'local_sfu', errorDescription: e.message }]; }
  return [404, { errorCode: 'not_found' }];
}
// ms since a publisher session's last media packet (Infinity when it's gone): an ICE-lite SFU never notices a killed sender
export const localSfuLost = (id) => sessions.get(id)?.lost || 0;
export const localSfuIdle =(id) => { const s = sessions.get(id); return s && s.lastRtp ? Date.now() - s.lastRtp : Infinity; };
export const localSfuStats =() => ({ sessions: sessions.size, publishers: [...sessions.values()].filter((s) => s.pub.size).length });
