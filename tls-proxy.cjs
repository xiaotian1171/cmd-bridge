#!/usr/bin/env node
// tls-proxy.cjs —— 本地直连模式的强制 HTTPS 终端（由 start.sh 在 BRIDGE_TLS=1 时自动挂载）
//
// supergateway 只提供 HTTP。BRIDGE_TLS=1 且 BRIDGE_TUNNEL=none 时，start.sh 把
// supergateway 挪到本机内部端口（BRIDGE_PORT+1），再由本进程在对外端口 BRIDGE_PORT
// 上提供 HTTPS，链路为：
//   客户端 --HTTPS(自签证书)--> tls-proxy.cjs --HTTP(仅本机)--> supergateway
// 这样对外只暴露一个 HTTPS 端口，HTTP 不出本机，即"强制 HTTPS"。
//
// 证书由 start.sh 用 openssl 自签生成（$BRIDGE_HOME/tls/，10 年有效期，长期复用）。
// 自签证书意味着传输加密，但严格校验证书链的客户端（如 ChatGPT 连接器）会拒绝；
// 可跳过校验或信任证书的客户端（curl -k、Operit 等自定客户端）可直接使用。
//
// 用法（由 start.sh 自动构造，勿单独运行）：
//   node tls-proxy.cjs <对外端口> <上游端口> <cert.pem> <key.pem>
const https = require("https");
const http = require("http");
const fs = require("fs");

const [, , tlsPort, upstreamPort, certFile, keyFile] = process.argv;
if (!tlsPort || !upstreamPort || !certFile || !keyFile) {
  console.error("用法: node tls-proxy.cjs <对外端口> <上游端口> <cert.pem> <key.pem>");
  process.exit(1);
}

const server = https.createServer(
  { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) },
  (req, res) => {
    const proxy = http.request(
      {
        host: "127.0.0.1",
        port: Number(upstreamPort),
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${upstreamPort}` },
      },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      }
    );
    proxy.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("tls-proxy upstream error: " + e.message);
    });
    req.pipe(proxy);
  }
);

server.listen(Number(tlsPort), "0.0.0.0", () => {
  console.log(`tls-proxy listening on 0.0.0.0:${tlsPort} -> 127.0.0.1:${upstreamPort}`);
});
