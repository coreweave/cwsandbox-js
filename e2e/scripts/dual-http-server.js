const http = require("node:http");

function serve(port) {
  http
    .createServer((_request, response) => {
      const body = `ok:${String(port)}`;
      response.writeHead(200, {
        "Content-Length": Buffer.byteLength(body),
        "Content-Type": "text/plain",
      });
      response.end(body);
    })
    .listen(port, "0.0.0.0");
}

serve(8000);
serve(8001);
