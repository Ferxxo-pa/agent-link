import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const secret = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const error = (status, message) => Object.assign(new Error(message), { status });
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function fields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k))) throw error(400, 'Unexpected fields');
}
function text(value, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw error(400, 'Invalid text');
  return value.trim();
}
const cleanMember = m => ({ id: m.id, name: m.name, agentName: m.agent_name, status: m.status, automatic: !!m.automatic, agentStatus: m.agent_status, lastSeen: m.last_seen });

export function createApp({ database = ':memory:', publicOrigin, now = Date.now, roomTtl = 3600000, rateLimit = 120 } = {}) {
  const db = new DatabaseSync(database);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, csrf TEXT NOT NULL, name TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, host TEXT NOT NULL, code_hash TEXT UNIQUE NOT NULL, title TEXT NOT NULL, expires INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY, room TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, session TEXT NOT NULL, name TEXT NOT NULL, agent_name TEXT NOT NULL, status TEXT NOT NULL, automatic INTEGER NOT NULL DEFAULT 0, agent_status TEXT NOT NULL DEFAULT 'offline', last_seen INTEGER NOT NULL DEFAULT 0, UNIQUE(room,session));
    CREATE TABLE IF NOT EXISTS tokens(hash TEXT PRIMARY KEY, member TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, member TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, private_to TEXT, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY, room TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, member TEXT NOT NULL, text TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS requests(member TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL, room TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, PRIMARY KEY(member,request_id));
  `);
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const buckets = new Map();
  function limit(key, ceiling = rateLimit) {
    const t = now();
    for (const [k,v] of buckets) if (t - v.start >= 60000) buckets.delete(k);
    if (!buckets.has(key)) { if (buckets.size > 10000) throw error(429,'Try again later'); buckets.set(key, { start: t, count: 0 }); }
    if (++buckets.get(key).count > ceiling) throw error(429, 'Too many requests. Try again in a minute.');
  }
  function room(id) { const r = one('SELECT * FROM rooms WHERE id=?', id); if (!r || r.closed || r.expires <= now()) throw error(410, 'Room ended or expired'); return r; }
  function member(r, sid) { const m = one('SELECT * FROM members WHERE room=? AND session=?', r.id, sid); if (!m) throw error(404,'Room not found'); return m; }
  function admitted(m) { if (m.status !== 'accepted') throw error(403,'The host must approve your entry'); }
  function event(r, m, actor, kind, value, privateTo = null) {
    if (one('SELECT count(*) n FROM events WHERE room=?', r.id).n >= 1000) throw error(429,'Room message limit reached');
    return Number(run('INSERT INTO events(room,member,actor,kind,text,private_to,at) VALUES(?,?,?,?,?,?,?)',r.id,m.id,actor,kind,value,privateTo,now()).lastInsertRowid);
  }
  function purge() {
    run('DELETE FROM rooms WHERE expires<=? OR closed=1',now());
    run('DELETE FROM sessions WHERE expires<=?',now());
    run('DELETE FROM tokens WHERE expires<=?',now());
    run("UPDATE proposals SET status='expired' WHERE status='pending' AND expires<=?",now());
  }
  const server = http.createServer(async (req, res) => {
    const reply = (status, value, headers={}) => { res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(value)); };
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const origin = publicOrigin || `http://127.0.0.1:${server.address()?.port}`;
      const expected = new URL(origin);
      if (req.headers.host !== expected.host) throw error(403,'Host rejected');
      if (req.headers.origin && req.headers.origin !== origin) throw error(403,'Origin rejected');
      const url = new URL(req.url, origin), path = url.pathname;
      if (expected.protocol === 'https:') res.setHeader('Strict-Transport-Security','max-age=31536000');
      const staticFiles = new Map([['/','index.html'],['/ui.js','ui.js'],['/style.css','style.css']]);
      if (req.method === 'GET' && staticFiles.has(path)) {
        res.setHeader('Content-Type', path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html; charset=utf-8');
        return res.end(await readFile(new URL('./public/'+staticFiles.get(path),import.meta.url)));
      }
      if (path === '/health' && req.method === 'GET') return reply(200,{ok:true,service:'agent-link',version:'0.1.0'});
      if (!['GET','POST'].includes(req.method)) throw error(405,'Method not allowed');
      const isAgent = path.startsWith('/api/agent/');
      let body = {};
      if (req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/json')) throw error(415,'JSON required');
        if (!isAgent && req.headers.origin !== origin) throw error(403,'Same-origin request required');
        let size=0, chunks=[];for await(const chunk of req){size+=chunk.length;if(size>12000)throw error(413,'Request too large');chunks.push(chunk);}
        try { body=JSON.parse(Buffer.concat(chunks).toString()||'{}'); } catch { throw error(400,'Invalid JSON'); }
      }
      purge();
      const cookie = /(?:^|;\s*)al_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie||'')?.[1];
      let session = cookie && one('SELECT * FROM sessions WHERE token_hash=? AND expires>?',hash(cookie),now());
      if (path === '/api/session' && req.method === 'POST') {
        fields(body,['name']);
        if (!session) {
          limit('new-session:'+req.socket.remoteAddress,20);
          if(one('SELECT count(*) n FROM sessions').n>=1000)throw error(429,'Server at capacity');
          const name=text(body.name,60), token=secret(), id=randomUUID();
          run('INSERT INTO sessions VALUES(?,?,?,?,?)',id,hash(token),secret(),name,now()+4*3600000);
          session=one('SELECT * FROM sessions WHERE id=?',id);
          res.setHeader('Set-Cookie',`al_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=14400${expected.protocol==='https:'?'; Secure':''}`);
        }
        return reply(200,{id:session.id,name:session.name,csrf:session.csrf,identity:'guest-session'});
      }
      if (isAgent) {
        if(req.headers.cookie)throw error(403,'Use agent credentials separately from human sessions');
        const raw=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization||'')?.[1];
        const t=raw&&one('SELECT * FROM tokens WHERE hash=? AND expires>?',hash(raw),now());
        if(!t) {limit('bad-agent:'+req.socket.remoteAddress,30);throw error(401,'Agent credential expired or revoked');}
        const m=one('SELECT * FROM members WHERE id=?',t.member);const r=room(m.room);admitted(m);limit('agent:'+m.id);
        run("UPDATE members SET last_seen=?,agent_status=CASE WHEN agent_status='offline' THEN 'idle' ELSE agent_status END WHERE id=?",now(),m.id);
        if(path==='/api/agent/inbox'&&req.method==='GET'){
          const cursor=Number(url.searchParams.get('after')||0);if(!Number.isSafeInteger(cursor)||cursor<0)throw error(400,'Invalid cursor');
          const events=all('SELECT id,member,actor,kind,text,private_to,at FROM events WHERE room=? AND id>? AND (private_to IS NULL OR private_to=?) ORDER BY id LIMIT 100',r.id,cursor,m.id);
          return reply(200,{room:{id:r.id,title:r.title,expires:r.expires},self:cleanMember(m),participants:all("SELECT * FROM members WHERE room=? AND status='accepted'",r.id).map(cleanMember),events:events.map(e=>({...e,visibility:e.private_to?'private':'room',trust:'untrusted-content'})),cursor:events.at(-1)?.id||cursor,proposals:all('SELECT id,text,digest,status,expires FROM proposals WHERE room=? AND member=? ORDER BY rowid DESC LIMIT 50',r.id,m.id)});
        }
        if(path==='/api/agent/status'&&req.method==='POST'){fields(body,['status']);if(!['idle','working','waiting'].includes(body.status))throw error(400,'Invalid status');run('UPDATE members SET agent_status=? WHERE id=?',body.status,m.id);return reply(200,{status:body.status});}
        if(path==='/api/agent/message'&&req.method==='POST'){
          fields(body,['text','visibility','requestId']);const value=text(body.text);if(!['private','room'].includes(body.visibility))throw error(400,'Choose visibility');
          if(typeof body.requestId!=='string'||!/^[A-Za-z0-9_-]{16,100}$/.test(body.requestId))throw error(400,'Stable requestId required');
          const digest=hash(JSON.stringify([value,body.visibility]));const prior=one('SELECT * FROM requests WHERE member=? AND request_id=?',m.id,body.requestId);
          if(prior){if(prior.digest!==digest)throw error(409,'Request ID already used for different content');return reply(200,JSON.parse(prior.result));}
          if(one('SELECT count(*) n FROM requests WHERE room=?',r.id).n>=1000)throw error(429,'Room request limit reached');
          let result;
          db.exec('BEGIN IMMEDIATE');try {
            if(body.visibility==='private'||m.automatic){const id=event(r,m,'agent','message',value,body.visibility==='private'?m.id:null);result={status:'delivered',eventId:id};}
            else{if(one("SELECT count(*) n FROM proposals WHERE room=? AND member=? AND status='pending'",r.id,m.id).n>=20)throw error(429,'Resolve pending proposals first');const id=randomUUID(),d=hash(JSON.stringify([r.id,m.id,id,value]));run('INSERT INTO proposals(id,room,member,text,digest,expires) VALUES(?,?,?,?,?,?)',id,r.id,m.id,value,d,Math.min(r.expires,now()+300000));result={status:'awaiting_approval',proposalId:id,digest:d};}
            run('INSERT INTO requests VALUES(?,?,?,?,?)',m.id,body.requestId,digest,JSON.stringify(result),r.id);db.exec('COMMIT');
          }catch(e){db.exec('ROLLBACK');throw e;}return reply(201,result);
        }
        throw error(404,'Agent operation not available');
      }
      if(!session)throw error(401,'Start a human session');
      if(req.method==='POST'&&!same(req.headers['x-csrf-token'],session.csrf))throw error(403,'Session check failed');
      limit('human:'+session.id);
      if(path==='/api/me'&&req.method==='GET')return reply(200,{id:session.id,name:session.name,csrf:session.csrf,rooms:all('SELECT r.id,r.title,r.expires,m.status FROM rooms r JOIN members m ON m.room=r.id WHERE m.session=? AND r.closed=0 AND r.expires>?',session.id,now())});
      if(path==='/api/logout'&&req.method==='POST'){
        fields(body,[]);run('DELETE FROM rooms WHERE id IN (SELECT room FROM members WHERE session=?)',session.id);run('DELETE FROM sessions WHERE id=?',session.id);
        return reply(200,{ended:true},{'Set-Cookie':`al_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${expected.protocol==='https:'?'; Secure':''}`});
      }
      if(path==='/api/rooms'&&req.method==='POST'){
        fields(body,['title','agentName']);if(one('SELECT count(*) n FROM rooms WHERE host=?',session.id).n>=5||one('SELECT count(*) n FROM rooms').n>=200)throw error(429,'Room limit reached');
        const title=text(body.title,100),agentName=text(body.agentName,60),id=randomUUID(),code=randomBytes(9).toString('base64url'),mid=randomUUID();
        run('INSERT INTO rooms(id,host,code_hash,title,expires) VALUES(?,?,?,?,?)',id,session.id,hash(code),title,now()+roomTtl);
        run('INSERT INTO members(id,room,session,name,agent_name,status) VALUES(?,?,?,?,?,?)',mid,id,session.id,session.name,agentName,'accepted');
        return reply(201,{id,code});
      }
      if(path==='/api/join'&&req.method==='POST'){
        fields(body,['code','agentName']);limit('join:'+session.id,10);limit('join-ip:'+req.socket.remoteAddress,40);
        const code=text(body.code,30),agentName=text(body.agentName,60);const r=one('SELECT * FROM rooms WHERE code_hash=? AND closed=0 AND expires>?',hash(code),now());if(!r)throw error(404,'Code invalid or room expired');
        const existing=one('SELECT * FROM members WHERE room=? AND session=?',r.id,session.id);if(existing)return reply(200,{id:r.id,status:existing.status});
        if(one('SELECT count(*) n FROM members WHERE room=?',r.id).n>=12)throw error(429,'Room join request limit reached');
        const id=randomUUID();run('INSERT INTO members(id,room,session,name,agent_name,status) VALUES(?,?,?,?,?,?)',id,r.id,session.id,session.name,agentName,'waiting');return reply(201,{id:r.id,status:'waiting'});
      }
      const match=path.match(/^\/api\/rooms\/([a-f0-9-]{36})(?:\/(admit|credential|revoke|policy|message|decision|close|code))?$/);
      if(!match)throw error(404,'Not found');
      const r=room(match[1]),m=member(r,session.id),operation=match[2];
      if(!operation&&req.method==='GET'){
        const isHost=r.host===session.id;
        const participants=all('SELECT * FROM members WHERE room=?',r.id).filter(x=>isHost||x.status==='accepted'||x.id===m.id).map(cleanMember);
        if(m.status!=='accepted')return reply(200,{id:r.id,title:r.title,expires:r.expires,self:cleanMember(m),host:false,participants,events:[],proposals:[]});
        return reply(200,{id:r.id,title:r.title,expires:r.expires,self:cleanMember(m),host:isHost,participants,events:all('SELECT id,member,actor,kind,text,private_to,at FROM events WHERE room=? AND (private_to IS NULL OR private_to=?) ORDER BY id',r.id,m.id),proposals:all("SELECT id,text,digest,status,expires FROM proposals WHERE room=? AND member=? AND status='pending'",r.id,m.id)});
      }
      admitted(m);if(req.method!=='POST')throw error(405,'Method not allowed');
      if(operation==='admit'){
        fields(body,['memberId','accept']);if(r.host!==session.id)throw error(403,'Only host can admit');if(typeof body.accept!=='boolean'||typeof body.memberId!=='string')throw error(400,'Choose a request and accept or decline');
        const target=one("SELECT * FROM members WHERE id=? AND room=? AND status='waiting'",body.memberId,r.id);if(!target)throw error(409,'Request already resolved');
        if(body.accept&&one("SELECT count(*) n FROM members WHERE room=? AND status='accepted'",r.id).n>=2)throw error(409,'This version supports two human-agent pairs');
        run('UPDATE members SET status=? WHERE id=?',body.accept?'accepted':'declined',target.id);event(r,m,'system','membership',`${target.name} ${body.accept?'joined':'was declined'}`);return reply(200,{ok:true});
      }
      if(operation==='credential'){
        fields(body,[]);const value=secret();run('DELETE FROM tokens WHERE member=?',m.id);run('INSERT INTO tokens VALUES(?,?,?)',hash(value),m.id,r.expires);return reply(201,{token:value,expires:r.expires,scope:'This agent in this room only',url:origin});
      }
      if(operation==='revoke'){fields(body,[]);run('DELETE FROM tokens WHERE member=?',m.id);run("UPDATE members SET agent_status='offline',last_seen=0 WHERE id=?",m.id);return reply(200,{revoked:true});}
      if(operation==='policy'){
        fields(body,['automatic']);if(typeof body.automatic!=='boolean')throw error(400,'Choose a sharing policy');run('UPDATE members SET automatic=? WHERE id=?',Number(body.automatic),m.id);event(r,m,'human','policy',body.automatic?'Enabled automatic room messages for own agent':'Enabled review before sharing for own agent');return reply(200,{automatic:body.automatic});
      }
      if(operation==='message'){
        fields(body,['text','visibility']);if(!['private','room'].includes(body.visibility))throw error(400,'Choose visibility');const id=event(r,m,'human','message',text(body.text),body.visibility==='private'?m.id:null);return reply(201,{eventId:id});
      }
      if(operation==='decision'){
        fields(body,['id','digest','decision','text']);if(!['approve','reject'].includes(body.decision)||typeof body.id!=='string'||typeof body.digest!=='string')throw error(400,'Invalid decision');
        const p=one('SELECT * FROM proposals WHERE id=? AND room=? AND member=?',body.id,r.id,m.id);if(!p)throw error(404,'Proposal not found');if(p.status!=='pending'||p.expires<=now()||!same(body.digest,p.digest))throw error(409,'Proposal changed, expired, or already decided');
        const approved=body.decision==='approve';const value=approved?text(body.text??p.text):body.text?text(body.text):'Please revise your proposed message.';
        db.exec('BEGIN IMMEDIATE');try{run('UPDATE proposals SET status=? WHERE id=?',approved?'approved':'rejected',p.id);event(r,m,approved?'agent':'human',approved?'approved-message':'feedback',value,approved?null:m.id);event(r,m,'human','decision',approved?'Approved agent message':'Requested changes',m.id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
        return reply(200,{status:approved?'approved':'rejected'});
      }
      if(operation==='code'){fields(body,[]);if(r.host!==session.id)throw error(403,'Only host can rotate invite');const code=randomBytes(9).toString('base64url');run('UPDATE rooms SET code_hash=? WHERE id=?',hash(code),r.id);return reply(200,{code});}
      if(operation==='close'){fields(body,[]);run('DELETE FROM rooms WHERE id=?',r.id);return reply(200,{closed:true});}
      throw error(404,'Not found');
    }catch(e){reply(e.status||500,{error:e.status?e.message:'Server error'});}
  });
  server.requestTimeout=25000;server.headersTimeout=10000;server.timeout=30000;
  const cleanup=setInterval(purge,30000);cleanup.unref();server.on('close',()=>{clearInterval(cleanup);db.close();});return server;
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  const port=Number(process.env.PORT||8770),host=process.env.HOST||'127.0.0.1';
  const publicOrigin=process.env.PUBLIC_ORIGIN||`http://127.0.0.1:${port}`;
  const origin=new URL(publicOrigin);
  if(origin.origin!==publicOrigin||origin.username||origin.password)throw new Error('PUBLIC_ORIGIN must be an exact origin');
  if(origin.protocol!=='https:'&&!(host==='127.0.0.1'&&origin.hostname==='127.0.0.1'))throw new Error('Remote use requires HTTPS via a trusted reverse proxy');
  const dir=new URL('./.local/',import.meta.url);await mkdir(dir,{recursive:true});
  createApp({database:fileURLToPath(new URL('rooms.sqlite',dir)),publicOrigin}).listen(port,host,()=>console.log(`Agent Link: ${publicOrigin} (guest sessions; room access requires host approval)`));
}
