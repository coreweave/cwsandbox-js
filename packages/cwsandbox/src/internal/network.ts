// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxValidationError } from "../errors.js";
import type {
  CidrBlock,
  EgressRule,
  Endpoint,
  IngressRule,
  NetworkOptions,
  PortRange,
  Service,
} from "../public/network.js";

const ENDPOINT_AUTHS = new Set(["open", "share_token"]);
const ENDPOINT_KINDS = new Set(["https", "tls_passthrough"]);
const SERVICE_PROTOCOLS = new Set(["sctp", "tcp", "udp", "unspecified"]);
const SERVICE_VISIBILITIES = new Set(["custom", "private", "public", "unspecified"]);
// "unspecified" is a valid TenantScope for read-back but never a usable ingress source.
const TENANT_SCOPES: ReadonlySet<string> = new Set(["same_org", "same_user", "sandbox_network"]);

const DNS1123_LABEL = "[a-z0-9](?:[-a-z0-9]*[a-z0-9])?";
const DNS1123_SUBDOMAIN_RE = new RegExp(`^(?:${DNS1123_LABEL})(?:\\.(?:${DNS1123_LABEL}))*$`);
const DNS1123_SUBDOMAIN_MAX = 253;

export function validateNetworkOptions(
  services: readonly Service[] | undefined,
  network: NetworkOptions | undefined,
): void {
  validateServices(services);
  validateDenyFlags(network);
  validateEgress(network);
  validateIngress(network);
}

export function normalizeDnsName(dnsName: string): string {
  const name = dnsName.trim().toLowerCase();
  if (name === "") {
    throw new CWSandboxValidationError("network.egress[].dnsName cannot be empty");
  }
  if (name === "*") {
    throw new CWSandboxValidationError(
      'network.egress[].dnsName cannot be "*"; that is a policy ceiling, not a sandbox grant',
    );
  }
  if (!isDnsNameGrant(name)) {
    throw new CWSandboxValidationError(
      "network.egress[].dnsName must be a DNS-1123 subdomain or a single leftmost wildcard (*.example.com)",
    );
  }
  return name;
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

function validateEgress(network: NetworkOptions | undefined): void {
  if (network === undefined || network.egress === undefined) {
    return;
  }

  const egress = network.egress as unknown;
  if (typeof egress === "string" || !Array.isArray(egress)) {
    throw new CWSandboxValidationError("network.egress must be a sequence of { dnsName: string }");
  }

  for (const rule of egress) {
    if (!isEgressRule(rule)) {
      throw new CWSandboxValidationError(
        "network.egress must be a sequence of { dnsName: string }",
      );
    }
    normalizeDnsName(rule.dnsName);
  }

  if (network.denyEgress === true && egress.length > 0) {
    throw new CWSandboxValidationError("network.denyEgress cannot be combined with egress rules");
  }
}

function validateIngress(network: NetworkOptions | undefined): void {
  if (network === undefined || network.ingress === undefined) {
    return;
  }
  if (!Array.isArray(network.ingress)) {
    throw new CWSandboxValidationError("network.ingress must be an array of ingress rules");
  }
  for (const [index, rule] of (network.ingress as readonly unknown[]).entries()) {
    validateIngressRule(rule, `network.ingress[${index}]`);
  }
}

function validateIngressRule(value: unknown, field: string): void {
  if (!isObject(value)) {
    throw new CWSandboxValidationError(`${field} must be an object`);
  }
  const rule = value as IngressRule;
  if (rule.any !== undefined && typeof rule.any !== "boolean") {
    throw new CWSandboxValidationError(`${field}.any must be a boolean`);
  }
  const sources = [rule.cidr !== undefined, rule.tenant !== undefined, rule.any === true];
  if (sources.filter(Boolean).length !== 1) {
    throw new CWSandboxValidationError(
      `${field} requires exactly one source: cidr, tenant, or any: true`,
    );
  }
  if (rule.cidr !== undefined) {
    validateCidrBlock(rule.cidr, `${field}.cidr`);
  }
  if (rule.tenant !== undefined && !TENANT_SCOPES.has(rule.tenant)) {
    throw new CWSandboxValidationError(
      `${field}.tenant must be "same_org", "same_user", or "sandbox_network"`,
    );
  }
  if (rule.ports !== undefined) {
    if (!Array.isArray(rule.ports)) {
      throw new CWSandboxValidationError(`${field}.ports must be an array`);
    }
    for (const [index, port] of (rule.ports as readonly unknown[]).entries()) {
      validatePortRange(port, `${field}.ports[${index}]`);
    }
  }
}

function validateCidrBlock(value: unknown, field: string): void {
  if (!isObject(value)) {
    throw new CWSandboxValidationError(`${field} must be an object`);
  }
  const block = value as CidrBlock;
  if (typeof block.cidr !== "string" || block.cidr.trim() === "") {
    throw new CWSandboxValidationError(`${field}.cidr must be a non-empty string`);
  }
  if (block.exceptCidrs === undefined) {
    return;
  }
  if (
    !Array.isArray(block.exceptCidrs) ||
    !block.exceptCidrs.every((entry) => typeof entry === "string" && entry.trim() !== "")
  ) {
    throw new CWSandboxValidationError(
      `${field}.exceptCidrs must be an array of non-empty strings`,
    );
  }
}

function validatePortRange(value: unknown, field: string): void {
  if (!isObject(value)) {
    throw new CWSandboxValidationError(`${field} must be an object`);
  }
  const range = value as PortRange;
  validatePortNumber(range.port, `${field}.port`);
  if (range.endPort !== undefined) {
    validatePortNumber(range.endPort, `${field}.endPort`);
    if (range.endPort < range.port) {
      throw new CWSandboxValidationError(`${field}.endPort must not be less than port`);
    }
  }
  if (range.protocol !== undefined && typeof range.protocol !== "string") {
    throw new CWSandboxValidationError(`${field}.protocol must be a string`);
  }
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEgressRule(value: unknown): value is EgressRule {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly dnsName?: unknown }).dnsName === "string"
  );
}

function isDnsNameGrant(name: string): boolean {
  if (name.length > DNS1123_SUBDOMAIN_MAX) {
    return false;
  }
  if (name.startsWith("*.")) {
    return isDns1123Subdomain(name.slice(2));
  }
  return isDns1123Subdomain(name);
}

function isDns1123Subdomain(name: string): boolean {
  return name.length <= DNS1123_SUBDOMAIN_MAX && DNS1123_SUBDOMAIN_RE.test(name);
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
  if (kind === undefined || !ENDPOINT_KINDS.has(kind)) {
    throw new CWSandboxValidationError("Service.endpoint.kind must be https or tls_passthrough");
  }
  if (visibility !== "public") {
    throw new CWSandboxValidationError("Service.visibility must be public when endpoint is set");
  }
  if (protocol !== undefined && protocol !== "unspecified" && protocol !== "tcp") {
    throw new CWSandboxValidationError(
      "Service.protocol must be unset or tcp when endpoint is set",
    );
  }
  if (kind === "tls_passthrough") {
    validateTlsPassthroughEndpoint(endpoint);
    return;
  }
  validateHttpsEndpoint(endpoint);
}

function validateHttpsEndpoint(endpoint: Endpoint): void {
  const auth = normalizeEnum("auth" in endpoint ? endpoint.auth : undefined);
  if (auth === undefined || !ENDPOINT_AUTHS.has(auth)) {
    throw new CWSandboxValidationError("Service.endpoint.auth must be open or share_token");
  }
  validateRequestTimeoutSeconds(
    "requestTimeoutSeconds" in endpoint ? endpoint.requestTimeoutSeconds : undefined,
  );
}

function validateTlsPassthroughEndpoint(endpoint: Endpoint): void {
  const auth = "auth" in endpoint ? endpoint.auth : undefined;
  if (auth !== undefined) {
    throw new CWSandboxValidationError(
      "Service.endpoint.auth must be unset when kind is tls_passthrough",
    );
  }
  if ("requestTimeoutSeconds" in endpoint && endpoint.requestTimeoutSeconds !== undefined) {
    throw new CWSandboxValidationError(
      "Service.endpoint.requestTimeoutSeconds must be unset when kind is tls_passthrough",
    );
  }
}

function validateRequestTimeoutSeconds(value: number | undefined): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new CWSandboxValidationError(
      "Service.endpoint.requestTimeoutSeconds must be a non-negative integer",
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
