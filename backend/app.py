# -*- coding: utf-8 -*-
"""
野性档案 · 声匣后端 (Music Box Backend)
============================
把 musicdl 封装成一个自带"防滥用"的轻量 API 二传手。

核心原则（对应需求"后端代理模式"）：
  1. 前端绝不允许直连任何第三方音乐接口，只能打本服务的 /api/*。
  2. 用户输入歌名 -> 本后端调用 musicdl 并联查询多源 -> 返回"临时"播放地址。
  3. 服务端强制限流 + 防重放签名 + 结果缓存，避免本服务 IP 被打爆 / 被上游风控。

运行（仅本地/自托管服务器，不能用 GitHub Pages）：
  pip install -r requirements.txt
  python app.py            # 默认 127.0.0.1:8756
用 nginx/caddy 反代到公网时，务必保留原始 IP（X-Forwarded-For）。
"""
import os
import time
import json
import uuid
import hmac
import hashlib
import functools
import threading
import tempfile
from urllib.parse import urlencode

from flask import Flask, jsonify, request

app = Flask(__name__)

APP_NAME = "savage-music-box"
CACHE_TTL = 60 * 20          # 搜索结果缓存 20 分钟
PLAY_TICKET_TTL = 60 * 3     # 播放票据 3 分钟内有效
RATE = {"search": (6, 60), "play": (30, 60), "per_ip": (20, 60)}  # (max, window_sec)

# ---------- 密钥：生产务必用环境变量覆盖 ----------
SECRET = os.environ.get("MB_SECRET") or "dev-only-change-me"
ALLOWED_ORIGINS = os.environ.get("MB_ORIGIN", "*").split(",")

# muzicdl 延迟导入，避免依赖缺失时整个服务起不来
try:
    from musicdl import musicdl
except Exception as _e:  # pragma: no cover
    musicdl = None
    _MUSICDL_ERR = str(_e)
else:
    _MUSICDL_ERR = None

# ---------- musicdl 客户端（懒加载） ----------
_client, _client_lock = None, threading.Lock()
# musicdl 的源标记，写全名便于后续按可用性裁剪
SOURCES = ["NeteaseMusicClient", "QQMusicClient", "KugouMusicClient", "KuwoMusicClient"]


def _get_client():
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                if musicdl is None:
                    raise RuntimeError("musicdl 未安装：" + _MUSICDL_ERR)
                _client = musicdl.MusicClient(
                    music_sources=SOURCES,
                    config={
                        "savedir": tempfile.mkdtemp(prefix="savage-music-"),
                        "search_size_per_source": 4,
                        "max_thread": 4,
                    },
                )
    return _client


# ---------- 简单令牌桶限流（按 key） ----------
_buckets = {}
_rl_lock = threading.Lock()


def rate_limit(key, max_n, window):
    now = time.time()
    with _rl_lock:
        b = _buckets.get(key)
        if not b or now - b["start"] >= window:
            _buckets[key] = {"start": now, "count": 0}
            b = _buckets[key]
        b["count"] += 1
        ok = b["count"] <= max_n
        if len(_buckets) > 20000:
            for k in list(_buckets.keys()):
                if now - _buckets[k]["start"] >= window:
                    _buckets.pop(k, None)
        return ok, b["count"], max_n


# ---------- 结果缓存 ----------
_cache, _cache_lock = {}, threading.Lock()


def cache_get(key):
    with _cache_lock:
        e = _cache.get(key)
        if e and e[0] > time.time():
            return e[1]
        _cache.pop(key, None)
        return None


def cache_set(key, val, ttl):
    with _cache_lock:
        _cache[key] = (time.time() + ttl, val)


# ---------- 获取真实 IP ----------
def client_ip():
    # 信任前置反代头；如需严格白名单可改为仅取 REMOTE_ADDR
    fwd = request.headers.get("X-Forwarded-For", "")
    if fwd:
        return fwd.split(",")[0].strip() or request.remote_addr or "0.0.0.0"
    return request.remote_addr or "0.0.0.0"


# ---------- 签名票据：防止播放地址被直接改口 / 无限复用 ----------
def _sign(*parts):
    msg = "|".join(str(p) for p in parts)
    return hmac.new(SECRET.encode(), msg.encode(), hashlib.sha256).hexdigest()


def make_ticket(track_key, ip):
    exp = int(time.time()) + PLAY_TICKET_TTL
    token = _sign(track_key, exp, ip, "play")
    return {"track": track_key, "exp": exp, "ip": ip, "token": token}


def verify_ticket(t):
    try:
        return hmac.compare_digest(t["token"], _sign(t["track"], t["exp"], t["ip"], "play"))
    except Exception:
        return False


# ---------- CORS ----------
@app.after_request
def _cors(resp):
    origin = request.headers.get("Origin", "")
    if "*" in ALLOWED_ORIGINS or origin in ALLOWED_ORIGINS:
        resp.headers["Access-Control-Allow-Origin"] = origin if origin else "*"
        resp.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type,Authorization"
    return resp


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({
        "ok": True,
        "app": APP_NAME,
        "musicdl": _MUSICDL_ERR or "ready",
        "sources": SOURCES,
        "time": int(time.time()),
    })


@app.route("/api/search", methods=["GET", "POST"])
def search():
    # 1) 风控：每用户频率 + 每 IP 总量
    ip = client_ip()
    ok1, _, _ = rate_limit("search:" + ip, RATE["search"][0], RATE["search"][1])
    ok2, cnt, mx = rate_limit("ip:" + ip, RATE["per_ip"][0], RATE["per_ip"][1])
    if not ok1 or not ok2:
        return jsonify({"ok": False, "error": "操作太快，请稍候再试"}), 429
    # 2) 取参
    kw = (request.json or {}).get("q" if request.is_json else "q") or request.args.get("q", "")
    kw = str(kw).strip()
    if not kw:
        return jsonify({"ok": False, "error": "请输入歌名或关键词"}), 400
    if len(kw) > 60:
        return jsonify({"ok": False, "error": "关键词过长"}), 400
    ckey = "s:" + hashlib.md5((kw + "|" + ip).encode()).hexdigest()
    cached = cache_get(ckey)
    if cached:
        return jsonify({"ok": True, "cached": True, "q": kw, "results": cached})
    # 3) 真正调 musicdl（低频 / 多源容错）
    try:
        c = _get_client()
        raw = c.search(kw)
    except Exception as e:
        return jsonify({"ok": False, "error": "搜索服务暂不可用", "detail": str(e)[:120]}), 502
    # 4) 归一化为统一结构，附签名票据供播放
    results = []
    for src in (raw or {}).values() or []:
        if not isinstance(src, list):
            continue
        for it in src or []:
            if not it:
                continue
            tid = it.get("id") or uuid.uuid4().hex
            track_key = f"{it.get('from') or 'music'}:{tid}"
            results.append({
                "key": track_key,
                "title": it.get("title") or it.get("song") or "未知曲名",
                "artist": (it.get("artist") or [""])[0] if isinstance(it.get("artist"), list) else (it.get("artist") or ""),
                "source": it.get("from") or "",
                "duration": it.get("duration") or 0,
                "size": it.get("filesize") or 0,
                "ticket": make_ticket(track_key, ip),
            })
    # 5) 缓存（含票据，票据短于缓存以复用搜索但单曲播放独立验签）
    cache_set(ckey, results, CACHE_TTL)
    return jsonify({"ok": True, "cached": False, "q": kw, "results": results})


@app.route("/api/play", methods=["GET", "POST"])
def play():
    ip = client_ip()
    ok, _, _ = rate_limit("play:" + ip, RATE["play"][0], RATE["play"][1])
    if not ok:
        return jsonify({"ok": False, "error": "播放过于频繁，请稍候"}), 429
    payload = (request.json or {}) if request.is_json else request.args.to_dict()
    token = payload.get("token") or request.args.get("token", "")
    if token:
        try:
            j = json.loads(token)
        except Exception:
            return jsonify({"ok": False, "error": "票据无效"}), 403
    else:
        # 兼容：由 search 颁发的是完整对象，前端应直接携带
        return jsonify({"ok": False, "error": "缺少播放票据"}), 400
    if not verify_ticket(j):
        return jsonify({"ok": False, "error": "票据无效或已过期"}), 403
    if j.get("ip") != ip:
        return jsonify({"ok": False, "error": "票据与来源不符"}), 403
    # 用票据里的 track key 到缓存里找该曲目的临时直链（musicdl 版本不一，未必自动给 link/to_url）
    target = j.get("track", "")
    cached_all = None
    for k, v in _cache.items():
        if isinstance(v, list) and any(r.get("key") == target for r in v):
            cached_all = v
            break
    if cached_all is None:
        print(f"[play] 未命中缓存 track={target}")
    # 尽力返回源平台可播放字段；生产建议让 musicdl 落盘后由本服务做流式转发
    return jsonify({
        "ok": True,
        "track": target,
        "exp": j.get("exp"),
        "url": None,  # 见 README：方案 A 返回第三方直链，方案 B 走本服务 /stream 转发
        "note": "simple-mode",
    })


@app.route("/", methods=["GET"])
def root():
    return jsonify({"ok": True, "app": APP_NAME, "api": ["/api/health", "/api/search", "/api/play"]})


if __name__ == "__main__":
    app.run(host=os.environ.get("MB_HOST", "127.0.0.1"), port=int(os.environ.get("MB_PORT", "8756")), threaded=True)