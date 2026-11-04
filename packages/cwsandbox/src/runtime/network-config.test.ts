// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import {
  CWSandboxNotFoundError,
  CWSandboxTransportError,
  CWSandboxValidationError,
} from "../errors.js";
import type { NetworkConfigResult } from "../public/network-config.js";
import { createFakeNetworkConfig, createFakeTransport } from "../test/helpers.js";
import type { SandboxTransport } from "../transport.js";
import type {
  GetNetworkConfigRequest,
  ListNetworkConfigsRequest,
  UpdateNetworkConfigRequest,
} from "../transport/types.js";
import {
  createNetworkConfigRecord,
  deleteNetworkConfigRecord,
  listNetworkConfigRecords,
  updateNetworkConfigRecord,
} from "./network-config.js";

function recordingTransport(current: NetworkConfigResult = createFakeNetworkConfig("agent-net")): {
  readonly gets: GetNetworkConfigRequest[];
  readonly transport: SandboxTransport;
  readonly updates: UpdateNetworkConfigRequest[];
} {
  const gets: GetNetworkConfigRequest[] = [];
  const updates: UpdateNetworkConfigRequest[] = [];
  const base = createFakeTransport();
  return {
    gets,
    transport: {
      ...base,
      async getNetworkConfig(request) {
        gets.push(request);
        return current;
      },
      async updateNetworkConfig(request) {
        updates.push(request);
        return base.updateNetworkConfig(request);
      },
    },
    updates,
  };
}

describe("updateNetworkConfigRecord", () => {
  it("derives the mask from set fields and skips the read without egress", async () => {
    const { gets, transport, updates } = recordingTransport();

    await updateNetworkConfigRecord(transport, "agent-net", { denyIngress: true });

    expect(gets).toEqual([]);
    expect(updates).toEqual([
      { network: { denyIngress: true }, networkConfigId: "agent-net", updateMask: ["denyIngress"] },
    ]);
  });

  it("reads first and pins the read etag when writing egress", async () => {
    const { gets, transport, updates } = recordingTransport(
      createFakeNetworkConfig("agent-net", { etag: "etag-read" }),
    );

    await updateNetworkConfigRecord(transport, "agent-net", {
      egress: [{ dnsName: "pypi.org" }],
    });

    expect(gets).toHaveLength(1);
    expect(updates[0]).toMatchObject({ etag: "etag-read", updateMask: ["egress"] });
  });

  it("keeps a caller-supplied etag over the read one", async () => {
    const { transport, updates } = recordingTransport(
      createFakeNetworkConfig("agent-net", { etag: "etag-read" }),
    );

    await updateNetworkConfigRecord(transport, "agent-net", { egress: [] }, { etag: "mine" });

    expect(updates[0]?.etag).toBe("mine");
  });

  it("refuses to write egress over rules it cannot represent", async () => {
    const { transport, updates } = recordingTransport(
      createFakeNetworkConfig("agent-net", { unsupportedFields: ["egress"] }),
    );

    await expect(updateNetworkConfigRecord(transport, "agent-net", { egress: [] })).rejects.toThrow(
      /egress rules this SDK cannot represent/,
    );
    expect(updates).toEqual([]);
  });

  it("reads first and refuses to write ingress over rules it cannot represent", async () => {
    const blocked = recordingTransport(
      createFakeNetworkConfig("agent-net", { unsupportedFields: ["ingress"] }),
    );
    await expect(
      updateNetworkConfigRecord(blocked.transport, "agent-net", {
        ingress: [{ tenant: "same_org" }],
      }),
    ).rejects.toThrow(/ingress rules this SDK cannot represent/);
    expect(blocked.updates).toEqual([]);

    const allowed = recordingTransport(
      createFakeNetworkConfig("agent-net", { etag: "etag-read", unsupportedFields: ["egress"] }),
    );
    await updateNetworkConfigRecord(allowed.transport, "agent-net", {
      ingress: [{ tenant: "same_org" }],
    });
    expect(allowed.gets).toHaveLength(1);
    expect(allowed.updates[0]).toMatchObject({ etag: "etag-read", updateMask: ["ingress"] });
  });

  it("allows deny-flag writes over rules it cannot represent", async () => {
    const { transport, updates } = recordingTransport(
      createFakeNetworkConfig("agent-net", { unsupportedFields: ["egress", "ingress"] }),
    );

    await updateNetworkConfigRecord(transport, "agent-net", { denyEgress: false });

    expect(updates).toHaveLength(1);
  });

  it("sends an explicit mask as given, clearing named fields left unset", async () => {
    const { transport, updates } = recordingTransport();

    await updateNetworkConfigRecord(transport, "agent-net", {}, { updateMask: ["egress"] });
    await updateNetworkConfigRecord(transport, "agent-net", {}, { updateMask: [] });

    expect(updates.map((request) => request.updateMask)).toEqual([["egress"], []]);
  });

  it("sends no fields with an empty mask and skips the egress read", async () => {
    const { gets, transport, updates } = recordingTransport(
      createFakeNetworkConfig("agent-net", { unsupportedFields: ["egress"] }),
    );

    await updateNetworkConfigRecord(
      transport,
      "agent-net",
      { denyIngress: true, egress: [{ dnsName: "pypi.org" }] },
      { etag: "etag-1", updateMask: [] },
    );

    expect(gets).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.network).toEqual({});
    expect(updates[0]).toMatchObject({ etag: "etag-1", updateMask: [] });
  });

  it("still validates the network given with an empty mask", async () => {
    const { transport, updates } = recordingTransport();

    await expect(
      updateNetworkConfigRecord(
        transport,
        "agent-net",
        { egress: [{ dnsName: "*" }] },
        { updateMask: [] },
      ),
    ).rejects.toBeInstanceOf(CWSandboxValidationError);
    expect(updates).toEqual([]);
  });

  it("rejects an update that names no fields", async () => {
    const { transport } = recordingTransport();

    await expect(updateNetworkConfigRecord(transport, "agent-net", {})).rejects.toBeInstanceOf(
      CWSandboxValidationError,
    );
  });

  it.each([["*"], ["services"], ["spec.egress"]])("rejects mask entry %s", async (field) => {
    const { transport } = recordingTransport();

    await expect(
      updateNetworkConfigRecord(
        transport,
        "agent-net",
        {},
        { updateMask: [field] as unknown as readonly ["egress"] },
      ),
    ).rejects.toBeInstanceOf(CWSandboxValidationError);
  });

  it("validates rules and the id before any RPC", async () => {
    const { gets, transport, updates } = recordingTransport();

    await expect(
      updateNetworkConfigRecord(transport, "agent-net", {
        denyEgress: true,
        egress: [{ dnsName: "pypi.org" }],
      }),
    ).rejects.toBeInstanceOf(CWSandboxValidationError);
    await expect(
      updateNetworkConfigRecord(transport, " ", { denyEgress: true }),
    ).rejects.toBeInstanceOf(CWSandboxValidationError);
    expect(gets).toEqual([]);
    expect(updates).toEqual([]);
  });
});

describe("createNetworkConfigRecord", () => {
  it("rejects invalid rules before the RPC", async () => {
    await expect(
      createNetworkConfigRecord(createFakeTransport(), "agent-net", {
        network: { egress: [{ dnsName: "*" }] },
      }),
    ).rejects.toBeInstanceOf(CWSandboxValidationError);
  });
});

describe("listNetworkConfigRecords", () => {
  it("collects every page and forwards the filter", async () => {
    const requests: ListNetworkConfigsRequest[] = [];
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async listNetworkConfigs(request) {
        requests.push(request);
        return request.pageToken === undefined
          ? { networkConfigs: [createFakeNetworkConfig("a")], nextPageToken: "p2" }
          : { networkConfigs: [createFakeNetworkConfig("b")] };
      },
    };

    const configs = await listNetworkConfigRecords(transport, { platformManaged: true });

    expect(configs.map((config) => config.networkConfigId)).toEqual(["a", "b"]);
    expect(requests.map((request) => [request.pageToken, request.platformManaged])).toEqual([
      [undefined, true],
      ["p2", true],
    ]);
  });

  it("detects a repeated page token", async () => {
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async listNetworkConfigs() {
        return { networkConfigs: [], nextPageToken: "same" };
      },
    };

    await expect(listNetworkConfigRecords(transport)).rejects.toBeInstanceOf(
      CWSandboxTransportError,
    );
  });
});

describe("deleteNetworkConfigRecord", () => {
  it("swallows not-found only with missingOk", async () => {
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async deleteNetworkConfig() {
        throw new CWSandboxNotFoundError("gone");
      },
    };

    await expect(
      deleteNetworkConfigRecord(transport, "agent-net", { missingOk: true }),
    ).resolves.toBeUndefined();
    await expect(deleteNetworkConfigRecord(transport, "agent-net")).rejects.toBeInstanceOf(
      CWSandboxNotFoundError,
    );
  });
});
