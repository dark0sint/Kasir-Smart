#!/usr/bin/env python3
"""
Kasir Smart - Server POS untuk UMKM
Hanya memakai Python standar (tanpa pip install). Database: SQLite.

Jalankan:   python3 server.py
Env opsional:
  KASIR_HOST (default 0.0.0.0)   KASIR_PORT (default 8080)
  KASIR_DB   (default ./data/kasir.db)
  KASIR_TZ   selisih jam dari UTC (default 7 = WIB)
"""
import hashlib
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "static")
DB_PATH = os.environ.get("KASIR_DB", os.path.join(BASE, "data", "kasir.db"))
HOST = os.environ.get("KASIR_HOST", "0.0.0.0")
PORT = int(os.environ.get("KASIR_PORT", "8080"))
TZ_HOURS = float(os.environ.get("KASIR_TZ", "7"))
SESSION_DAYS = 14
MAX_BODY = 3 * 1024 * 1024
PAYMENT_METHODS = ("tunai", "qris", "debit", "kredit", "ewallet")

_fail = {}  # ip -> [timestamps] untuk pembatasan percobaan login


def now():
    return (datetime.now(timezone.utc) + timedelta(hours=TZ_HOURS)).strftime("%Y-%m-%d %H:%M:%S")


def today():
    return now()[:10]


# ----------------------------------------------------------------- database
SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  salt TEXT NOT NULL, pw TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'kasir', active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS products(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, barcode TEXT UNIQUE, category TEXT DEFAULT '',
  price INTEGER NOT NULL DEFAULT 0, cost INTEGER NOT NULL DEFAULT 0,
  stock REAL NOT NULL DEFAULT 0, min_stock REAL NOT NULL DEFAULT 0,
  unit TEXT DEFAULT 'pcs', active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS variants(
  id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL,
  name TEXT NOT NULL, barcode TEXT UNIQUE,
  price INTEGER NOT NULL DEFAULT 0, cost INTEGER NOT NULL DEFAULT 0,
  stock REAL NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS sales(
  id INTEGER PRIMARY KEY AUTOINCREMENT, invoice TEXT UNIQUE NOT NULL,
  client_id TEXT UNIQUE, user_id INTEGER, cashier TEXT,
  customer TEXT DEFAULT '', customer_phone TEXT DEFAULT '', note TEXT DEFAULT '',
  subtotal INTEGER NOT NULL, discount INTEGER NOT NULL DEFAULT 0,
  tax INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL,
  paid INTEGER NOT NULL, change INTEGER NOT NULL DEFAULT 0,
  method TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'paid',
  created_at TEXT NOT NULL, voided_at TEXT, void_by TEXT);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(created_at);
CREATE TABLE IF NOT EXISTS sale_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id INTEGER NOT NULL,
  product_id INTEGER, variant_id INTEGER, name TEXT NOT NULL,
  qty REAL NOT NULL, price INTEGER NOT NULL, cost INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_items_sale ON sale_items(sale_id);
CREATE TABLE IF NOT EXISTS stock_moves(
  id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER, variant_id INTEGER,
  name TEXT, qty REAL NOT NULL, type TEXT NOT NULL, note TEXT DEFAULT '',
  user TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS expenses(
  id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL,
  category TEXT DEFAULT '', amount INTEGER NOT NULL, note TEXT DEFAULT '', user TEXT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
"""

DEFAULT_SETTINGS = {
    "store_name": "Toko Saya",
    "address": "Jl. Contoh No. 1",
    "phone": "",
    "footer": "Terima kasih, selamat datang kembali!",
    "tax_percent": "0",
    "paper": "58",
    "qris_image": "",
    "allow_negative": "0",
}


def db():
    c = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys=ON")
    return c


def hash_pw(pw, salt=None):
    salt = salt or secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), 150000).hex()
    return salt, h


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    c = db()
    c.execute("PRAGMA journal_mode=WAL")
    c.executescript(SCHEMA)
    for k, v in DEFAULT_SETTINGS.items():
        c.execute("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)", (k, v))
    if c.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0:
        salt, h = hash_pw(os.environ.get("KASIR_ADMIN_PASSWORD", "admin123"))
        c.execute("INSERT INTO users(username,name,salt,pw,role,created_at) VALUES(?,?,?,?,?,?)",
                  ("admin", "Pemilik", salt, h, "owner", now()))
        salt, h = hash_pw("kasir123")
        c.execute("INSERT INTO users(username,name,salt,pw,role,created_at) VALUES(?,?,?,?,?,?)",
                  ("kasir", "Kasir 1", salt, h, "kasir", now()))
        demo = [
            ("Air Mineral 600ml", "8991234500011", "Minuman", 4000, 2500, 48, 12, "botol"),
            ("Mie Instan Goreng", "8991234500028", "Makanan", 3500, 2800, 60, 20, "bungkus"),
            ("Kopi Sachet", "8991234500035", "Minuman", 2000, 1400, 8, 15, "sachet"),
            ("Roti Tawar", "8991234500042", "Makanan", 16000, 12500, 10, 5, "pcs"),
            ("Gula Pasir 1kg", "8991234500059", "Sembako", 17000, 15000, 25, 10, "kg"),
        ]
        for n, b, cat, p, co, s, ms, u in demo:
            c.execute("INSERT INTO products(name,barcode,category,price,cost,stock,min_stock,unit) VALUES(?,?,?,?,?,?,?,?)",
                      (n, b, cat, p, co, s, ms, u))
        cur = c.execute("INSERT INTO products(name,category,price,cost,stock,min_stock,unit) VALUES(?,?,?,?,?,?,?)",
                        ("Kaos Polos", "Fashion", 60000, 35000, 0, 0, "pcs"))
        pid = cur.lastrowid
        for vn, st in (("S - Hitam", 10), ("M - Hitam", 12), ("L - Putih", 4)):
            c.execute("INSERT INTO variants(product_id,name,price,cost,stock) VALUES(?,?,?,?,?)",
                      (pid, vn, 60000, 35000, st))
    c.close()


def get_settings(c, public=True):
    return {r["key"]: r["value"] for r in c.execute("SELECT key,value FROM settings")}


def rows(c, sql, args=()):
    return [dict(r) for r in c.execute(sql, args)]


def list_products(c):
    prods = rows(c, "SELECT * FROM products WHERE active=1 ORDER BY name COLLATE NOCASE")
    vs = rows(c, "SELECT * FROM variants WHERE active=1 ORDER BY id")
    by = {}
    for v in vs:
        by.setdefault(v["product_id"], []).append(v)
    for p in prods:
        p["variants"] = by.get(p["id"], [])
        if p["variants"]:
            p["stock"] = sum(v["stock"] for v in p["variants"])
    return prods


class ApiError(Exception):
    def __init__(self, code, msg):
        self.code, self.msg = code, msg


def need(cond, msg, code=400):
    if not cond:
        raise ApiError(code, msg)


def to_int(v, default=0):
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return default


def to_num(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def nullable(s):
    s = (s or "").strip() if isinstance(s, str) else s
    return s or None


# ----------------------------------------------------------------- handlers
def h_login(ctx):
    ip = ctx.ip
    ts = [t for t in _fail.get(ip, []) if time.time() - t < 300]
    need(len(ts) < 10, "Terlalu banyak percobaan. Coba lagi dalam 5 menit.", 429)
    b = ctx.body
    u = ctx.c.execute("SELECT * FROM users WHERE username=? AND active=1",
                      ((b.get("username") or "").strip().lower(),)).fetchone()
    ok = False
    if u:
        _, h = hash_pw(b.get("password") or "", u["salt"])
        ok = secrets.compare_digest(h, u["pw"])
    if not ok:
        ts.append(time.time())
        _fail[ip] = ts
        raise ApiError(401, "Username atau password salah")
    _fail.pop(ip, None)
    token = secrets.token_urlsafe(32)
    ctx.c.execute("INSERT INTO sessions(token,user_id,created_at) VALUES(?,?,?)", (token, u["id"], time.time()))
    ctx.c.execute("DELETE FROM sessions WHERE created_at<?", (time.time() - SESSION_DAYS * 86400,))
    return {"token": token, "user": user_pub(u)}


def user_pub(u):
    return {"id": u["id"], "username": u["username"], "name": u["name"], "role": u["role"]}


def h_logout(ctx):
    ctx.c.execute("DELETE FROM sessions WHERE token=?", (ctx.token,))
    return {"ok": True}


def h_bootstrap(ctx):
    c = ctx.c
    s = get_settings(c)
    return {"user": user_pub(ctx.user), "settings": s, "products": list_products(c),
            "server_time": now(), "methods": PAYMENT_METHODS}


def h_change_pw(ctx):
    b = ctx.body
    new = b.get("new") or ""
    need(len(new) >= 6, "Password baru minimal 6 karakter")
    _, h = hash_pw(b.get("old") or "", ctx.user["salt"])
    need(secrets.compare_digest(h, ctx.user["pw"]), "Password lama salah")
    salt, h = hash_pw(new)
    ctx.c.execute("UPDATE users SET salt=?,pw=? WHERE id=?", (salt, h, ctx.user["id"]))
    return {"ok": True}


# --- produk
def save_variants(c, pid, variants, user_name):
    keep = []
    for v in variants or []:
        name = (v.get("name") or "").strip()
        if not name:
            continue
        vals = (name, nullable(v.get("barcode")), to_int(v.get("price")), to_int(v.get("cost")), to_num(v.get("stock")))
        if v.get("id"):
            old = c.execute("SELECT stock FROM variants WHERE id=? AND product_id=?", (v["id"], pid)).fetchone()
            need(old, "Varian tidak ditemukan")
            c.execute("UPDATE variants SET name=?,barcode=?,price=?,cost=?,stock=?,active=1 WHERE id=?", vals + (v["id"],))
            if abs(old["stock"] - vals[4]) > 1e-9:
                c.execute("INSERT INTO stock_moves(product_id,variant_id,name,qty,type,note,user,created_at) VALUES(?,?,?,?,?,?,?,?)",
                          (pid, v["id"], name, vals[4] - old["stock"], "koreksi", "Ubah dari form produk", user_name, now()))
            keep.append(v["id"])
        else:
            cur = c.execute("INSERT INTO variants(product_id,name,barcode,price,cost,stock) VALUES(?,?,?,?,?,?)", (pid,) + vals)
            keep.append(cur.lastrowid)
            if vals[4]:
                c.execute("INSERT INTO stock_moves(product_id,variant_id,name,qty,type,note,user,created_at) VALUES(?,?,?,?,?,?,?,?)",
                          (pid, cur.lastrowid, name, vals[4], "masuk", "Stok awal", user_name, now()))
    if keep:
        c.execute("UPDATE variants SET active=0,barcode=NULL WHERE product_id=? AND id NOT IN (%s)" % ",".join("?" * len(keep)),
                  [pid] + keep)
    else:
        c.execute("UPDATE variants SET active=0,barcode=NULL WHERE product_id=?", (pid,))


def h_product_save(ctx, pid=None):
    b, c = ctx.body, ctx.c
    name = (b.get("name") or "").strip()
    need(name, "Nama produk wajib diisi")
    vals = (name, nullable(b.get("barcode")), (b.get("category") or "").strip(), to_int(b.get("price")),
            to_int(b.get("cost")), to_num(b.get("stock")), to_num(b.get("min_stock")), (b.get("unit") or "pcs").strip())
    need(vals[3] >= 0 and vals[4] >= 0, "Harga tidak boleh negatif")
    try:
        c.execute("BEGIN IMMEDIATE")
        if pid is None:
            cur = c.execute("INSERT INTO products(name,barcode,category,price,cost,stock,min_stock,unit) VALUES(?,?,?,?,?,?,?,?)", vals)
            pid = cur.lastrowid
            if vals[5] and not b.get("variants"):
                c.execute("INSERT INTO stock_moves(product_id,name,qty,type,note,user,created_at) VALUES(?,?,?,?,?,?,?)",
                          (pid, name, vals[5], "masuk", "Stok awal", ctx.user["name"], now()))
        else:
            old = c.execute("SELECT stock FROM products WHERE id=? AND active=1", (pid,)).fetchone()
            need(old, "Produk tidak ditemukan", 404)
            has_var = any((v.get("name") or "").strip() for v in b.get("variants") or [])
            stock = 0 if has_var else vals[5]
            c.execute("UPDATE products SET name=?,barcode=?,category=?,price=?,cost=?,stock=?,min_stock=?,unit=? WHERE id=?",
                      vals[:5] + (stock,) + vals[6:] + (pid,))
            if not has_var and abs(old["stock"] - stock) > 1e-9:
                c.execute("INSERT INTO stock_moves(product_id,name,qty,type,note,user,created_at) VALUES(?,?,?,?,?,?,?)",
                          (pid, name, stock - old["stock"], "koreksi", "Ubah dari form produk", ctx.user["name"], now()))
        save_variants(c, pid, b.get("variants"), ctx.user["name"])
        c.execute("COMMIT")
    except sqlite3.IntegrityError:
        c.execute("ROLLBACK")
        raise ApiError(409, "Barcode sudah dipakai produk lain")
    except Exception:
        if c.in_transaction:
            c.execute("ROLLBACK")
        raise
    return {"id": pid}


def h_product_delete(ctx, pid):
    ctx.c.execute("UPDATE products SET active=0,barcode=NULL WHERE id=?", (pid,))
    ctx.c.execute("UPDATE variants SET active=0,barcode=NULL WHERE product_id=?", (pid,))
    return {"ok": True}


def h_stock_adjust(ctx):
    b, c = ctx.body, ctx.c
    pid, vid = b.get("product_id"), b.get("variant_id")
    mode = b.get("mode", "add")
    qty = to_num(b.get("qty"))
    need(mode in ("add", "set"), "Mode tidak valid")
    c.execute("BEGIN IMMEDIATE")
    try:
        if vid:
            r = c.execute("SELECT v.stock, p.name||' - '||v.name AS n FROM variants v JOIN products p ON p.id=v.product_id WHERE v.id=?", (vid,)).fetchone()
            tbl, key = "variants", vid
        else:
            r = c.execute("SELECT stock, name AS n FROM products WHERE id=?", (pid,)).fetchone()
            tbl, key = "products", pid
        need(r, "Barang tidak ditemukan", 404)
        delta = qty if mode == "add" else qty - r["stock"]
        new = r["stock"] + delta
        need(new >= 0, "Stok tidak boleh negatif")
        c.execute("UPDATE %s SET stock=? WHERE id=?" % tbl, (new, key))
        typ = b.get("type") or ("masuk" if mode == "add" and delta >= 0 else "koreksi")
        c.execute("INSERT INTO stock_moves(product_id,variant_id,name,qty,type,note,user,created_at) VALUES(?,?,?,?,?,?,?,?)",
                  (pid, vid, r["n"], delta, typ, (b.get("note") or "")[:200], ctx.user["name"], now()))
        c.execute("COMMIT")
    except Exception:
        if c.in_transaction:
            c.execute("ROLLBACK")
        raise
    return {"stock": new}


def h_stock_moves(ctx):
    return rows(ctx.c, "SELECT * FROM stock_moves ORDER BY id DESC LIMIT 200")


# --- penjualan
def sale_detail(c, sid):
    s = c.execute("SELECT * FROM sales WHERE id=?", (sid,)).fetchone()
    need(s, "Transaksi tidak ditemukan", 404)
    s = dict(s)
    s["items"] = rows(c, "SELECT product_id,variant_id,name,qty,price,cost FROM sale_items WHERE sale_id=?", (sid,))
    return s


def h_sale_create(ctx):
    b, c, user = ctx.body, ctx.c, ctx.user
    items = b.get("items") or []
    need(items, "Keranjang kosong")
    method = b.get("method", "tunai")
    need(method in PAYMENT_METHODS, "Metode pembayaran tidak valid")
    cid = nullable(b.get("client_id"))
    offline = bool(b.get("offline"))
    c.execute("BEGIN IMMEDIATE")
    try:
        if cid:
            ex = c.execute("SELECT id FROM sales WHERE client_id=?", (cid,)).fetchone()
            if ex:
                c.execute("COMMIT")
                return sale_detail(c, ex["id"])
        st = get_settings(c)
        allow_neg = st.get("allow_negative") == "1" or offline
        lines, subtotal = [], 0
        for it in items:
            qty = to_num(it.get("qty"))
            need(qty > 0, "Jumlah harus lebih dari 0")
            p = c.execute("SELECT * FROM products WHERE id=?", (it.get("product_id"),)).fetchone()
            need(p, "Produk tidak ditemukan")
            v = None
            if it.get("variant_id"):
                v = c.execute("SELECT * FROM variants WHERE id=? AND product_id=?", (it["variant_id"], p["id"])).fetchone()
                need(v, "Varian tidak ditemukan")
            src = v or p
            if not allow_neg:
                need(src["stock"] >= qty, "Stok %s tidak cukup (sisa %g)" % (p["name"], src["stock"]), 409)
            nm = p["name"] + (" - " + v["name"] if v else "")
            lines.append((p["id"], v["id"] if v else None, nm, qty, src["price"], src["cost"]))
            subtotal += int(round(qty * src["price"]))
        dtype, dval = b.get("discount_type", "rp"), to_num(b.get("discount"))
        disc = int(round(subtotal * dval / 100)) if dtype == "pct" else int(round(dval))
        disc = max(0, min(disc, subtotal))
        taxp = to_num(st.get("tax_percent"))
        tax = int(round((subtotal - disc) * taxp / 100))
        total = subtotal - disc + tax
        paid = to_int(b.get("paid"))
        if method != "tunai":
            paid = total
        need(paid >= total, "Uang yang dibayar kurang")
        change = paid - total
        created = now()
        if offline and isinstance(b.get("created_at"), str) and re.match(r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$", b["created_at"]):
            created = b["created_at"]
        prefix = "INV-" + created[:10].replace("-", "") + "-"
        last = c.execute("SELECT invoice FROM sales WHERE invoice LIKE ? ORDER BY id DESC LIMIT 1", (prefix + "%",)).fetchone()
        seq = int(last["invoice"].split("-")[-1]) + 1 if last else 1
        invoice = "%s%04d" % (prefix, seq)
        cur = c.execute(
            "INSERT INTO sales(invoice,client_id,user_id,cashier,customer,customer_phone,note,subtotal,discount,tax,total,paid,change,method,created_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (invoice, cid, user["id"], user["name"], (b.get("customer") or "")[:80], (b.get("customer_phone") or "")[:30],
             (b.get("note") or "")[:200], subtotal, disc, tax, total, paid, change, method, created))
        sid = cur.lastrowid
        low = []
        for pid, vid, nm, qty, price, cost in lines:
            c.execute("INSERT INTO sale_items(sale_id,product_id,variant_id,name,qty,price,cost) VALUES(?,?,?,?,?,?,?)",
                      (sid, pid, vid, nm, qty, price, cost))
            if vid:
                c.execute("UPDATE variants SET stock=stock-? WHERE id=?", (qty, vid))
            else:
                c.execute("UPDATE products SET stock=stock-? WHERE id=?", (qty, pid))
            c.execute("INSERT INTO stock_moves(product_id,variant_id,name,qty,type,note,user,created_at) VALUES(?,?,?,?,?,?,?,?)",
                      (pid, vid, nm, -qty, "jual", invoice, user["name"], created))
            p = c.execute("SELECT name,stock,min_stock FROM products WHERE id=?", (pid,)).fetchone()
            if not vid and p["min_stock"] > 0 and p["stock"] <= p["min_stock"]:
                low.append({"name": p["name"], "stock": p["stock"]})
        c.execute("COMMIT")
    except Exception:
        if c.in_transaction:
            c.execute("ROLLBACK")
        raise
    out = sale_detail(c, sid)
    out["low_stock"] = low
    return out


def h_sales_list(ctx):
    q, c = ctx.q, ctx.c
    f, t = q.get("from", [today()])[0], q.get("to", [today()])[0]
    sql = "SELECT * FROM sales WHERE date(created_at) BETWEEN ? AND ?"
    args = [f, t]
    if ctx.user["role"] != "owner":
        sql += " AND user_id=?"
        args.append(ctx.user["id"])
        f = t = today()
        args[0] = args[1] = f
    sql += " ORDER BY id DESC LIMIT 2000"
    data = rows(c, sql, args)
    if q.get("items", ["0"])[0] == "1" and ctx.user["role"] == "owner":
        for s in data:
            s["items"] = rows(c, "SELECT name,qty,price,cost FROM sale_items WHERE sale_id=?", (s["id"],))
    return data


def h_sale_get(ctx, sid):
    s = sale_detail(ctx.c, sid)
    need(ctx.user["role"] == "owner" or s["user_id"] == ctx.user["id"], "Tidak diizinkan", 403)
    return s


def h_sale_void(ctx, sid):
    c = ctx.c
    c.execute("BEGIN IMMEDIATE")
    try:
        s = c.execute("SELECT * FROM sales WHERE id=?", (sid,)).fetchone()
        need(s, "Transaksi tidak ditemukan", 404)
        need(s["status"] == "paid", "Transaksi sudah dibatalkan")
        for it in c.execute("SELECT * FROM sale_items WHERE sale_id=?", (sid,)).fetchall():
            if it["variant_id"]:
                c.execute("UPDATE variants SET stock=stock+? WHERE id=?", (it["qty"], it["variant_id"]))
            else:
                c.execute("UPDATE products SET stock=stock+? WHERE id=?", (it["qty"], it["product_id"]))
            c.execute("INSERT INTO stock_moves(product_id,variant_id,name,qty,type,note,user,created_at) VALUES(?,?,?,?,?,?,?,?)",
                      (it["product_id"], it["variant_id"], it["name"], it["qty"], "batal", s["invoice"], ctx.user["name"], now()))
        c.execute("UPDATE sales SET status='void',voided_at=?,void_by=? WHERE id=?", (now(), ctx.user["name"], sid))
        c.execute("COMMIT")
    except Exception:
        if c.in_transaction:
            c.execute("ROLLBACK")
        raise
    return {"ok": True}


# --- laporan
def h_report(ctx):
    q, c = ctx.q, ctx.c
    f, t = q.get("from", [today()])[0], q.get("to", [today()])[0]
    group = q.get("group", ["day"])[0]
    cut = 10 if group == "day" else 7
    base = "FROM sales WHERE status='paid' AND date(created_at) BETWEEN ? AND ?"
    a = (f, t)
    tot = dict(c.execute("SELECT COUNT(*) n, COALESCE(SUM(total),0) omzet, COALESCE(SUM(subtotal-discount),0) bersih,"
                         " COALESCE(SUM(tax),0) pajak, COALESCE(SUM(discount),0) diskon " + base, a).fetchone())
    it = dict(c.execute("SELECT COALESCE(SUM(i.qty),0) qty, COALESCE(SUM(i.qty*i.cost),0) hpp FROM sale_items i"
                        " JOIN sales s ON s.id=i.sale_id WHERE s.status='paid' AND date(s.created_at) BETWEEN ? AND ?", a).fetchone())
    exp = c.execute("SELECT COALESCE(SUM(amount),0) FROM expenses WHERE date BETWEEN ? AND ?", a).fetchone()[0]
    hpp = int(round(it["hpp"]))
    gross = tot["bersih"] - hpp
    by_day = rows(c, "SELECT substr(created_at,1,%d) k, COUNT(*) n, SUM(total) omzet, SUM(subtotal-discount) bersih %s GROUP BY k ORDER BY k" % (cut, base), a)
    hpp_day = {r["k"]: r["h"] for r in c.execute(
        "SELECT substr(s.created_at,1,%d) k, SUM(i.qty*i.cost) h FROM sale_items i JOIN sales s ON s.id=i.sale_id"
        " WHERE s.status='paid' AND date(s.created_at) BETWEEN ? AND ? GROUP BY k" % cut, a)}
    exp_day = {r["k"]: r["s"] for r in c.execute(
        "SELECT substr(date,1,%d) k, SUM(amount) s FROM expenses WHERE date BETWEEN ? AND ? GROUP BY k" % cut, a)}
    for r in by_day:
        r["hpp"] = int(round(hpp_day.get(r["k"], 0)))
        r["laba"] = r["bersih"] - r["hpp"]
        r["biaya"] = exp_day.get(r["k"], 0)
    return {
        "from": f, "to": t, "group": group,
        "transaksi": tot["n"], "omzet": tot["omzet"], "penjualan_bersih": tot["bersih"], "pajak": tot["pajak"],
        "diskon": tot["diskon"], "item_terjual": it["qty"], "hpp": hpp, "laba_kotor": gross,
        "pengeluaran": exp, "laba_bersih": gross - exp,
        "kas_masuk": tot["omzet"], "kas_keluar": exp, "arus_kas": tot["omzet"] - exp,
        "rata_rata": int(tot["omzet"] / tot["n"]) if tot["n"] else 0,
        "by_day": by_day,
        "by_method": rows(c, "SELECT method, COUNT(*) n, SUM(total) total " + base + " GROUP BY method ORDER BY total DESC", a),
        "by_cashier": rows(c, "SELECT cashier, COUNT(*) n, SUM(total) total " + base + " GROUP BY cashier ORDER BY total DESC", a),
        "top_products": rows(c,
            "SELECT i.name, SUM(i.qty) qty, SUM(i.qty*i.price) revenue, SUM(i.qty*(i.price-i.cost)) profit FROM sale_items i"
            " JOIN sales s ON s.id=i.sale_id WHERE s.status='paid' AND date(s.created_at) BETWEEN ? AND ?"
            " GROUP BY i.name ORDER BY qty DESC LIMIT 15", a),
        "expenses": rows(c, "SELECT category, SUM(amount) total FROM expenses WHERE date BETWEEN ? AND ? GROUP BY category ORDER BY total DESC", a),
        "low_stock": low_stock(c),
    }


def low_stock(c):
    out = []
    for p in list_products(c):
        if p["min_stock"] > 0 and p["stock"] <= p["min_stock"]:
            out.append({"id": p["id"], "name": p["name"], "stock": p["stock"], "min_stock": p["min_stock"], "unit": p["unit"]})
    return out


# --- pengeluaran
def h_expenses_list(ctx):
    f, t = ctx.q.get("from", [today()])[0], ctx.q.get("to", [today()])[0]
    return rows(ctx.c, "SELECT * FROM expenses WHERE date BETWEEN ? AND ? ORDER BY date DESC, id DESC", (f, t))


def h_expense_add(ctx):
    b = ctx.body
    amt = to_int(b.get("amount"))
    need(amt > 0, "Nominal harus lebih dari 0")
    d = b.get("date") or today()
    need(re.match(r"^\d{4}-\d\d-\d\d$", d), "Tanggal tidak valid")
    cur = ctx.c.execute("INSERT INTO expenses(date,category,amount,note,user) VALUES(?,?,?,?,?)",
                        (d, (b.get("category") or "Lainnya")[:40], amt, (b.get("note") or "")[:200], ctx.user["name"]))
    return {"id": cur.lastrowid}


def h_expense_del(ctx, eid):
    ctx.c.execute("DELETE FROM expenses WHERE id=?", (eid,))
    return {"ok": True}


# --- pengguna & pengaturan
def h_users_list(ctx):
    return rows(ctx.c, "SELECT id,username,name,role,active FROM users ORDER BY id")


def h_user_save(ctx, uid=None):
    b, c = ctx.body, ctx.c
    username = (b.get("username") or "").strip().lower()
    name = (b.get("name") or "").strip()
    role = b.get("role", "kasir")
    need(role in ("owner", "kasir"), "Peran tidak valid")
    need(name, "Nama wajib diisi")
    try:
        if uid is None:
            need(re.match(r"^[a-z0-9_.-]{3,30}$", username), "Username 3-30 karakter (huruf kecil, angka, . _ -)")
            need(len(b.get("password") or "") >= 6, "Password minimal 6 karakter")
            salt, h = hash_pw(b["password"])
            cur = c.execute("INSERT INTO users(username,name,salt,pw,role,created_at) VALUES(?,?,?,?,?,?)",
                            (username, name, salt, h, role, now()))
            return {"id": cur.lastrowid}
        active = 1 if b.get("active", True) else 0
        if uid == ctx.user["id"]:
            need(role == "owner" and active, "Tidak bisa menurunkan/menonaktifkan akun sendiri")
        c.execute("UPDATE users SET name=?,role=?,active=? WHERE id=?", (name, role, active, uid))
        if b.get("password"):
            need(len(b["password"]) >= 6, "Password minimal 6 karakter")
            salt, h = hash_pw(b["password"])
            c.execute("UPDATE users SET salt=?,pw=? WHERE id=?", (salt, h, uid))
        if not active:
            c.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
        need(c.execute("SELECT COUNT(*) FROM users WHERE role='owner' AND active=1").fetchone()[0] > 0, "Minimal harus ada satu pemilik aktif")
        return {"ok": True}
    except sqlite3.IntegrityError:
        raise ApiError(409, "Username sudah dipakai")


def h_settings_save(ctx):
    b = ctx.body
    for k in DEFAULT_SETTINGS:
        if k in b:
            v = str(b[k])
            if k == "qris_image":
                need(len(v) < 1_500_000, "Gambar QRIS terlalu besar")
            if k == "tax_percent":
                v = str(max(0.0, min(100.0, to_num(v))))
            if k == "paper":
                v = v if v in ("58", "80") else "58"
            ctx.c.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (k, v))
    return get_settings(ctx.c)


def h_backup(ctx):
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    try:
        dst = sqlite3.connect(path)
        ctx.c.backup(dst)
        dst.close()
        with open(path, "rb") as f:
            return ("raw", f.read(), "application/octet-stream", "kasir-smart-backup-%s.db" % today())
    finally:
        os.remove(path)


# ----------------------------------------------------------------- routing
OWNER, ANY, PUBLIC = "owner", "any", "public"
ROUTES = [
    ("POST", r"/api/login", PUBLIC, h_login),
    ("POST", r"/api/logout", ANY, h_logout),
    ("GET", r"/api/health", PUBLIC, lambda ctx: {"ok": True, "time": now()}),
    ("GET", r"/api/bootstrap", ANY, h_bootstrap),
    ("POST", r"/api/me/password", ANY, h_change_pw),
    ("POST", r"/api/products", OWNER, h_product_save),
    ("PUT", r"/api/products/(\d+)", OWNER, h_product_save),
    ("DELETE", r"/api/products/(\d+)", OWNER, h_product_delete),
    ("POST", r"/api/stock/adjust", OWNER, h_stock_adjust),
    ("GET", r"/api/stock/moves", OWNER, h_stock_moves),
    ("POST", r"/api/sales", ANY, h_sale_create),
    ("GET", r"/api/sales", ANY, h_sales_list),
    ("GET", r"/api/sales/(\d+)", ANY, h_sale_get),
    ("POST", r"/api/sales/(\d+)/void", OWNER, h_sale_void),
    ("GET", r"/api/report", OWNER, h_report),
    ("GET", r"/api/expenses", OWNER, h_expenses_list),
    ("POST", r"/api/expenses", OWNER, h_expense_add),
    ("DELETE", r"/api/expenses/(\d+)", OWNER, h_expense_del),
    ("GET", r"/api/users", OWNER, h_users_list),
    ("POST", r"/api/users", OWNER, h_user_save),
    ("PUT", r"/api/users/(\d+)", OWNER, h_user_save),
    ("PUT", r"/api/settings", OWNER, h_settings_save),
    ("GET", r"/api/backup", OWNER, h_backup),
]
ROUTES = [(m, re.compile("^" + p + "$"), a, f) for m, p, a, f in ROUTES]


class Ctx:
    pass


class Handler(BaseHTTPRequestHandler):
    server_version = "KasirSmart/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("KASIR_LOG"):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Referrer-Policy", "same-origin")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode(), extra={"Cache-Control": "no-store"})

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def dispatch(self, method):
        u = urlparse(self.path)
        path = u.path
        if not path.startswith("/api/"):
            return self.static(path) if method in ("GET", "HEAD") else self._json(405, {"error": "Method tidak didukung"})
        c = None
        try:
            ln = int(self.headers.get("Content-Length") or 0)
            if ln > MAX_BODY:
                return self._json(413, {"error": "Data terlalu besar"})
            raw = self.rfile.read(ln) if ln else b""
            body = {}
            if raw:
                try:
                    body = json.loads(raw)
                except ValueError:
                    return self._json(400, {"error": "JSON tidak valid"})
            for m, rx, access, fn in ROUTES:
                mt = rx.match(path)
                if m == method and mt:
                    break
            else:
                return self._json(404, {"error": "Endpoint tidak ditemukan"})
            ctx = Ctx()
            ctx.c = c = db()
            ctx.q, ctx.body = parse_qs(u.query), (body if isinstance(body, dict) else {})
            ctx.ip = self.headers.get("X-Forwarded-For", self.client_address[0]).split(",")[0].strip()
            ctx.user = ctx.token = None
            if access != PUBLIC:
                auth = self.headers.get("Authorization", "")
                tok = auth[7:] if auth.startswith("Bearer ") else ""
                row = c.execute("SELECT u.*, s.created_at sc FROM sessions s JOIN users u ON u.id=s.user_id"
                                " WHERE s.token=? AND u.active=1", (tok,)).fetchone()
                if not row or time.time() - row["sc"] > SESSION_DAYS * 86400:
                    return self._json(401, {"error": "Sesi berakhir, silakan masuk lagi"})
                ctx.user, ctx.token = row, tok
                if access == OWNER and row["role"] != "owner":
                    return self._json(403, {"error": "Hanya pemilik yang boleh melakukan ini"})
            args = [int(g) for g in mt.groups()]
            res = fn(ctx, *args)
            if isinstance(res, tuple) and res[0] == "raw":
                return self._send(200, res[1], res[2], {"Content-Disposition": 'attachment; filename="%s"' % res[3]})
            self._json(200, res)
        except ApiError as e:
            self._json(e.code, {"error": e.msg})
        except sqlite3.IntegrityError as e:
            self._json(409, {"error": "Data bentrok: %s" % e})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # pragma: no cover
            sys.stderr.write("ERROR %s %s: %r\n" % (method, path, e))
            self._json(500, {"error": "Terjadi kesalahan di server"})
        finally:
            if c:
                c.close()

    def static(self, path):
        if path == "/":
            path = "/index.html"
        fp = os.path.normpath(os.path.join(STATIC, path.lstrip("/")))
        if not fp.startswith(STATIC + os.sep) or not os.path.isfile(fp):
            fp = os.path.join(STATIC, "index.html")  # fallback SPA
        ctype = mimetypes.guess_type(fp)[0] or "application/octet-stream"
        if fp.endswith(".webmanifest"):
            ctype = "application/manifest+json"
        with open(fp, "rb") as f:
            data = f.read()
        cache = "no-cache" if fp.endswith((".html", "sw.js")) else "public, max-age=3600"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/manifest+json"):
            ctype += "; charset=utf-8"
        self._send(200, data, ctype, {"Cache-Control": cache})


def main():
    init_db()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    print("Kasir Smart berjalan di http://%s:%d  (DB: %s)" % (HOST, PORT, DB_PATH))
    print("Login awal -> pemilik: admin / admin123 | kasir: kasir / kasir123  (SEGERA GANTI!)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nBerhenti.")


if __name__ == "__main__":
    main()
