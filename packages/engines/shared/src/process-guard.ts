import { spawn, type ChildProcess } from 'node:child_process';

// A separate, short-lived process holds the Host's lifetime pipe. Unlike an
// on-exit handler this also runs after SIGKILL. Never scans old PID journals.
const SCRIPT = String.raw`
root=$1
owner=$2
identity() { /bin/ps -p "$1" -o lstart= 2>/dev/null; }
born=$(identity "$root")
owner_group=$(/bin/ps -p "$owner" -o pgid= 2>/dev/null | tr -d ' ')
root_group=$(/bin/ps -p "$root" -o pgid= 2>/dev/null | tr -d ' ')
[ -n "$born" ] && [ -n "$owner_group" ] && [ -n "$root_group" ] && [ "$owner_group" != "$root_group" ] || exit 71
printf 'READY\n'
if IFS= read -r action; then
  [ "$action" = cancel ] && exit 0
fi
# The PTY master, when supplied as fd 3, remains open until cleanup ends. This
# keeps the interactive shell alive long enough to verify its original identity.
[ "$(identity "$root")" = "$born" ] || exit 0
members=$(/bin/ps -axo pid=,ppid=,pgid=,lstart= | /usr/bin/awk -v root="$root" '
{ pid[NR]=$1; parent[$1]=$2; group[$1]=$3; birth[$1]=$4" "$5" "$6" "$7" "$8 }
END { own[root]=1; for (pass=0;pass<NR;pass++) { changed=0; for(i=1;i<=NR;i++) if(own[parent[pid[i]]] && !own[pid[i]]) {own[pid[i]]=1;changed=1} if(!changed)break }
for(i=NR;i>=1;i--) if(own[pid[i]] && pid[i]!=root) print pid[i]"|"group[pid[i]]"|"birth[pid[i]]; print root"|"group[root]"|"birth[root] }')
# Signal descendants before the root. Group signaling includes forks made during
# cleanup, but only while a recorded, birth-verified member still anchors the group.
signal_members() {
  sig=$1
  printf '%s\n' "$members" | while IFS='|' read -r pid group birth; do
    [ -n "$pid" ] && [ "$group" != "$owner_group" ] || continue
    current=$(identity "$pid" | /usr/bin/awk '{$1=$1;print}')
    [ "$current" = "$birth" ] || continue
    current_group=$(/bin/ps -p "$pid" -o pgid= 2>/dev/null | tr -d ' ')
    [ "$current_group" = "$group" ] || continue
    /bin/kill -"$sig" -- -"$group" 2>/dev/null
  done
}
signal_members TERM
/bin/sleep 0.6
signal_members KILL
exit 0
`;

export interface ProcessGuard { ready: Promise<void>; dispose(): void }
export function guardProcess(pid: number, onFailure: (error: Error) => void, holdFd?: number): ProcessGuard {
  if (!Number.isInteger(pid) || pid <= 1 || (holdFd !== undefined && (!Number.isInteger(holdFd) || holdFd < 0))) throw new Error('无法核验进程监护参数');
  const guard: ChildProcess = spawn('/bin/sh', ['-c', SCRIPT, 'xterminal-process-guard', String(pid), String(process.pid)], {
    stdio: ['pipe', 'pipe', 'ignore', ...(holdFd === undefined ? [] : [holdFd])],
    windowsHide: true,
  });
  let disposed = false; let settled = false; let failed = false;
  let resolveReady!: () => void; let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Constructor callers may not await until their engine handshake begins.
  void ready.catch(() => {});
  const fail = () => {
    if (disposed || failed) return;
    failed = true; clearTimeout(timeout);
    const error = new Error('无法建立本机进程监护，已阻止继续执行');
    if (!settled) { settled = true; rejectReady(error); }
    guard.stdin?.destroy();
    onFailure(error);
  };
  const timeout = setTimeout(fail, 3000); timeout.unref();
  let greeting = '';
  guard.stdout?.on('data', (chunk: Buffer) => {
    if (settled) return;
    greeting += String(chunk);
    if (greeting.length > 64) { fail(); return; }
    if (!greeting.includes('\n')) return;
    if (greeting.trim() !== 'READY') { fail(); return; }
    settled = true; clearTimeout(timeout); resolveReady();
  });
  guard.once('error', fail);
  guard.once('exit', () => { clearTimeout(timeout); if (!disposed) fail(); });
  guard.stdin?.on('error', () => { if (!disposed) fail(); });
  return { ready, dispose() {
    if (disposed) return; disposed = true; clearTimeout(timeout);
    guard.stdin?.end('cancel\n');
    if (!settled) { settled = true; rejectReady(new Error('进程在监护建立前结束')); }
  } };
}

/** Keep the child's stdin open independently of the Host's write end. */
export function childInputFd(child: { stdin: unknown }): number {
  const fd = (child.stdin as { _handle?: { fd?: number } } | null)?._handle?.fd;
  if (!Number.isInteger(fd) || fd! < 0) throw new Error('不兼容的本机管道：无法建立进程监护');
  return fd!;
}
