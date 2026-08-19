const crypto = require("node:crypto");
const http = require("node:http");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const PORT = 8000;

function acceptKey(key) {
  return crypto.createHash("sha1").update(`${key}${GUID}`).digest("base64");
}

function writeFrame(socket, opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function tryReadFrame(buffer) {
  if (buffer.length < 2) {
    return undefined;
  }
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) {
      return undefined;
    }
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) {
      return undefined;
    }
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskSize = masked ? 4 : 0;
  if (buffer.length < offset + maskSize + length) {
    return undefined;
  }
  const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
  offset += maskSize;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask !== undefined) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }
  return { opcode, payload, rest: buffer.subarray(offset + length) };
}

function attachEcho(socket) {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const frame = tryReadFrame(buffer);
      if (frame === undefined) {
        return;
      }
      buffer = frame.rest;
      if (frame.opcode === 0x8) {
        writeFrame(socket, 0x8, frame.payload);
        socket.end();
        return;
      }
      if (frame.opcode === 0x9) {
        writeFrame(socket, 0xa, frame.payload);
        continue;
      }
      if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        writeFrame(socket, frame.opcode, frame.payload);
      }
    }
  });
}

const server = http.createServer((_request, response) => {
  response.writeHead(404);
  response.end();
});

server.on("upgrade", (request, socket) => {
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string" || key === "") {
    socket.destroy();
    return;
  }
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      "\r\n",
    ].join("\r\n"),
  );
  attachEcho(socket);
});

server.listen(PORT, "0.0.0.0");
