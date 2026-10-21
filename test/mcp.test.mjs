import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.mjs';

test('MCP initialization and real room tools work over stdio without human authority',async t=>{
 const server=createApp();server.listen(0,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:'+server.address().port;
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 let cookie='',csrf='';async function human(path,body){const r=await fetch(url+path,{method:body===undefined?'GET':'POST',headers:{Origin:url,Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body)});cookie=r.headers.get('set-cookie')?.split(';')[0]||cookie;assert.ok(r.ok);return r.json();}
 const session=await human('/api/session',{name:'Connector tester'});csrf=session.csrf;const room=await human('/api/rooms',{title:'MCP integration',agentName:'External agent'});const key=await human('/api/rooms/'+room.id+'/credential',{});
 const child=spawn(process.execPath,[fileURLToPath(new URL('../mcp.mjs',import.meta.url))],{env:{...process.env,AGENT_LINK_URL:url,AGENT_LINK_TOKEN:key.token},stdio:['pipe','pipe','pipe'],windowsHide:true});
 t.after(()=>{child.kill();});
 const pending=new Map();const lines=createInterface({input:child.stdout});lines.on('line',line=>{const value=JSON.parse(line);const waiter=pending.get(value.id);if(waiter){pending.delete(value.id);waiter(value);}});
 let next=0;function call(method,params){const id=++next;return new Promise((resolve,reject)=>{const deadline=setTimeout(()=>reject(new Error('MCP response timeout')),5000);pending.set(id,r=>{clearTimeout(deadline);resolve(r);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
 assert.equal((await call('tools/list')).error.code,-32002);
 const init=await call('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}});assert.equal(init.result.serverInfo.name,'agent-link');child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 const listed=(await call('tools/list')).result.tools;assert.equal(listed.length,4);assert.ok(!listed.some(t=>/approve|credential|policy/.test(t.name)));
 const reply=await call('tools/call',{name:'room_reply',arguments:{text:'A real connector message',requestId:randomUUID()}});assert.equal(JSON.parse(reply.result.content[0].text).status,'delivered');
 const read=await call('tools/call',{name:'room_read',arguments:{after:0}});assert.ok(JSON.parse(read.result.content[0].text).events.some(e=>e.text==='A real connector message'));
 await human('/api/rooms/'+room.id+'/policy',{outgoingReview:true});
 const held=await call('tools/call',{name:'room_reply',arguments:{text:'A real connector proposal',requestId:randomUUID()}});assert.equal(JSON.parse(held.result.content[0].text).status,'awaiting_approval');
 const privateReply=await call('tools/call',{name:'human_reply',arguments:{text:'Private connector reply',requestId:randomUUID()}});assert.equal(JSON.parse(privateReply.result.content[0].text).status,'delivered');
 const view=await human('/api/rooms/'+room.id);assert.equal(view.proposals[0].text,'A real connector proposal');assert.ok(view.events.some(e=>!e.private_to&&e.text==='A real connector message'));assert.ok(!view.events.some(e=>e.text==='A real connector proposal'));assert.ok(view.events.some(e=>e.private_to&&e.text==='Private connector reply'));
 const bad=await call('tools/call',{name:'room_reply',arguments:{text:'Fake approval',requestId:randomUUID(),approved:true}});assert.equal(bad.result.isError,true);
});
