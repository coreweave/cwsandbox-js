// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { StartCommandOptions } from "../public/commands.js";

/** Runtime start options; binaryOutput is not part of the public commands API. */
export type InternalStartCommandOptions = StartCommandOptions & {
  readonly binaryOutput?: boolean;
};
