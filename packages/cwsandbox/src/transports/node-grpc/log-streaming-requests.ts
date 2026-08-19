// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { StreamLogsRequest } from "../../transport/types.js";
import type { StreamLogsRequest as ProtoStreamLogsRequest } from "./generated/coreweave/sandbox/v1/sandbox.js";
import { toProtoStreamLogsRequest } from "./mappers.js";

export function toLogStreamInitRequest(request: StreamLogsRequest): ProtoStreamLogsRequest {
  return toProtoStreamLogsRequest(request);
}
