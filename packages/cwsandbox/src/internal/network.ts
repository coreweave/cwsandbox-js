// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxValidationError } from "../errors.js";
import type { NetworkOptions, PortInput, PortOptions } from "../public/network.js";

export function normalizePorts(ports: readonly PortInput[] | undefined): readonly PortOptions[] {
  return ports?.map((port) => (typeof port === "number" ? { port } : port)) ?? [];
}

export function validateNetworkOptions(
  ports: readonly PortInput[] | undefined,
  network: NetworkOptions | undefined,
): void {
  const normalizedPorts = normalizePorts(ports);
  validatePorts(normalizedPorts);
  validateNetwork(network, normalizedPorts);
}

function validatePorts(ports: readonly PortOptions[]): void {
  const seenPorts = new Set<number>();

  for (const { port, name, protocol } of ports) {
    validatePortNumber(port, "ports.port");

    if (seenPorts.has(port)) {
      throw new CWSandboxValidationError(`ports contains duplicate port: ${port}`);
    }

    if (name !== undefined && name.trim() === "") {
      throw new CWSandboxValidationError("ports.name must not be empty");
    }

    if (protocol !== undefined && protocol.trim() === "") {
      throw new CWSandboxValidationError("ports.protocol must not be empty");
    }

    seenPorts.add(port);
  }
}

function validateNetwork(network: NetworkOptions | undefined, ports: readonly PortOptions[]): void {
  if (network === undefined) {
    return;
  }

  if (network.ingressMode !== undefined && network.ingressMode.trim() === "") {
    throw new CWSandboxValidationError("network.ingressMode must not be empty");
  }

  if (network.egressMode !== undefined && network.egressMode.trim() === "") {
    throw new CWSandboxValidationError("network.egressMode must not be empty");
  }

  const declaredPorts = new Set(ports.map((port) => port.port));

  for (const exposedPort of network.exposedPorts ?? []) {
    validatePortNumber(exposedPort, "network.exposedPorts");

    if (declaredPorts.size > 0 && !declaredPorts.has(exposedPort)) {
      throw new CWSandboxValidationError(
        `network.exposedPorts contains undeclared port: ${exposedPort}`,
      );
    }
  }
}

function validatePortNumber(port: number, fieldName: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CWSandboxValidationError(`${fieldName} must be an integer between 1 and 65535`);
  }
}
