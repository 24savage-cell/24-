# ============================================================
#  野性档案 · 声匣后端部署说明
#  musicdl(Flask) 代理模式 —— 后端"二传手"
# ============================================================
#  ⚠️ 本后端是 Python 服务，必须运行在有 Python 环境的服务器上，
#     GitHub Pages 是纯静态托管，无法运行本服务。

## 1. 本地运行
# pip install -r requirements.txt
# export MB_SECRET='改成一段长随机字符串'
# export MB_ORIGIN='https://24savage-cell.github.io'
# python app.py                # 默认 http://127.0.0.1:8756

## 2. 生产运行（gunicorn + 反代 + HTTPS）
# 专业服务器（VPS / Render / Railway / Fly）：
#   gunicorn -w 1 -b 127.0.0.1:8756 'app:app' --timeout 60 --threads 8
#
# ⚠️ 运行环境必须是 Python 3.11+（musicdl>=2.13 依赖 typing.Unpack）。
#
# 用 nginx 反代，并务必透传真实 IP 与 Origin：
#   server {
#     listen 443 ssl;
#     server_name music.example.com;
#     location /api/ {
#       proxy_pass http://127.0.0.1:8756;
#       proxy_set_header X-Forwarded-For  $proxy_add_x_forwarded_for;
#       proxy_set_header Host             $host;
#       proxy_set_header Origin           $http_origin;
#       proxy_read_timeout 60s;
#     }
#   }
# （本服务限流依赖 X-Forwarded-For 判 IP，未配置反代会把所有请求当成客户端 IP）

## 3. 安全配置项（务必设置）
# MB_SECRET  : 签名票据密钥，必须 32 位以上随机串，泄露=播放票据可被伪造
# MB_ORIGIN  : 允许的前端来源，逗号分隔；攻击者改了 Origin 会被 CORS 拦下
# MB_HOST/MB_PORT : 监听地址与端口，生产通常只监听 127.0.0.1

## 4. 关于"整曲免费下载 / 大量抓取"的现实约束
#  musicdl 是对 QQ/网易/酷狗等的逆向抓取，这些平台会按 IP 风控拉黑。
#  代理能防"你自己的服务被刷爆"，但救不了"抓取行为触怒上游"。
#  本服务已内置：单 IP 频率限制、搜索结果 20 分钟缓存、播放 3 分钟短时效票据。
#  若坚持整曲下载，请在 musicdl 侧启用代理 / 降低频率 / 仅用稳定源，
#  并自行评估相关平台的版权与风控条款——本服务默认只放行"试听直链"。

## 5. 前端对接
#  前端声匣只打本服务的 /api/search 与 /api/play，绝不直连第三方。
#  MUSIC_API_BASE 指向本服务公网地址即可（见 features.js 顶部配置）。