import { describe, expect, it } from "vitest";
import {
  overageStrategyAllows,
  resolveOverageStrategy,
  resolveHeartbeatResurrectionStrategy,
  ExpirationStrategy,
  RenewalBasis,
  AuthenticationStrategy,
  type Policy,
} from "../src/models/policy.js";

describe("resolveOverageStrategy", () => {
  it("resolves all 5 known wire values", () => {
    expect(resolveOverageStrategy("NO_OVERAGE")).toBe("NO_OVERAGE");
    expect(resolveOverageStrategy("ALLOW_1_25X_OVERAGE")).toBe("ALLOW_1_25X_OVERAGE");
    expect(resolveOverageStrategy("ALLOW_1_5X_OVERAGE")).toBe("ALLOW_1_5X_OVERAGE");
    expect(resolveOverageStrategy("ALLOW_2X_OVERAGE")).toBe("ALLOW_2X_OVERAGE");
    expect(resolveOverageStrategy("ALWAYS_ALLOW_OVERAGE")).toBe("ALWAYS_ALLOW_OVERAGE");
  });

  it("falls back to NO_OVERAGE for the real 'DENY_ACCESS' policy-create-default gotcha", () => {
    expect(resolveOverageStrategy("DENY_ACCESS")).toBe("NO_OVERAGE");
  });
});

describe("overageStrategyAllows", () => {
  it("NO_OVERAGE blocks at max + 1", () => {
    expect(overageStrategyAllows("NO_OVERAGE", 11, 10)).toBe(false);
    expect(overageStrategyAllows("NO_OVERAGE", 10, 10)).toBe(true);
  });

  it("ALLOW_1_25X_OVERAGE permits within allowance and blocks excess", () => {
    expect(overageStrategyAllows("ALLOW_1_25X_OVERAGE", 12, 10)).toBe(true);
    expect(overageStrategyAllows("ALLOW_1_25X_OVERAGE", 13, 10)).toBe(false);
  });

  it("ALLOW_1_5X_OVERAGE permits within allowance", () => {
    expect(overageStrategyAllows("ALLOW_1_5X_OVERAGE", 15, 10)).toBe(true);
  });

  it("ALLOW_2X_OVERAGE permits within allowance", () => {
    expect(overageStrategyAllows("ALLOW_2X_OVERAGE", 20, 10)).toBe(true);
  });

  it("ALWAYS_ALLOW_OVERAGE permits any count", () => {
    expect(overageStrategyAllows("ALWAYS_ALLOW_OVERAGE", 9999, 1)).toBe(true);
  });
});

describe("resolveHeartbeatResurrectionStrategy", () => {
  it("resolves all 7 known wire values", () => {
    expect(resolveHeartbeatResurrectionStrategy("NO_REVIVE")).toBe("NO_REVIVE");
    expect(resolveHeartbeatResurrectionStrategy("1_MINUTE_REVIVE")).toBe("1_MINUTE_REVIVE");
    expect(resolveHeartbeatResurrectionStrategy("2_MINUTE_REVIVE")).toBe("2_MINUTE_REVIVE");
    expect(resolveHeartbeatResurrectionStrategy("5_MINUTE_REVIVE")).toBe("5_MINUTE_REVIVE");
    expect(resolveHeartbeatResurrectionStrategy("10_MINUTE_REVIVE")).toBe("10_MINUTE_REVIVE");
    expect(resolveHeartbeatResurrectionStrategy("15_MINUTE_REVIVE")).toBe("15_MINUTE_REVIVE");
    expect(resolveHeartbeatResurrectionStrategy("ALWAYS_REVIVE")).toBe("ALWAYS_REVIVE");
  });

  it("falls back to NO_REVIVE for the real 'NO_RESURRECTION' policy-create-default gotcha", () => {
    expect(resolveHeartbeatResurrectionStrategy("NO_RESURRECTION")).toBe("NO_REVIVE");
  });
});

describe("free-text policy field constants", () => {
  it("match documented values", () => {
    expect(ExpirationStrategy.RESTRICT_ACCESS).toBe("RESTRICT_ACCESS");
    expect(ExpirationStrategy.MAINTAIN_ACCESS).toBe("MAINTAIN_ACCESS");
    expect(ExpirationStrategy.ALLOW_ACCESS).toBe("ALLOW_ACCESS");
    expect(RenewalBasis.FROM_EXPIRY).toBe("FROM_EXPIRY");
    expect(RenewalBasis.FROM_NOW).toBe("FROM_NOW");
    expect(AuthenticationStrategy.TOKEN).toBe("TOKEN");
    expect(AuthenticationStrategy.LICENSE).toBe("LICENSE");
    expect(AuthenticationStrategy.MIXED).toBe("MIXED");
  });
});

describe("Policy", () => {
  it("round-trips the real bogus defaults ('DENY_ACCESS'/'NO_RESURRECTION') without throwing", () => {
    const policy: Policy = {
      id: "01926b3e-0000-7000-8000-000000000000",
      type: "policies",
      attributes: {
        product_id: "01926b3e-1111-7000-8000-000000000000",
        name: "Default",
        duration: null,
        strict: false,
        floating: false,
        scheme: null,
        encrypted: false,
        use_pool: false,
        protected: false,
        require_check_in: false,
        check_in_interval: null,
        check_in_interval_count: null,
        require_heartbeat: false,
        heartbeat_duration: null,
        heartbeat_cull_strategy: "DEACTIVATE_DEAD",
        heartbeat_resurrection_strategy: "NO_RESURRECTION",
        machine_uniqueness_strategy: "UNIQUE_PER_LICENSE",
        expiration_strategy: "RESTRICT_ACCESS",
        expiration_basis: "FROM_CREATION",
        renewal_basis: "FROM_EXPIRY",
        authentication_strategy: "TOKEN",
        overage_strategy: "DENY_ACCESS",
        max_machines: null,
        max_cores: null,
        max_processes: null,
        max_uses: null,
        max_users: null,
        metadata: {},
        created: "2026-01-01T00:00:00Z",
        updated: "2026-01-01T00:00:00Z",
      },
    };

    expect(policy.attributes.overage_strategy).toBe("DENY_ACCESS");
    expect(resolveOverageStrategy(policy.attributes.overage_strategy)).toBe("NO_OVERAGE");
    expect(resolveHeartbeatResurrectionStrategy(policy.attributes.heartbeat_resurrection_strategy)).toBe(
      "NO_REVIVE",
    );
  });

  it("max_memory/max_disk are absent (undefined) from a representative GET response", () => {
    const attributes: Policy["attributes"] = {
      product_id: "p",
      name: "n",
      duration: null,
      strict: false,
      floating: false,
      scheme: null,
      encrypted: false,
      use_pool: false,
      protected: false,
      require_check_in: false,
      check_in_interval: null,
      check_in_interval_count: null,
      require_heartbeat: false,
      heartbeat_duration: null,
      heartbeat_cull_strategy: "KEEP_DEAD",
      heartbeat_resurrection_strategy: "NO_REVIVE",
      machine_uniqueness_strategy: "UNIQUE_PER_LICENSE",
      expiration_strategy: "RESTRICT_ACCESS",
      expiration_basis: "FROM_CREATION",
      renewal_basis: "FROM_EXPIRY",
      authentication_strategy: "TOKEN",
      overage_strategy: "NO_OVERAGE",
      max_machines: null,
      max_cores: null,
      max_processes: null,
      max_uses: null,
      max_users: null,
      metadata: {},
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    };
    expect(attributes.max_memory).toBeUndefined();
    expect(attributes.max_disk).toBeUndefined();
  });
});
