#!/bin/bash
# 爱上跳绳 - 本地启动脚本
# 用法: ./start.sh [port]
# 默认端口 8443

PORT=${1:-8443}
cd "$(dirname "$0")"

# 检查证书
if [ ! -f server.crt ] || [ ! -f server.key ]; then
  echo "生成自签名证书..."
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout server.key -out server.crt \
    -subj "/CN=$(python3 -c 'import socket; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.connect(("8.8.8.8",80)); print(s.getsockname()[0]); s.close()')"
fi

# 获取本机局域网IP
IP=$(python3 -c '
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.connect(("8.8.8.8", 80))
print(s.getsockname()[0])
s.close()
')

echo "========================================="
echo "  爱上跳绳 - HTTPS 服务器"
echo "========================================="
echo ""
echo "  手机访问: https://$IP:$PORT"
echo "  电脑访问: https://localhost:$PORT"
echo ""
echo "  按 Ctrl+C 停止服务器"
echo "========================================="

python3 -c "
import http.server, ssl, os, sys
os.chdir('$(pwd)')
port = $PORT
handler = http.server.SimpleHTTPRequestHandler
httpd = http.server.HTTPServer(('0.0.0.0', port), handler)
httpd.socket = ssl.wrap_socket(httpd.socket, certfile='server.crt', keyfile='server.key', server_side=True)
print(f'服务器已启动: https://$IP:{port}')
httpd.serve_forever()
"
