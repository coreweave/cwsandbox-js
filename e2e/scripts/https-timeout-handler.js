const http = require("node:http");

const READY_BODY = "product-https-timeout-ready";
const DEFAULT_SLOW_BODY = "product-https-timeout-default-slow";

http
  .createServer((request, response) => {
    const path = (request.url ?? "/").split("?", 1)[0];
    if (path === "/default-slow") {
      setTimeout(() => {
        write(response, DEFAULT_SLOW_BODY);
      }, 20_000);
      return;
    }
    write(response, READY_BODY);
  })
  .listen(8080, "0.0.0.0");

function write(response, body) {
  response.writeHead(200, {
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "text/plain",
  });
  response.end(body);
}
