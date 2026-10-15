// server/http/routes.js — the node:http request listener. Every response gets the security headers (common.js), then:
// (i18n-ignore-file: the error pages are bilingual by design, 中文 · English — docs/I18N.md)
//
//   * a URL longer than 4096 characters → 414; one that does not parse → 400;
//   * any method but GET / HEAD → 405 with `Allow: GET, HEAD`;
//   * GET /healthz → JSON status (protocol `version`, release `app`, uptime, the served `build`, sockets, sessions,
//     rooms, matches), never cached; `?traffic=1` adds the traffic counters (traffic.js: bytes by category since the
//     start, WebSocket wire and payload bytes) for a loopback or private-network client only — the maintainer's
//     decision of 2026-10-12: the figures are the host's, so any other client, also one a tunnel or proxy on this
//     machine forwards, gets the plain report (net.js clientAddress, honouring TRUST_PROXY like the WebSocket limits);
//   * everything else → the static files (static.js).
// Every response's body bytes count in the traffic counters (traffic.js meter). A route that throws is logged and
// answers 500.

import { gzipSync } from 'node:zlib';
import { PROTOCOL_VERSION, APP_VERSION } from '../../shared/constants.js';
import { buildTag } from './buildTag.js';
import { setSecurityHeaders, sendError, sendJson, splitUrl } from './common.js';
import { doctorIdentity } from '../../shared/doctor.js';
import { clientAddress, isLocalIp } from '../net.js';
import { instanceScript } from './instanceProfile.js';

const MAX_URL_LENGTH = 4096;
function replayOptions(q) {
  const number = (key) => q.has(key) && /^\d{1,6}$/.test(q.get(key)) ? Number(q.get(key)) : null;
  return { summaryOnly:q.get('summary')==='1',tracks:q.get('tracks')==='1',field:number('field'),chunk:number('chunk') };
}

/**
 * The GET /healthz body (`withTraffic`: plus the traffic counters and the asset index's state, `?traffic=1`).
 * @param {{ startedAt: number, network: import('../net.js').Network, registry: import('../net.js').SessionRegistry,
 *           lobby: import('../lobby.js').Lobby, traffic?: ReturnType<typeof import('./traffic.js').createTrafficCounter>,
 *           assetIndex?: ReturnType<typeof import('./assetIndex.js').createAssetIndex> | null,
 *           views?: ReturnType<typeof import('./assetViews.js').createManifestViews> | null }} health
 * @param {boolean} [withTraffic]
 */
export function healthReport({ startedAt, network, registry, lobby, traffic, assetIndex, views }, withTraffic = false) {
  const report = {
    ok: true, version: PROTOCOL_VERSION, app: APP_VERSION, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    // the runtime the server is serving right now (public/js/ui/buildGuard.js): a page whose own build is
    // older than this reloads itself, so a deploy reaches clients that never reload
    build: buildTag(),
    sockets: network.connectionCount, sessions: registry.size, ...lobby.stats(),
  };
  if (withTraffic && traffic) report.traffic = traffic.snapshot();
  // content-hashed asset URLs (assetIndex.js / assetViews.js): off, building, or ready with how many files and URLs
  if (withTraffic) report.assetHashes = assetIndex ? { ...assetIndex.stats(), views: views ? views.stats() : null } : null;
  return report;
}

/** Does the query ask for the traffic counters (`traffic`, `traffic=1`, `traffic=true`)? */
const wantsTraffic = (query) => /(?:^|&)traffic(?:=(?:1|true|yes))?(?:&|$)/i.test(query || '');

/**
 * The request listener for `http.createServer`.
 * @param {{ serveStatic: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse,
 *             rawPath: string, query: string) => Promise<void>,
 *           health: Parameters<typeof healthReport>[0], log: object, trustProxy?: 'auto' | boolean }} deps
 *   trustProxy: whose forwarding headers name the client (net.js clientAddress; the server's TRUST_PROXY)
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createRequestHandler({ serveStatic, replays = null, health, log, trustProxy = 'auto' }) {
  async function handleRequest(req, res) {
    const url = req.url || '/';
    if (url.length > MAX_URL_LENGTH) { sendError(req, res, 414, '请求地址过长 · URI too long'); return; }
    const parts = splitUrl(url);
    if (!parts) { sendError(req, res, 400, '请求地址无效 · Bad request'); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendError(req, res, 405, '不支持的请求方法 · Method not allowed');
      return;
    }
    if(parts.rawPath==='/instance.js'){
      const body=Buffer.from(instanceScript());
      res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8','Cache-Control':'no-store','Content-Length':body.length});res.end(req.method==='HEAD'?undefined:body);return;
    }
    if (parts.rawPath === '/healthz') {
      const withTraffic = wantsTraffic(parts.query) && isLocalIp(clientAddress(req, trustProxy).ip);
      sendJson(req, res, 200, healthReport(health, withTraffic));
      return;
    }
    if (parts.rawPath === '/api/profiles/active-match') {
      const identity = doctorIdentity(new URLSearchParams(parts.query).get('identity'));
      const session = identity?.code && health.lobby.profileMatchSession(identity.name, identity.code);
      const room = session && health.lobby.roomOf(session);
      const player = room?.match?.players.get(session.playerId);
      sendJson(req, res, 200, { active: !!player && !player.left && !room.match.ended }); return;
    }
    if (parts.rawPath === '/api/profiles/availability') {
      const q = new URLSearchParams(parts.query), code = q.get('code') || '', name = q.get('name') || '';
      const identity = doctorIdentity(`${name}${code ? '#' + code : ''}`);
      if (!identity || name.includes('#') || !health.lobby.profiles) { sendError(req, res, 400, '博士代号无效 · Invalid callsign'); return; }
      sendJson(req, res, 200, health.lobby.profiles.availability(identity.name, identity.code)); return;
    }
    if (parts.rawPath === '/api/social-history') {
      const q=new URLSearchParams(parts.query),token=String(req.headers.authorization||'').replace(/^Bearer /,'');
      const result=health.lobby.social?.history(token,q.get('identity'),q.get('id'),{...replayOptions(q),offset:q.get('offset')});
      if(!result || result.status!==200){sendError(req,res,result?.status||404,'资料不可访问 · Profile unavailable');return;}
      const body=Buffer.from(JSON.stringify(result.body)),zipped=/\bgzip\b/.test(String(req.headers['accept-encoding']||''));
      const content=zipped?gzipSync(body):body;
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Accept-Encoding',...(zipped?{'Content-Encoding':'gzip'}:{}),'Content-Length':content.length});
      res.end(req.method==='HEAD'?undefined:content);return;
    }
    if (parts.rawPath.startsWith('/api/replays/') || parts.rawPath.startsWith('/api/shared-replays/')) {
      const shared = parts.rawPath.startsWith('/api/shared-replays/');
      const id = parts.rawPath.slice('/api/replays/'.length), key = String(req.headers.authorization || '').replace(/^Bearer /, '');
      const q = new URLSearchParams(parts.query);
      const options = replayOptions(q);
      const record = shared ? replays?.getShared(parts.rawPath.slice('/api/shared-replays/'.length), options) : (new URLSearchParams(parts.query).get('owner') ? replays?.getAccount?.(id, key, new URLSearchParams(parts.query).get('owner'), options) : replays?.get(id, key, options));
      if (!record) { sendError(req, res, 404, '记录不存在或不可访问 · Record unavailable'); return; }
      const body = Buffer.from(JSON.stringify({ ...record, serverNow: replays.now() })), zipped = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
      const content = zipped ? gzipSync(body) : body;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Vary': 'Accept-Encoding',
        ...(zipped ? { 'Content-Encoding': 'gzip' } : {}), 'Content-Length': content.length });
      res.end(req.method === 'HEAD' ? undefined : content); return;
    }
    await serveStatic(req, res, parts.rawPath, parts.query);
  }

  return (req, res) => {
    setSecurityHeaders(res);
    if (health.traffic) health.traffic.meter(res, splitUrl(req.url || '/')?.rawPath || '/');
    handleRequest(req, res).catch((e) => {
      log.error('[http] request failed', e);
      sendError(req, res, 500, '服务器内部错误 · Internal error');
    });
  };
}
