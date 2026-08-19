// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxValidationError } from "../errors.js";
import type { Endpoint, NetworkOptions, Service } from "../public/network.js";

const ENDPOINT_AUTHS = new Set(["open"]);
const ENDPOINT_KINDS = new Set(["https"]);
const SERVICE_PROTOCOLS = new Set(["sctp", "tcp", "udp", "unspecified"]);
const SERVICE_VISIBILITIES = new Set(["custom", "private", "public", "unspecified"]);

export function validateNetworkOptions(
  services: readonly Service[] | undefined,
  network: NetworkOptions | undefined,
): void {
  validateServices(services);
  validateDenyFlags(network);
}

function validateDenyFlags(network: NetworkOptions | undefined): void {
  if (network === undefined) {
    return;
  }

  if (network.denyEgress !== undefined && typeof network.denyEgress !== "boolean") {
    throw new CWSandboxValidationError("network.denyEgress must be a boolean");
  }

  if (network.denyIngress !== undefined && typeof network.denyIngress !== "boolean") {
    throw new CWSandboxValidationError("network.denyIngress must be a boolean");
  }
}

function validateServices(services: readonly Service[] | undefined): void {
  if (services === undefined) {
    return;
  }

  const seenPorts = new Set<number>();
  for (const service of services) {
    validatePortNumber(service.port, "services.port");
    if (seenPorts.has(service.port)) {
      throw new CWSandboxValidationError(`services contains duplicate port: ${service.port}`);
    }
    seenPorts.add(service.port);

    if (service.name !== undefined && service.name.trim() === "") {
      throw new CWSandboxValidationError("services.name must not be empty");
    }

    const protocol = normalizeEnum(service.protocol);
    if (protocol !== undefined && !SERVICE_PROTOCOLS.has(protocol)) {
      throw new CWSandboxValidationError(`services.protocol is not supported: ${service.protocol}`);
    }

    const visibility = normalizeEnum(service.visibility);
    if (visibility !== undefined && !SERVICE_VISIBILITIES.has(visibility)) {
      throw new CWSandboxValidationError(
        `services.visibility is not supported: ${service.visibility}`,
      );
    }

    if (service.endpoint !== undefined) {
      validateEndpoint(service.endpoint, visibility, protocol);
    }
  }
}

function validateEndpoint(
  endpoint: Endpoint,
  visibility: string | undefined,
  protocol: string | undefined,
): void {
  const kind = normalizeEnum(endpoint.kind);
  const auth = normalizeEnum(endpoint.auth);
  if (kind === undefined || !ENDPOINT_KINDS.has(kind)) {
    throw new CWSandboxValidationError("Service.endpoint.kind must be https");
  }
  if (auth === undefined || !ENDPOINT_AUTHS.has(auth)) {
    throw new CWSandboxValidationError("Service.endpoint.auth must be open");
  }
  if (visibility !== "public") {
    throw new CWSandboxValidationError("Service.visibility must be public when endpoint is set");
  }
  if (protocol !== undefined && protocol !== "unspecified" && protocol !== "tcp") {
    throw new CWSandboxValidationError(
      "Service.protocol must be unset or tcp when endpoint is set",
    );
  }
}

function validatePortNumber(port: number, fieldName: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CWSandboxValidationError(`${fieldName} must be an integer between 1 and 65535`);
  }
}

function normalizeEnum(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.trim().toLowerCase();
}
