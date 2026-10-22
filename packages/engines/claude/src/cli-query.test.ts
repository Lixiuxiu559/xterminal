import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import type { SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEngineEvent } from '../../../protocol/src/agent.ts';
import { cliQuery } from './cli-query.ts';
import { ClaudeRuntime } from './runtime.ts';

async function waitFor(check: () => unknown) {
  const until = Date.now() + 3000;
  while (!check()) { if (Date.now() >= until) assert.fail('fake subprocess did not respond'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
const fakeProgram = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const log = process.argv[2];
let active;
function send(frame, fragmented = false) {
  const buffer = Buffer.from(JSON.stringify(frame) + '\n');
  if (!fragmented) return process.stdout.write(buffer);
  const point = buffer.indexOf(Buffer.from('你')) + 1;
  process.stdout.write(buffer.subarray(0, point));
  setImmediate(() => process.stdout.write(buffer.subarray(point)));
}
function result(extra = {}) { send({type:'result',subtype:'success',is_error:false,result:'最终回答',session_id:'native-test',user_message_uuid:active.uuid,...extra}); }
const rl = readline.createInterface({input:process.stdin});
rl.on('line', line => {
  const frame = JSON.parse(line);
  fs.appendFileSync(log, JSON.stringify(frame)+'\n');
  if (frame.type === 'control_request') {
    send({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response:frame.request.subtype==='interrupt'?{still_queued:[]}:{}}});
    if (frame.request.subtype === 'interrupt') result({terminal_reason:'aborted_streaming'});
  } else if (frame.type === 'user') {
    active = frame;
    send({type:'system',subtype:'init',session_id:'native-test'});
    const text = frame.message.content;
    if (text === 'oversize') { process.stdout.write('x'.repeat(2048)+'\n'); return; }
    if (text === 'unknown') { send({type:'control_request',request_id:'unknown',request:{subtype:'oauth_token_refresh'}}); return; }
    if (text === 'permission') { send({type:'control_request',request_id:'permit-1',request:{subtype:'can_use_tool',tool_name:'Bash',tool_use_id:'tool-1',input:{command:'echo hello'}}}); return; }
    send({type:'stream_event',session_id:'native-test',parent_tool_use_id:null,event:{type:'message_start',message:{id:'message-'+frame.uuid}}});
    send({type:'stream_event',session_id:'native-test',parent_tool_use_id:null,event:{type:'content_block_delta',delta:{type:'text_delta',text:'你好🚀'}}},true);
    if (text !== 'interrupt') setTimeout(() => result(),10);
  } else if (frame.type === 'control_response' && frame.response.request_id === 'permit-1') result();
});
rl.on('close', () => process.exit(0));
`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'xterminal-claude-cli-'));
  const script = join(root, 'fake-cli.cjs'), log = join(root, 'frames.jsonl');
  writeFileSync(script, fakeProgram);
  const events: AgentEngineEvent[] = [];
  let child: ReturnType<typeof spawn> | undefined;
  let args: string[] = [], command = '', spawnCount = 0;
  const runtime = new ClaudeRuntime({ cwd: root, nativeContextId: 'native-test', executablePath: '/official/claude', onEvent: event => events.push(event) }, {
    spawn: options => {
      args = options.args; command = options.command; spawnCount++;
      child = spawn(process.execPath, [script, log], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
      return child as SpawnedProcess;
    },
    timeoutMs: 1000,
  });
  return { root, runtime, events, get args() { return args; }, get command() { return command; }, get spawnCount() { return spawnCount; }, get child() { return child; }, frames: () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)), cleanup: async () => { await runtime.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('default production transport uses an unmodified CLI, fragmented UTF-8 and native permission responses', async () => {
  const f = fixture();
  try {
    await f.runtime.startTurn({ runId: 'permission-run', text: 'permission' });
    await waitFor(() => f.events.some(e => e.type === 'interaction'));
    const interaction = f.events.find(e => e.type === 'interaction');
    if (interaction?.type !== 'interaction') throw new Error('missing permission');
    await f.runtime.respond(interaction.interaction.id, { action: 'allow-once' });
    await waitFor(() => f.events.some(e => e.type === 'turn.completed'));
    assert.equal(f.command, '/official/claude');
    assert.ok(f.args.includes('--permission-prompt-tool=stdio'));
    assert.deepEqual(f.args.slice(-2), ['--resume', 'native-test']);
    for (const forbidden of ['--bare', '--dangerously-skip-permissions', '--system-prompt', '--setting-sources']) assert.equal(f.args.includes(forbidden), false);
    const permission = f.frames().find(frame => frame.type === 'control_response');
    assert.deepEqual(permission.response, { subtype: 'success', request_id: 'permit-1', response: { behavior: 'allow', updatedInput: { command: 'echo hello' }, toolUseID: 'tool-1' } });
    await f.runtime.startTurn({ runId: 'fragmented-run', text: 'fragmented' });
    await waitFor(() => f.events.filter(e => e.type === 'turn.completed').length === 2);
    assert.ok(f.events.some(e => e.type === 'message.delta' && e.runId === 'fragmented-run' && e.text === '你好🚀'));
    assert.equal(f.spawnCount, 1);
    await f.runtime.close();
    assert.equal(f.child?.exitCode, 0);
  } finally { await f.cleanup(); }
});

test('interrupt sends a correlated control request and waits for the actual terminal result', async () => {
  const f = fixture();
  try {
    await f.runtime.startTurn({ runId: 'interrupted-run', text: 'interrupt' });
    await waitFor(() => f.events.some(e => e.type === 'message.delta'));
    await f.runtime.interrupt('interrupted-run');
    assert.ok(f.events.some(e => e.type === 'turn.completed' && e.outcome === 'interrupted'));
    const controls = f.frames().filter(frame => frame.type === 'control_request');
    assert.deepEqual(controls.map(frame => frame.request.subtype), ['initialize', 'interrupt']);
    assert.notEqual(controls[0].request_id, controls[1].request_id);
  } finally { await f.cleanup(); }
});

test('unknown credential/control requests receive an error and safely terminate instead of being approved', async () => {
  const f = fixture();
  try {
    await f.runtime.startTurn({ runId: 'unknown-run', text: 'unknown' });
    await waitFor(() => f.events.some(e => e.type === 'turn.completed'));
    assert.ok(f.events.some(e => e.type === 'turn.completed' && e.outcome === 'failed'));
    const response = f.frames().find(frame => frame.type === 'control_response');
    assert.equal(response.response.subtype, 'error');
    assert.equal(response.response.request_id, 'unknown');
    assert.equal(JSON.stringify(response).includes('accessToken'), false);
    await f.runtime.close(); assert.equal(f.child?.exitCode, 0);
  } finally { await f.cleanup(); }
});

test('oversized JSONL frames are rejected with bounded buffering and the child is closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xterminal-claude-framing-'));
  const script = join(root, 'fake-cli.cjs'), log = join(root, 'frames.jsonl'); writeFileSync(script, fakeProgram);
  let child: ReturnType<typeof spawn> | undefined;
  const query = cliQuery({ prompt: (async function* () { yield { type: 'user' as const, parent_tool_use_id: null, message: { role: 'user' as const, content: 'oversize' } }; await new Promise(() => {}); })(), options: { spawnClaudeCodeProcess: () => { child = spawn(process.execPath, [script, log], { stdio: ['pipe', 'pipe', 'pipe'] }); return child as SpawnedProcess; } } }, { maxLineBytes: 512, terminateGraceMs: 20 });
  try {
    await assert.rejects(async () => { for await (const _message of query) { /* consume frames */ } }, /超过上限/);
    await waitFor(() => child?.exitCode !== null);
  } finally { query.close(); child?.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }); }
});

test('stdin writes respect drain/backpressure and prompts wait for initialize acknowledgment', async () => {
  const callbacks: Array<() => void> = [], writes: string[] = [];
  const child = new EventEmitter() as EventEmitter & { stdin: Writable; stdout: PassThrough; exitCode: null; killed: boolean; kill: () => boolean };
  child.stdin = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) { writes.push(chunk.toString()); callbacks.push(callback); } });
  child.stdout = new PassThrough(); child.exitCode = null; child.killed = false; child.kill = () => true;
  const query = cliQuery({ prompt: (async function* () { for (const content of ['first', 'second']) yield { type: 'user' as const, parent_tool_use_id: null, message: { role: 'user' as const, content } }; await new Promise(() => {}); })(), options: { spawnClaudeCodeProcess: () => child as unknown as SpawnedProcess } });
  try {
    await waitFor(() => writes.length === 1);
    assert.equal(JSON.parse(writes[0]).request.subtype, 'initialize');
    callbacks.shift()!(); await new Promise(resolve => setImmediate(resolve)); assert.equal(writes.length, 1);
    child.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: JSON.parse(writes[0]).request_id, response: {} } }) + '\n');
    await waitFor(() => writes.length === 2);
    assert.equal(JSON.parse(writes[1]).message.content, 'first');
    await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(writes.length, 2);
    callbacks.shift()!(); await waitFor(() => writes.length === 3);
    assert.equal(JSON.parse(writes[2]).message.content, 'second'); callbacks.shift()!();
  } finally { query.close(); child.emit('exit', 0, null); }
});

test('guard construction or missing input FD fails only after the actual spawned child exits', async () => {
  for (const missingInput of [false, true]) {
    let child: ReturnType<typeof spawn> | undefined;
    const events: AgentEngineEvent[] = [];
    const runtime = new ClaudeRuntime({ cwd: tmpdir(), nativeContextId: null, onEvent: event => events.push(event) }, {
      spawn: () => {
        child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: [missingInput ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
        return child as unknown as SpawnedProcess;
      },
      guard: () => { throw new Error('injected guard setup failure'); }, timeoutMs: 1000,
    });
    try {
      await assert.rejects(runtime.startTurn({ runId: 'failed-guard', text: 'MUST_NOT_DISPATCH' }), missingInput ? /不兼容的本机管道/ : /injected guard/);
      assert.ok(child); assert.equal(child.signalCode, 'SIGKILL');
      assert.ok(events.some(event => event.type === 'turn.completed' && event.outcome === 'failed'));
      await runtime.close();
    } finally { child?.kill('SIGKILL'); await runtime.close(); }
  }
});
