"""Move vault data between S3 (transfer bucket) and EFS.

Events:
  {"action": "status"}                       -> list files on EFS
  {"action": "import", "key": "<s3 key>", "keep": false} -> replace EFS contents with tarball (deleted unless keep)
  {"action": "export"}                       -> consistent tarball of EFS -> s3 exports/<ts>.tar.gz
"""
import os, shutil, sqlite3, tarfile, time
import boto3

DATA = "/mnt/vw"
BUCKET = os.environ["BUCKET"]
s3 = boto3.client("s3", region_name="us-east-1", endpoint_url="https://s3.us-east-1.amazonaws.com")
SKIP = {"tmp", "icon_cache"}


def _status():
    out = []
    for root, dirs, files in os.walk(DATA):
        dirs[:] = [d for d in dirs if d not in SKIP]
        for f in files:
            p = os.path.join(root, f)
            out.append({"path": os.path.relpath(p, DATA), "bytes": os.path.getsize(p)})
    return {"files": sorted(out, key=lambda x: x["path"])}


def _safe_members(tar):
    for m in tar.getmembers():
        name = os.path.normpath(m.name)
        if os.path.basename(name).startswith("._"):
            continue  # macOS AppleDouble metadata
        if name.startswith("..") or os.path.isabs(name) or m.issym() or m.islnk() or m.isdev():
            raise ValueError(f"refusing unsafe tar member: {m.name}")
        yield m


def _import(key, keep=False):
    local = "/tmp/import.tar.gz"
    s3.download_file(BUCKET, key, local)
    with tarfile.open(local) as tar:
        members = list(_safe_members(tar))
        names = {os.path.normpath(m.name) for m in members}
        if "db.sqlite3" not in names or "rsa_key.pem" not in names:
            raise ValueError("tarball must contain db.sqlite3 and rsa_key.pem at its root")
        for entry in os.listdir(DATA):
            p = os.path.join(DATA, entry)
            shutil.rmtree(p) if os.path.isdir(p) and not os.path.islink(p) else os.remove(p)
        tar.extractall(DATA, members=members, filter="data")
    for side in ("-wal", "-shm"):
        try: os.remove(os.path.join(DATA, "db.sqlite3" + side))
        except FileNotFoundError: pass
    conn = sqlite3.connect(os.path.join(DATA, "db.sqlite3"))
    conn.execute("PRAGMA journal_mode=DELETE")  # WAL is unsafe on EFS (NFS)
    users = conn.execute("select count(*) from users").fetchone()[0]
    items = conn.execute("select count(*) from ciphers").fetchone()[0]
    integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
    conn.close()
    if not keep:
        s3.delete_object(Bucket=BUCKET, Key=key)
    os.remove(local)
    return {"imported": key, "users": users, "items": items, "integrity": integrity, **_status()}


def _export():
    work = "/tmp/export"
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)
    src = sqlite3.connect(os.path.join(DATA, "db.sqlite3"))
    dst = sqlite3.connect(os.path.join(work, "db.sqlite3"))
    src.backup(dst)  # consistent snapshot even if Vaultwarden is writing
    src.close(); dst.close()
    for entry in os.listdir(DATA):
        if entry in SKIP or entry.startswith("db.sqlite3"):
            continue
        p = os.path.join(DATA, entry)
        (shutil.copytree if os.path.isdir(p) else shutil.copy2)(p, os.path.join(work, entry))
    key = time.strftime("exports/vault-%Y%m%d-%H%M%S.tar.gz")
    tmp = "/tmp/export.tar.gz"
    with tarfile.open(tmp, "w:gz") as tar:
        for entry in os.listdir(work):
            tar.add(os.path.join(work, entry), arcname=entry)
    s3.upload_file(tmp, BUCKET, key)
    shutil.rmtree(work); os.remove(tmp)
    return {"exported": key}


def handler(event, _ctx):
    action = (event or {}).get("action", "status")
    if action == "status":
        return _status()
    if action == "import":
        return _import(event["key"], bool(event.get("keep")))
    if action == "export":
        return _export()
    raise ValueError(f"unknown action {action}")
