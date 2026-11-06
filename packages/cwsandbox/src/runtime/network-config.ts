// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { DEFAULT_LIST_ALL_TIMEOUT_MS, MAX_LIST_ALL_PAGES } from "../defaults.js";
import {
  CWSandboxTimeoutError,
  CWSandboxTransportError,
  CWSandboxValidationError,
} from "../errors.js";
import { ignoreMissingSandbox } from "../internal/delete.js";
import { validateNetworkConfigId } from "../internal/network.js";
import {
  DEFAULT_POLL_RETRY_BUDGET_MS,
  retryTransientRpc,
} from "../internal/retry-transient-rpc.js";
import { validateRequestOptions } from "../internal/validation/index.js";
import {
  validateCreateNetworkConfigOptions,
  validateDeleteNetworkConfigOptions,
  validateListNetworkConfigsOptions,
  validateUpdateNetworkConfigOptions,
} from "../internal/validation/network-config.js";
import type { RequestOptions } from "../public/common.js";
import type {
  CreateNetworkConfigOptions,
  DeleteNetworkConfigOptions,
  ListNetworkConfigsOptions,
  NetworkConfigResult,
  NetworkConfigUpdateField,
  UpdateNetworkConfigOptions,
} from "../public/network-config.js";
import type { NetworkOptions } from "../public/network.js";
import type { SandboxTransport } from "../transport.js";

const GET_OPERATION = "Get network config";
const LIST_OPERATION = "List network configs";
const UPDATE_OPERATION = "Update network config";

export async function createNetworkConfigRecord(
  transport: SandboxTransport,
  networkConfigId: string,
  options: CreateNetworkConfigOptions = {},
): Promise<NetworkConfigResult> {
  validateNetworkConfigId(networkConfigId);
  validateCreateNetworkConfigOptions(options);
  return transport.createNetworkConfig({ ...options, networkConfigId });
}

export async function getNetworkConfigRecord(
  transport: SandboxTransport,
  networkConfigId: string,
  options: RequestOptions = {},
): Promise<NetworkConfigResult> {
  validateNetworkConfigId(networkConfigId);
  validateRequestOptions(options);
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_LIST_ALL_TIMEOUT_MS);

  return retryTransientRpc(
    async ({ timeoutMs }) =>
      transport.getNetworkConfig({
        networkConfigId,
        timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
    {
      budgetMs: DEFAULT_POLL_RETRY_BUDGET_MS,
      deadline,
      nonRetryable: [CWSandboxTimeoutError],
      operation: GET_OPERATION,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
}

export async function listNetworkConfigRecords(
  transport: SandboxTransport,
  options: ListNetworkConfigsOptions = {},
): Promise<readonly NetworkConfigResult[]> {
  validateListNetworkConfigsOptions(options);

  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_LIST_ALL_TIMEOUT_MS);
  const seenTokens = new Set<string>();
  const configs: NetworkConfigResult[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_LIST_ALL_PAGES; page += 1) {
    options.signal?.throwIfAborted();

    const result = await retryTransientRpc(
      async () => {
        const pageTimeoutMs = deadline - Date.now();
        if (pageTimeoutMs <= 0) {
          throw new CWSandboxTimeoutError(`${LIST_OPERATION} timed out during pagination.`, {
            operation: LIST_OPERATION,
          });
        }
        return transport.listNetworkConfigs({
          timeoutMs: pageTimeoutMs,
          ...(pageToken === undefined ? {} : { pageToken }),
          ...(options.platformManaged === undefined
            ? {}
            : { platformManaged: options.platformManaged }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      },
      {
        budgetMs: DEFAULT_POLL_RETRY_BUDGET_MS,
        deadline,
        nonRetryable: [CWSandboxTimeoutError],
        operation: LIST_OPERATION,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );

    configs.push(...result.networkConfigs);

    const nextPageToken = result.nextPageToken;
    if (nextPageToken === undefined || nextPageToken === "") {
      return configs;
    }
    if (seenTokens.has(nextPageToken)) {
      throw new CWSandboxTransportError(
        `${LIST_OPERATION} pagination loop detected: repeated page token.`,
        { operation: LIST_OPERATION },
      );
    }
    seenTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }

  throw new CWSandboxTransportError(
    `${LIST_OPERATION} pagination exceeded ${MAX_LIST_ALL_PAGES} pages.`,
    { operation: LIST_OPERATION },
  );
}

/**
 * Writing `egress` replaces the whole stored list, including rules
 * `NetworkOptions` cannot show. Read first, refuse if the list has such
 * rules, and pin the write to the etag that was read so a concurrent
 * writer cannot slip them in between.
 */
export async function updateNetworkConfigRecord(
  transport: SandboxTransport,
  networkConfigId: string,
  network: NetworkOptions,
  options: UpdateNetworkConfigOptions = {},
): Promise<NetworkConfigResult> {
  validateNetworkConfigId(networkConfigId);
  validateUpdateNetworkConfigOptions(network, options);

  const updateMask = options.updateMask ?? setFields(network);
  if (options.updateMask === undefined && updateMask.length === 0) {
    throw new CWSandboxValidationError(
      "network must set denyEgress, denyIngress, dnsEgress, or egress (or pass updateMask).",
    );
  }

  const deadline = options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
  let etag = options.etag;

  if (updateMask.includes("egress")) {
    const current = await transport.getNetworkConfig({
      networkConfigId,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    if (current.unsupportedFields.includes("egress")) {
      throw new CWSandboxValidationError(
        `NetworkConfig '${networkConfigId}' has egress rules this SDK cannot represent ` +
          "(address, tenant, selector, or non-443 rules). Writing egress would remove them; " +
          "leave egress out of the update or change it with a client that supports those rules.",
      );
    }
    etag ??= current.etag;
  }

  return transport.updateNetworkConfig({
    // An empty mask writes nothing, so send no fields: a server that read the
    // mask as omitted would then have nothing to infer a write from.
    network: updateMask.length === 0 ? {} : network,
    networkConfigId,
    updateMask,
    ...(etag === undefined ? {} : { etag }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(deadline === undefined ? {} : { timeoutMs: remainingMs(deadline) }),
  });
}

export async function deleteNetworkConfigRecord(
  transport: SandboxTransport,
  networkConfigId: string,
  options: DeleteNetworkConfigOptions = {},
): Promise<void> {
  validateNetworkConfigId(networkConfigId);
  validateDeleteNetworkConfigOptions(options);
  const { missingOk, ...requestOptions } = options;
  await ignoreMissingSandbox(
    transport.deleteNetworkConfig({
      ...requestOptions,
      networkConfigId,
      ...(missingOk === true ? { allowMissing: true } : {}),
    }),
    missingOk === true,
  );
}

function setFields(network: NetworkOptions): NetworkConfigUpdateField[] {
  const fields: NetworkConfigUpdateField[] = [];
  if (network.denyEgress !== undefined) {
    fields.push("denyEgress");
  }
  if (network.denyIngress !== undefined) {
    fields.push("denyIngress");
  }
  if (network.dnsEgress !== undefined) {
    fields.push("dnsEgress");
  }
  if (network.egress !== undefined) {
    fields.push("egress");
  }
  return fields;
}

function remainingMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new CWSandboxTimeoutError(`${UPDATE_OPERATION} timed out.`, {
      operation: UPDATE_OPERATION,
    });
  }
  return remaining;
}
