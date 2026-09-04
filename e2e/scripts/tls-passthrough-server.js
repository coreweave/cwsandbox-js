const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const https = require("node:https");

const BODY = "product-tls-ok";

execFileSync("openssl", [
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-keyout",
  "/tmp/tls.key",
  "-out",
  "/tmp/tls.crt",
  "-days",
  "1",
  "-subj",
  "/CN=tls-probe",
]);

https
  .createServer(
    {
      cert: readFileSync("/tmp/tls.crt"),
      key: readFileSync("/tmp/tls.key"),
    },
    (_request, response) => {
      response.writeHead(200, {
        "Content-Length": Buffer.byteLength(BODY),
        "Content-Type": "text/plain",
      });
      response.end(BODY);
    },
  )
  .listen(8443, "0.0.0.0");
