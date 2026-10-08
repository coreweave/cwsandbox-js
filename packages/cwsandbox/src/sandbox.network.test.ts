// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { CWSandboxUnavailableError, CWSandboxValidationError } from "./errors.js";
import type { GetSandboxResult } from "./public/sandbox.js";
import { createClient, createFakeTransport } from "./test/helpers.js";
import type { SandboxTransport } from "./transport.js";
import type { UpdateNetworkConfigRequest } from "./transport/types.js";

function transportWith(
  gets: readonly (Partial<GetSandboxResult> | Error)[],
  updates: UpdateNetworkConfigRequest[] = [],
): SandboxTransport {
  const queue = [...gets];
  const base = createFakeTransport();
  return {
    ...base,
    async start(request) {
      return { ...(await base.start(request)), networkConfigId: "nc-created" };
    },
    async get(request) {
      const next = queue.shift() ?? {};
      if (next instanceof Error) {
        throw next;
      }
      return { sandboxId: request.sandboxId, status: "running", ...next };
    },
    async updateNetworkConfig(request) {
      updates.push(request);
      return base.updateNetworkConfig(request);
    },
  };
}

describe("Sandbox network config", () => {
  it("exposes the bound networkConfigId from create", async () => {
    const client = createClient(transportWith([]));
    const sandbox = await client.run(["sleep"], { waitUntilRunning: false });

    expect(sandbox.networkConfigId).toBe("nc-created");
  });

  it("updates the bound config and refreshes cached DNS names", async () => {
    const updates: UpdateNetworkConfigRequest[] = [];
    const client = createClient(transportWith([{ dnsEgressNames: ["pypi.org"] }], updates));
    const sandbox = await client.run(["sleep"], { waitUntilRunning: false });

    const result = await sandbox.updateNetwork({ denyIngress: true });

    expect(updates).toMatchObject([
      {
        network: { denyIngress: true },
        networkConfigId: "nc-created",
        updateMask: ["denyIngress"],
      },
    ]);
    expect(result.networkConfigId).toBe("nc-created");
    expect(sandbox.dnsEgressNames).toEqual(["pypi.org"]);
  });

  it("derives the dnsEgress mask and refreshes the effective mode", async () => {
    const updates: UpdateNetworkConfigRequest[] = [];
    const client = createClient(transportWith([{ effectiveDnsEgress: "deny" }], updates));
    const sandbox = await client.run(["sleep"], { waitUntilRunning: false });

    await sandbox.updateNetwork({ dnsEgress: "deny" });

    expect(updates[0]?.updateMask).toEqual(["dnsEgress"]);
    expect(sandbox.effectiveDnsEgress).toBe("deny");
  });

  it("rejects an unknown dnsEgress mode", async () => {
    const client = createClient(transportWith([]));
    const sandbox = await client.run(["sleep"], { waitUntilRunning: false });

    await expect(
      sandbox.updateNetwork({ dnsEgress: "unspecified" as unknown as "allow" }),
    ).rejects.toBeInstanceOf(CWSandboxValidationError);
  });

  it("looks up the config id when the handle does not have one", async () => {
    const updates: UpdateNetworkConfigRequest[] = [];
    const client = createClient(transportWith([{ networkConfigId: "nc-from-get" }], updates));
    const sandbox = await client.fromId("sbx");

    await sandbox.updateNetwork({ denyEgress: false });

    expect(updates[0]?.networkConfigId).toBe("nc-from-get");
    expect(sandbox.networkConfigId).toBe("nc-from-get");
  });

  it("fails clearly when the backend reports no config", async () => {
    const updates: UpdateNetworkConfigRequest[] = [];
    const client = createClient(transportWith([{}, {}], updates));
    const sandbox = await client.fromId("sbx");

    await expect(sandbox.updateNetwork({ denyEgress: false })).rejects.toBeInstanceOf(
      CWSandboxValidationError,
    );
    expect(updates).toEqual([]);
  });

  it("returns the update result when the refresh fails", async () => {
    const client = createClient(transportWith([new CWSandboxUnavailableError("down")]));
    const sandbox = await client.run(["sleep"], { waitUntilRunning: false });

    await expect(sandbox.updateNetwork({ denyIngress: true })).resolves.toMatchObject({
      networkConfigId: "nc-created",
    });
  });
});

describe("create-time networkConfigId validation", () => {
  it("rejects network together with networkConfigId", async () => {
    const client = createClient();

    await expect(
      client.run(["sleep"], { network: { denyEgress: true }, networkConfigId: "agent-net" }),
    ).rejects.toThrow(/mutually exclusive/);
    await expect(
      client.runFromTemplate("tmpl", { network: {}, networkConfigId: "agent-net" }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it("rejects an empty networkConfigId", async () => {
    await expect(createClient().run(["sleep"], { networkConfigId: " " })).rejects.toBeInstanceOf(
      CWSandboxValidationError,
    );
  });

  it("rejects networkConfigId on from-file creates", async () => {
    const options = { networkConfigId: "agent-net", primaryService: "main" };

    await expect(
      createClient().runFromFile(new TextEncoder().encode("services: {}\n"), options),
    ).rejects.toThrow(/networkConfigId is not supported with from-file sandboxes/);
  });
});
