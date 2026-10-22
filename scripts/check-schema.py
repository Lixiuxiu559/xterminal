"""在临时内存数据库中校验架构 DDL 与关键约束，不访问用户数据。"""
import sqlite3
from pathlib import Path

source = Path(__file__).resolve().parents[1] / 'docs/architecture/schema.sql'
db = sqlite3.connect(':memory:')
db.executescript(source.read_text())
now = '2026-10-22T00:00:00.000Z'
for project in ('p1', 'p2'):
    db.execute('INSERT INTO projects VALUES (?, ?, ?, ?, ?)', (project, project, '/' + project, now, now))
for sid, pid, engine in [('s1', 'p1', 'claude'), ('s2', 'p2', 'codex')]:
    db.execute('INSERT INTO sessions(id, project_id, engine, title, initial_cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', (sid, pid, engine, sid, '/' + pid, now, now))


def rejected(sql, params=(), contains=None):
    try:
        db.execute(sql, params)
    except sqlite3.IntegrityError as error:
        if contains:
            assert contains in str(error), str(error)
    else:
        raise AssertionError('本应拒绝的 SQL 成功执行：' + sql)


rejected("UPDATE sessions SET engine='shell' WHERE id='s1'", contains='SESSION_ENGINE_IMMUTABLE')
assert db.execute("SELECT engine FROM sessions WHERE id='s1'").fetchone()[0] == 'claude'
rejected("UPDATE sessions SET project_id='p2' WHERE id='s1'", contains='SESSION_PROJECT_IMMUTABLE')
rejected("UPDATE sessions SET initial_cwd='/elsewhere' WHERE id='s1'", contains='SESSION_PROJECT_IMMUTABLE')
db.execute("UPDATE sessions SET title='重命名' WHERE id='s1'")
assert db.execute("SELECT title FROM sessions WHERE id='s1'").fetchone()[0] == '重命名'
for rid, sid in [('r1', 's1'), ('r2', 's2')]:
    db.execute('INSERT INTO runs(id, session_id, host_instance_id, kind, status, started_at) VALUES (?, ?, ?, ?, ?, ?)', (rid, sid, 'host-a', 'agent-turn', 'running', now))
rejected('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ('m1', 's1', 'r2', 'assistant', 'completed', '{}', 0, now), 'FOREIGN KEY')
rejected('INSERT INTO runs(id, session_id, host_instance_id, kind, status, started_at) VALUES (?, ?, ?, ?, ?, ?)', ('r3', 's1', 'host-a', 'agent-turn', 'running', now), 'UNIQUE')
db.execute("UPDATE runs SET status='completed' WHERE id='r1'")
db.execute('INSERT INTO runs(id, session_id, host_instance_id, kind, status, started_at) VALUES (?, ?, ?, ?, ?, ?)', ('r3', 's1', 'host-a', 'agent-turn', 'running', now))
event = ('s1', 1, 'e1', 1, 'r3', 'run.started', '{}', now)
db.execute('INSERT INTO session_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)', event)
rejected('INSERT INTO session_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ('s1', 1, 'e2', 1, 'r3', 'run.started', '{}', now), 'UNIQUE')
receipt = ('desktop', 's1', 'c1', 'agent.turn.start', 'hash', 'accepted', None, now, now)
db.execute('INSERT INTO command_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', receipt)
rejected('INSERT INTO command_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', receipt, 'UNIQUE')
assert db.execute('SELECT count(*) FROM command_receipts').fetchone()[0] == 1
assert db.execute('PRAGMA foreign_key_check').fetchall() == []
print('SQLite DDL 与 S01–S05 约束校验通过；未连接真实数据库。')
db.close()
