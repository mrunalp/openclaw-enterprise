import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import { RUNTIME_WRAPPER_COMMAND } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { SandboxRevisionUnsupportedError } from "../../packages/occ/src/index.ts";
import { createInstallationDriverConfiguration as installation } from "../helpers/installation-driver-configuration.mjs";

const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const { KubernetesObjectApi } = controllerRequire("@kubernetes/client-node");

async function fixture(t, configuration) {
  const directory = await mkdtemp(join(tmpdir(), "occ-sandbox-startup-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "installation.yaml");
  await writeFile(path, JSON.stringify(configuration), "utf8");
  return path;
}

function sandboxInstallation() {
  const configuration = installation();
  configuration.drivers.compute.configuration.servicePrincipalCredentials = { mode: "disabled" };
  configuration.backend = [
    {
      id: "openshell",
      type: "openshell",
      configuration: {
        serviceName: "openshell-gateway",
        port: 50051,
        insecureTransport: "network-policy",
      },
      drivers: { sandbox: "openshell-sandbox", credential_gateway: "openshell-credentials" },
    },
  ];
  configuration.drivers.credential_gateway = {
    id: "openshell-credentials",
    configuration: { binaries: ["/app/bin/model-client"] },
  };
  configuration.drivers.sandbox = {
    id: "openshell-sandbox",
    configuration: {
      gateway: {
        workspaceMode: "operator",
      },
      kubernetes: {
        runtimeClassName: "openshell-sandbox",
        serviceAccount: { mode: "gatewayConfigured" },
        sandboxDataMount: {
          subPath: "workspace",
          mountPath: "/sandbox/enterprise",
          readOnly: false,
        },
      },
      policy: {
        process: { runAsUser: "1000", runAsGroup: "1000" },
        networkPolicies: [
          {
            name: "model-egress",
            endpoints: [{ host: "api.openai.com", ports: [443] }],
            binaries: [{ path: "/app/bin/model-client" }],
          },
        ],
      },
    },
  };
  return configuration;
}

function backendFor(gatewayClient) {
  return {
    id: "openshell",
    drivers: { sandbox: "openshell-sandbox", credential_gateway: "openshell-credentials" },
    client: new OpenShellGateway({ serviceName: "openshell-gateway" }, { gatewayClient }),
  };
}

function harnessRuntimeCommand(program) {
  return [...RUNTIME_WRAPPER_COMMAND, ...nodeProgramArguments(program)];
}

function workspaceGatewayClient(seed = [], events = []) {
  const workspaces = new Map(seed.map((workspace) => [workspace.name, structuredClone(workspace)]));
  const profiles = new Map();
  const providers = new Map();
  const calls = [];
  return {
    calls,
    profiles,
    providers,
    workspaces,
    async health() {
      calls.push(["health"]);
      events.push(["gateway", "health"]);
    },
    async getWorkspace(name) {
      calls.push(["getWorkspace", name]);
      events.push(["gateway", "getWorkspace", name]);
      return workspaces.get(name);
    },
    async createWorkspace(name, labels) {
      calls.push(["createWorkspace", name, structuredClone(labels)]);
      events.push(["gateway", "createWorkspace", name]);
      const workspace = { name, labels: structuredClone(labels), phase: "WORKSPACE_PHASE_ACTIVE" };
      workspaces.set(name, workspace);
      return workspace;
    },
    async deleteWorkspace(name) {
      calls.push(["deleteWorkspace", name]);
      events.push(["gateway", "deleteWorkspace", name]);
      workspaces.delete(name);
    },
    async createSandbox() {
      throw new Error("Sandbox creation is outside this Namespace lifecycle scenario.");
    },
    async getSandbox() {
      return undefined;
    },
    async getService() {
      return undefined;
    },
    async deleteSandbox() {},
    async getProviderProfile(_workspace, id) {
      return profiles.get(id);
    },
    async importProviderProfile(_workspace, profile) {
      profiles.set(profile.id, {
        id: profile.id,
        resourceVersion: "1",
        annotations: structuredClone(profile.annotations),
        profile: structuredClone(profile),
      });
    },
    async updateProviderProfile(_workspace, profile) {
      profiles.set(profile.id, {
        id: profile.id,
        resourceVersion: "2",
        annotations: structuredClone(profile.annotations),
        profile: structuredClone(profile),
      });
    },
    async deleteProviderProfile(_workspace, id) {
      profiles.delete(id);
    },
    async createProvider(request) {
      calls.push(["createProvider", structuredClone(request)]);
      if (providers.has(request.name)) {
        throw new Error(`Provider ${request.name} already exists.`);
      }
      const provider = {
        name: request.name,
        type: request.type,
        labels: structuredClone(request.labels),
        config: structuredClone(request.config ?? {}),
      };
      providers.set(request.name, provider);
      return provider;
    },
    async getProvider(_workspace, name) {
      return providers.get(name);
    },
    async listProviders() {
      return [...providers.values()];
    },
    async deleteProvider(_workspace, name) {
      providers.delete(name);
    },
    async updateProviderCredentials(_workspace, name, credentials) {
      calls.push(["updateProviderCredentials", name, structuredClone(credentials)]);
    },
    close() {},
  };
}

function kubernetesObjectClient(events) {
  const client = Object.create(KubernetesObjectApi.prototype);
  client.patch = async (resource) => {
    events.push([
      "kubernetes",
      "patch",
      resource.kind,
      resource.metadata.name,
      resource.metadata.namespace,
    ]);
    return resource;
  };
  client.delete = async (resource) => {
    events.push([
      "kubernetes",
      "delete",
      resource.kind,
      resource.metadata.name,
      resource.metadata.namespace,
    ]);
  };
  return client;
}

function namespaceContext(name = "oce-123456789012345") {
  return {
    namespace: {
      id: "ns_00000000-0000-4000-8000-000000000001",
      name,
      status: "ready",
      createdAt: "2026-09-23T00:00:00.000Z",
    },
    kubernetes: {},
    signal: new AbortController().signal,
  };
}

function codexSandboxFixture(
  driver,
  {
    runtimeManifest = JSON.stringify({ kind: "codex", selections: {} }),
    codexConfig = "[features]\nplugins = false\n",
    files,
  } = {},
) {
  const context = namespaceContext();
  const revision = {
    id: "rev_00000000-0000-4000-8000-000000000003",
    namespaceId: context.namespace.id,
    agentId: "agt_00000000-0000-4000-8000-000000000003",
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    sandboxDriverId: driver.id,
  };
  const nodeSetup = {
    url: "wss://gateway.example.test/node",
    bootstrapToken: "one-shot-node-setup",
    expiresAtMs: Date.now() + 600_000,
    tlsFingerprint: "sha256:test",
  };
  const setupCode = Buffer.from(JSON.stringify(nodeSetup)).toString("base64url");
  const kubernetes = Object.create(KubernetesObjectApi.prototype);
  kubernetes.read = async ({ metadata }) => ({
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      ...metadata,
      labels: {
        "openclaw.dev/namespace": context.namespace.id,
        "openclaw.dev/agent": revision.agentId,
      },
    },
    data: { setupCode: Buffer.from(setupCode).toString("base64") },
  });
  context.kubernetes = kubernetes;
  const requirements = {
    loginMode: "api_key",
    image: "codex-runtime@sha256:synthetic",
    command: harnessRuntimeCommand('console.error("codex runtime");'),
    workspaceMounts: [
      {
        claimName: "harness-workspace-codex",
        subPath: "workspace",
        mountPath: "/home/node/workspace",
        readOnly: false,
      },
      {
        claimName: "harness-workspace-codex",
        subPath: "workspace-node-codex",
        mountPath: "/home/node/.openclaw-node",
        readOnly: false,
      },
      {
        claimName: "harness-workspace-codex",
        subPath: "codex-sessions",
        mountPath: "/home/node/.codex/sessions",
        readOnly: false,
      },
    ],
    credentialAttachments: [{ sourceId: "cs_test", ref: `oce-cs-${"b".repeat(24)}` }],
    environment: [
      { name: "HOME", value: "/home/node" },
      { name: "CODEX_HOME", value: "/home/node/.codex" },
      { name: "OPENCLAW_NODE_STATE_DIR", value: "/home/node/.openclaw-node" },
      { name: "OPENCLAW_WORKSPACE_DIR", value: "/home/node/workspace" },
      {
        name: "OPENCLAW_NODE_CA_PEM",
        value: "-----BEGIN CERTIFICATE-----\npublic-ca\n-----END CERTIFICATE-----\n",
      },
      { name: "APP_SERVER_PORT", value: "8080" },
      { name: "APP_TOKEN_SHA", value: "a".repeat(64) },
      {
        name: "OPENCLAW_NODE_SETUP_CODE",
        valueFrom: { secretKeyRef: { name: "workspace-node", key: "setupCode" } },
      },
    ],
    files: files ?? [
      {
        name: "runtime.json",
        content: runtimeManifest,
        environmentVariable: "OPENCLAW_PLUGIN_RUNTIME_MANIFEST",
      },
      {
        name: "config.toml",
        content: codexConfig,
        environmentVariable: "OPENCLAW_PLUGIN_CODEX_CONFIG_TOML",
      },
    ],
    labels: { "openclaw.dev/revision": revision.id },
  };
  return { context, revision, requirements, runtimeManifest, codexConfig, nodeSetup };
}

test("startup constructs the bundled OpenShell SandboxDriver before constructing Kubernetes Compute", async (t) => {
  const createdDriver = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: await fixture(t, sandboxInstallation()) },
  });

  assert.equal(createdDriver.installation.drivers.sandbox.id, "openshell-sandbox");
  assert.equal(createdDriver.installation.drivers.sandbox.implementation, "openshell");
  assert.ok(createdDriver.sandboxDriver instanceof OpenShellSandboxDriver);
  assert.equal(createdDriver.sandboxDriver.id, "openshell-sandbox");
  assert.deepEqual(createdDriver.sandboxDriver.facets, ["networking", "filesystem", "process"]);

  const pool = new pg.Pool({ connectionString: "postgresql://127.0.0.1:1/occ" });
  t.after(async () => pool.end());
  assert.doesNotThrow(() =>
    createControllerWorker({
      pool,
      mode: "production",
      drivers: createdDriver,
      emit: () => {},
    }),
  );
});

test("startup composes both OpenShell members from one Backend", async (t) => {
  const createdDriver = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: await fixture(t, sandboxInstallation()) },
  });

  assert.ok(createdDriver.credentialGatewayDriver instanceof OpenShellCredentialGatewayDriver);
  assert.equal(createdDriver.credentialGatewayDriver.id, "openshell-credentials");
  assert.equal(createdDriver.installation.drivers.credential_gateway.implementation, "openshell");
  assert.deepEqual(createdDriver.installation.backend[0].drivers, {
    sandbox: createdDriver.sandboxDriver.id,
    credential_gateway: createdDriver.credentialGatewayDriver.id,
  });
});

test("startup rejects an OpenShell Backend whose members are not both selected", async (t) => {
  const missingGateway = sandboxInstallation();
  delete missingGateway.drivers.credential_gateway;
  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, missingGateway) },
    }),
    /drivers\.credential_gateway must match the selected drivers\.credential_gateway\.id/,
  );

  const foreignSandbox = sandboxInstallation();
  foreignSandbox.backend[0].drivers.sandbox = "another-sandbox";
  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, foreignSandbox) },
    }),
    /drivers\.sandbox must match the selected bundled OpenShell drivers\.sandbox\.id/,
  );

  // Connection settings belong to the Backend; the Sandbox rejects them instead of ignoring them.
  const legacyEndpoint = sandboxInstallation();
  legacyEndpoint.drivers.sandbox.configuration.gateway.endpoint = "http://127.0.0.1:1";
  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, legacyEndpoint) },
    }),
    /OpenShell gateway option endpoint belongs to the openshell Backend/,
  );
});

test("startup requires protected OpenShell transport or an explicit NetworkPolicy boundary", async (t) => {
  const load = async (configuration) =>
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
    });
  // Credential registration sends resolved values, so plain or unauthenticated transport
  // must be declared rather than accepted by default.
  const undeclared = sandboxInstallation();
  delete undeclared.backend[0].configuration.insecureTransport;
  await assert.rejects(
    load(undeclared),
    /requires TLS with bearerTokenFile authentication, or insecureTransport: network-policy/,
  );
  // TLS alone is not enough; the gateway must also authenticate OCC.
  const tlsOnly = sandboxInstallation();
  tlsOnly.backend[0].configuration = { endpoint: "https://openshell-gateway.openshell.svc:8080" };
  await assert.rejects(load(tlsOnly), /requires TLS with bearerTokenFile authentication/);

  const protectedTransport = sandboxInstallation();
  protectedTransport.backend[0].configuration = {
    endpoint: "https://openshell-gateway.openshell.svc:8080",
    auth: { mode: "bearerTokenFile", path: "/etc/openclaw/openshell/token" },
  };
  await load(protectedTransport);
  // The declaration is only for unprotected transport, so it cannot mask a protected setup.
  protectedTransport.backend[0].configuration.insecureTransport = "network-policy";
  await assert.rejects(load(protectedTransport), /insecureTransport is only for unprotected/);

  // Every gateway call's deadline stays within the registration fence.
  const slow = sandboxInstallation();
  slow.backend[0].configuration.requestTimeoutMs = 60_000;
  await assert.rejects(load(slow), /requestTimeoutMs must be between 1000 and 30000 ms/);
});

test("OpenShell configures only the selected dedicated Harness runtime", () => {
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(workspaceGatewayClient()),
  });
  const configuration = {
    agents: { defaults: { model: "openai/gpt-5" } },
  };
  assert.deepEqual(
    driver.configureAgent(configuration, {
      id: "openclaw",
      version: "1.0.0",
      mode: "dedicated",
    }),
    configuration,
  );

  const codex = driver.configureAgent(configuration, {
    id: "codex",
    version: "1.0.0",
    mode: "dedicated",
  });
  assert.equal(codex.plugins.entries.codex.config.appServer.sandbox, "danger-full-access");
  assert.throws(
    () =>
      driver.configureAgent(configuration, {
        id: "openclaw",
        version: "1.0.0",
        mode: "embedded",
      }),
    /supports only dedicated Harness revisions/,
  );
});

test("OpenShell provisions native OpenClaw without exposing an inbound Harness service", async () => {
  const requests = [];
  const gatewayClient = workspaceGatewayClient();
  gatewayClient.createSandbox = async (request) => {
    requests.push(request);
    return {
      name: request.name,
      labels: request.labels,
      serviceUrls: {},
    };
  };
  const configuration = sandboxInstallation().drivers.sandbox.configuration;
  configuration.policy.filesystem = {
    includeWorkdir: false,
    readOnly: ["/app"],
    readWrite: ["/var/tmp/openclaw"],
  };
  const driver = new OpenShellSandboxDriver(configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  const context = namespaceContext();
  const revisionId = "rev_00000000-0000-4000-8000-000000000001";
  const revision = {
    id: revisionId,
    namespaceId: context.namespace.id,
    agentId: "agt_00000000-0000-4000-8000-000000000001",
    harness: { id: "openclaw", version: "1.0.0", mode: "dedicated" },
    sandboxDriverId: driver.id,
  };
  const labels = {
    "app.kubernetes.io/managed-by": "openclaw-enterprise",
    "openclaw.dev/agent": revision.agentId,
    "openclaw.dev/revision": revision.id,
    "openclaw.dev/workload-role": "agent",
  };
  const command = harnessRuntimeCommand('console.error("native runtime");');
  const sandbox = await driver.provisionHarness({
    ...context,
    revision,
    requirements: {
      loginMode: "api_key",
      image: "openclaw-runtime@sha256:synthetic",
      command,
      workspaceMounts: [
        {
          claimName: "harness-workspace-native-openclaw",
          subPath: "workspace",
          mountPath: "/home/node/workspace",
          readOnly: false,
        },
        {
          claimName: "harness-workspace-native-openclaw",
          subPath: "workspace-node-native-openclaw",
          mountPath: "/home/node/.openclaw-node",
          readOnly: false,
        },
      ],
      credentialAttachments: [],
      environment: [{ name: "TMPDIR", value: "/tmp/openclaw-native-worker" }],
      labels,
    },
  });

  assert.equal(sandbox.revisionId, revisionId);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].serviceExposures, []);
  assert.deepEqual(
    requests[0].spec.command.slice(0, RUNTIME_WRAPPER_COMMAND.length),
    RUNTIME_WRAPPER_COMMAND,
  );
  assert.notEqual(requests[0].spec.command[RUNTIME_WRAPPER_COMMAND.length], command.at(-2));
  assert.match(
    requests[0].spec.command[RUNTIME_WRAPPER_COMMAND.length],
    /OpenShell workspace link conflicts/,
  );
  assert.deepEqual(requests[0].labels, labels);
  assert.equal(requests[0].spec.environment.TMPDIR, "/tmp");
  assert.equal(requests[0].spec.policy.filesystem.include_workdir, false);
  assert.deepEqual(requests[0].spec.policy.filesystem.read_only, ["/app"]);
  assert.ok(requests[0].spec.policy.filesystem.read_write.includes("/var/tmp/openclaw"));
  assert.ok(requests[0].spec.policy.filesystem.read_write.includes("/tmp"));
  assert.equal(requests[0].spec.policy.filesystem.read_only.includes("/bin"), false);
});

test("OpenShell rejects raw app-server tokens as a permanent revision failure", async () => {
  const gatewayClient = workspaceGatewayClient();
  gatewayClient.createSandbox = async () => {
    throw new Error("OpenShell must not receive a Sandbox it cannot configure.");
  };
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  const context = namespaceContext();
  const revision = {
    id: "rev_00000000-0000-4000-8000-000000000002",
    namespaceId: context.namespace.id,
    agentId: "agt_00000000-0000-4000-8000-000000000002",
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    sandboxDriverId: driver.id,
  };
  const provision = (harness) =>
    driver.provisionHarness({
      ...context,
      revision: { ...revision, harness },
      requirements: {
        loginMode: "api_key",
        image: "codex-runtime@sha256:synthetic",
        command: ["codex"],
        workspaceMounts: [
          {
            claimName: "harness-workspace-codex",
            subPath: "workspace",
            mountPath: "/home/node/workspace",
            readOnly: false,
          },
        ],
        credentialAttachments: [],
        environment: [
          { name: "APP_SERVER_PORT", value: "8080" },
          {
            name: "APP_SERVER_TOKEN",
            valueFrom: { secretKeyRef: { name: "agent-codex-token", key: "token" } },
          },
        ],
        labels: { "openclaw.dev/revision": revision.id },
      },
    });

  await assert.rejects(provision(revision.harness), (error) => {
    assert.ok(error instanceof SandboxRevisionUnsupportedError, String(error));
    assert.equal(error.code, "SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED");
    assert.match(error.message, /requires one literal APP_TOKEN_SHA verifier/);
    return true;
  });
  await assert.rejects(provision({ id: "codex", version: "1.0.0", mode: "embedded" }), (error) => {
    assert.ok(error instanceof SandboxRevisionUnsupportedError, String(error));
    assert.equal(error.code, "SANDBOX_HARNESS_UNSUPPORTED");
    return true;
  });
});

test("OpenShell rejects projected Agent identity before gateway mutation", async () => {
  const gatewayClient = workspaceGatewayClient();
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  const { context, revision, requirements } = codexSandboxFixture(driver);
  requirements.workloadIdentity = {
    serviceAccountName: "agent-codex",
    token: {
      audience: "openclaw-enterprise",
      expirationSeconds: 900,
      mountPath: "/var/run/secrets/openclaw-enterprise",
      path: "token",
      readOnly: true,
    },
  };

  await assert.rejects(driver.provisionHarness({ ...context, revision, requirements }), (error) => {
    assert.ok(error instanceof SandboxRevisionUnsupportedError, String(error));
    assert.equal(error.code, "SANDBOX_HARNESS_UNSUPPORTED");
    assert.match(error.message, /cannot preserve an Agent ServiceAccount/);
    return true;
  });
  assert.deepEqual(gatewayClient.calls, []);
});

test("OpenShell provisions dedicated Codex with bearer passthrough and provider files", async () => {
  const requests = [];
  let getServiceCalls = 0;
  let storedSandbox;
  const withProtobufKinds = (value) => {
    if (Array.isArray(value)) {
      return value.map(withProtobufKinds);
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    const normalized = Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, withProtobufKinds(entry)]),
    );
    const kind = [
      "nullValue",
      "numberValue",
      "stringValue",
      "boolValue",
      "structValue",
      "listValue",
    ].find((key) => Object.hasOwn(normalized, key));
    return kind === undefined ? normalized : { ...normalized, kind };
  };
  const gatewayClient = workspaceGatewayClient();
  gatewayClient.createSandbox = async (request) => {
    requests.push(structuredClone(request));
    storedSandbox = {
      name: request.name,
      workspace: request.workspace,
      labels: structuredClone(request.labels),
      annotations: {
        ...structuredClone(request.annotations),
        "internal.openshell.ai/auth-epoch": "1",
        "internal.openshell.ai/runtime-generation": "runtime-generation",
      },
      spec: {
        ...structuredClone(request.spec),
        template: {
          ...structuredClone(request.spec.template),
          driver_config: withProtobufKinds(request.spec.template.driver_config),
        },
      },
      serviceUrls: {},
    };
    return {
      ...storedSandbox,
      serviceUrls: { "": "http://codex.example.test" },
    };
  };
  gatewayClient.getSandbox = async () => storedSandbox;
  gatewayClient.getService = async () => {
    getServiceCalls++;
    return {
      sandbox: storedSandbox.name,
      name: "",
      targetPort: 8080,
      authorizationMode: "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH",
      advertisedUrl: "http://codex.example.test:8080/",
      url: "http://codex.example.test",
    };
  };
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  const { context, revision, requirements, runtimeManifest, codexConfig, nodeSetup } =
    codexSandboxFixture(driver);

  await driver.ensureNamespace(context);
  await driver.provisionHarness({ ...context, revision, requirements });
  await driver.provisionHarness({ ...context, revision, requirements });
  assert.deepEqual(await driver.harnessEndpoint({ ...context, revision, requirements }), {
    url: "ws://codex.example.test:8080/",
    workspaceRoot: "/sandbox/enterprise",
  });

  assert.equal(requests.length, 1);
  assert.equal(getServiceCalls, 2);
  assert.equal(requests[0].spec.tty, undefined);
  assert.equal(requests[0].spec.template.annotations, undefined);
  assert.deepEqual(requests[0].serviceExposures, [
    { service: "", targetPort: 8080, authorizationMode: "bearer_passthrough" },
  ]);
  assert.equal(requests[0].spec.environment.APP_TOKEN_SHA, "a".repeat(64));
  assert.equal(requests[0].spec.environment.APP_SERVER_TOKEN, undefined);
  assert.equal(requests[0].spec.environment.OPENCLAW_NODE_SETUP_CODE, undefined);
  assert.equal(requests[0].spec.environment.OPENCLAW_NODE_CA_PEM, undefined);
  assert.equal(requests[0].spec.environment.HOME, "/sandbox/.openclaw-runtime/home");
  assert.equal(requests[0].spec.environment.TMPDIR, "/tmp");
  assert.equal(requests[0].spec.environment.CODEX_HOME, "/sandbox/.openclaw-runtime/home/.codex");
  const nodeStateDirectory = requests[0].spec.environment.OPENCLAW_NODE_STATE_DIR;
  assert.match(nodeStateDirectory, /^\/sandbox\/\.openclaw-mounts\/[a-f0-9]{16}\/state$/u);
  assert.equal(requests[0].spec.environment.OPENCLAW_WORKSPACE_DIR, "/sandbox/enterprise");
  const kubernetesDriver =
    requests[0].spec.template.driver_config.fields.kubernetes.structValue.fields;
  const agentContainer = kubernetesDriver.containers.structValue.fields.agent.structValue.fields;
  assert.deepEqual(
    agentContainer.resources.structValue.fields.requests.structValue.fields["ephemeral-storage"],
    { stringValue: "256Mi" },
  );
  assert.deepEqual(
    agentContainer.resources.structValue.fields.limits.structValue.fields["ephemeral-storage"],
    { stringValue: "1Gi" },
  );
  assert.equal(
    agentContainer.volume_mounts.listValue.values.some(
      ({ structValue }) => structValue.fields.mount_path?.stringValue === "/home/node/workspace",
    ),
    false,
  );
  const runtimeMount = agentContainer.volume_mounts.listValue.values.find(
    ({ structValue }) =>
      structValue.fields.mount_path?.stringValue === "/sandbox/.openclaw-runtime",
  )?.structValue.fields;
  assert.ok(runtimeMount, "OpenShell requires a writable runtime root mount.");
  assert.match(runtimeMount.sub_path.stringValue, /^openshell-runtime-[a-f0-9]{16}$/);
  assert.equal(runtimeMount.read_only.boolValue, false);
  assert.ok(
    agentContainer.volume_mounts.listValue.values.some(({ structValue }) =>
      /^\/sandbox\/\.openclaw-mounts\/[a-f0-9]{16}$/u.test(
        structValue.fields.mount_path?.stringValue ?? "",
      ),
    ),
  );
  assert.ok(
    agentContainer.volume_mounts.listValue.values.some(
      ({ structValue }) =>
        `${structValue.fields.mount_path?.stringValue}/state` === nodeStateDirectory &&
        structValue.fields.read_only?.boolValue === false,
    ),
    "the node-state environment must name a process-owned child of its real writable PVC mount",
  );
  assert.equal(
    agentContainer.volume_mounts.listValue.values.some(({ structValue }) =>
      (structValue.fields.mount_path?.stringValue ?? "").startsWith("/sandbox/.openclaw-runtime/"),
    ),
    false,
  );
  assert.match(
    requests[0].spec.command[RUNTIME_WRAPPER_COMMAND.length],
    /\/sandbox\/\.openclaw-runtime\/home\/\.codex\/sessions/,
  );
  assert.match(
    requests[0].spec.command[RUNTIME_WRAPPER_COMMAND.length],
    /\/sandbox\/\.openclaw-mounts\/[a-f0-9]{16}/,
  );
  assert.doesNotMatch(
    requests[0].spec.command[RUNTIME_WRAPPER_COMMAND.length],
    /\.openclaw-node/,
    "node state must not use a symlink because OpenClaw atomically replaces files below it",
  );
  assert.ok(requests[0].spec.policy.filesystem.read_write.includes("/sandbox/.openclaw-runtime"));
  assert.ok(requests[0].spec.policy.filesystem.read_write.includes("/sandbox/enterprise"));
  assert.ok(requests[0].spec.policy.filesystem.read_write.includes("/tmp"));
  assert.ok(requests[0].spec.policy.filesystem.read_write.includes("/dev/null"));
  assert.deepEqual(requests[0].spec.policy.filesystem.read_only, [
    "/bin",
    "/usr",
    "/lib",
    "/proc",
    "/dev/urandom",
    "/etc",
    "/var/log",
    "/app",
  ]);
  assert.ok(requests[0].spec.providers.includes(`oce-cs-${"b".repeat(24)}`));
  const runtimeProvider = requests[0].spec.providers.find((name) =>
    name.startsWith("oce-runtime-"),
  );
  assert.ok(runtimeProvider);
  assert.deepEqual(gatewayClient.providers.get(runtimeProvider).config, {
    runtime_json: runtimeManifest,
    config_toml: codexConfig,
    node_ca_pem: "-----BEGIN CERTIFICATE-----\npublic-ca\n-----END CERTIFICATE-----\n",
    node_setup_json: JSON.stringify({
      url: nodeSetup.url,
      bootstrapToken: nodeSetup.bootstrapToken,
      expiresAtMs: nodeSetup.expiresAtMs,
      tlsFingerprint: nodeSetup.tlsFingerprint,
    }),
  });
  const providerCreate = gatewayClient.calls.find(([operation]) => operation === "createProvider");
  assert.deepEqual(providerCreate[1].credentials, {});
  assert.deepEqual(providerCreate[1].credentialExpirationTimes, {});
  const runtimeProfile = gatewayClient.profiles.get("oce-codex-runtime").profile;
  // OpenShell v0.1.3-pre.2 hashes protobuf maps without canonical ordering. Keeping
  // ownership and content identity in one entry prevents startup revision churn.
  assert.deepEqual(Object.keys(runtimeProfile.annotations), ["openclaw.dev/managed-by"]);
  assert.match(
    runtimeProfile.annotations["openclaw.dev/managed-by"],
    /^openclaw-enterprise:[a-f0-9]{64}$/,
  );
  assert.deepEqual(runtimeProfile.files, [
    {
      path: "runtime.json",
      content: "{{config.runtime_json}}",
      environmentVariable: "OPENCLAW_PLUGIN_RUNTIME_MANIFEST",
    },
    {
      path: "config.toml",
      content: "{{config.config_toml}}",
      environmentVariable: "OPENCLAW_PLUGIN_CODEX_CONFIG_TOML",
    },
    {
      path: "node-setup.json",
      content: "{{config.node_setup_json}}",
      environmentVariable: "OPENCLAW_NODE_SETUP_ENVELOPE",
    },
    {
      path: "node-ca.pem",
      content: "{{config.node_ca_pem}}",
      environmentVariable: "OPENCLAW_NODE_CA_PATH",
    },
  ]);
  // A wss setup URL keeps TLS end to end to the Gateway route the node's CA pins;
  // OpenShell must not terminate it, so the rule binds only binary, host, and port.
  assert.deepEqual(requests[0].spec.policy.network_policies["workspace-node-enrollment"], {
    name: "workspace-node-enrollment",
    binaries: [{ path: "/usr/local/bin/node" }],
    endpoints: [
      {
        host: "gateway.example.test",
        ports: [443],
        tls: "NETWORK_TLS_MODE_SKIP",
        enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
      },
    ],
  });

  await driver.cleanup({ ...context, revision });
  assert.equal(gatewayClient.providers.has(runtimeProvider), false);
  assert.equal(gatewayClient.profiles.has("oce-codex-runtime"), true);

  await driver.cleanup(context);
  assert.equal(gatewayClient.profiles.has("oce-codex-runtime"), false);
});

test("OpenShell retains the revision provider when Sandbox creation has an unknown outcome", async () => {
  let sandboxCreates = 0;
  const gatewayClient = workspaceGatewayClient();
  gatewayClient.createSandbox = async (request) => {
    sandboxCreates++;
    if (sandboxCreates === 1) {
      throw new Error("CreateSandbox deadline exceeded");
    }
    return {
      name: request.name,
      workspace: request.workspace,
      labels: request.labels,
      annotations: request.annotations,
      spec: request.spec,
      serviceUrls: { "": "http://codex.example.test" },
    };
  };
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  const { context, revision, requirements } = codexSandboxFixture(driver);

  await assert.rejects(
    driver.provisionHarness({ ...context, revision, requirements }),
    /deadline exceeded/,
  );
  const [runtimeProvider] = [...gatewayClient.providers.keys()];
  assert.match(runtimeProvider, /^oce-runtime-/);

  await driver.provisionHarness({ ...context, revision, requirements });

  assert.equal(sandboxCreates, 2);
  assert.equal(
    gatewayClient.calls.filter(([operation]) => operation === "createProvider").length,
    1,
  );
  assert.equal(
    gatewayClient.calls.filter(([operation]) => operation === "updateProviderCredentials").length,
    0,
  );
  assert.equal(gatewayClient.providers.has(runtimeProvider), true);
});

test("OpenShell rejects unexpected annotations on an existing Sandbox", async () => {
  let storedSandbox;
  const gatewayClient = workspaceGatewayClient();
  gatewayClient.createSandbox = async (request) => {
    storedSandbox = {
      name: request.name,
      workspace: request.workspace,
      labels: structuredClone(request.labels),
      annotations: {
        ...structuredClone(request.annotations),
        "example.test/foreign-owner": "foreign",
      },
      spec: structuredClone(request.spec),
      serviceUrls: {},
    };
    return { ...storedSandbox, serviceUrls: { "": "http://codex.example.test" } };
  };
  gatewayClient.getSandbox = async () => storedSandbox;
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  const { context, revision, requirements } = codexSandboxFixture(driver);

  await driver.provisionHarness({ ...context, revision, requirements });
  await assert.rejects(
    driver.provisionHarness({ ...context, revision, requirements }),
    /without exact AgentRevision ownership and content/,
  );
});

test("OpenShell rejects malformed or expired node setup before gateway mutation", async (t) => {
  for (const [name, setupCode, expected] of [
    ["malformed", "not-a-setup-code", /malformed setup envelope/],
    [
      "expired",
      Buffer.from(
        JSON.stringify({
          url: "wss://gateway.example.test/node",
          bootstrapToken: "expired-token",
          expiresAtMs: Date.now() - 1,
        }),
      ).toString("base64url"),
      /expired or has no bounded expiry/,
    ],
  ]) {
    await t.test(name, async () => {
      const gatewayClient = workspaceGatewayClient();
      const driver = new OpenShellSandboxDriver(
        sandboxInstallation().drivers.sandbox.configuration,
        {
          id: "openshell-sandbox",
          implementation: "openshell",
          backend: backendFor(gatewayClient),
        },
      );
      const { context, revision, requirements } = codexSandboxFixture(driver);
      const originalRead = context.kubernetes.read;
      context.kubernetes.read = async (request) => {
        const secret = await originalRead(request);
        return { ...secret, data: { setupCode: Buffer.from(setupCode).toString("base64") } };
      };

      await assert.rejects(
        driver.provisionHarness({ ...context, revision, requirements }),
        expected,
      );
      assert.deepEqual(gatewayClient.calls, []);
    });
  }
});

test("OpenShell rejects unsupported or foreign Codex runtime providers before Sandbox creation", async (t) => {
  const scenarios = [
    {
      name: "missing managed file",
      mutate({ requirements }) {
        requirements.files = requirements.files.slice(0, 1);
      },
      expected: /requires its exact bounded plugin-runtime files/,
    },
    {
      name: "oversized managed file",
      fixture: { codexConfig: "x".repeat(65_537) },
      expected: /requires its exact bounded plugin-runtime files/,
    },
    {
      name: "selected plugin",
      fixture: {
        runtimeManifest: JSON.stringify({
          kind: "codex",
          selections: { slack: { enabled: true } },
        }),
      },
      expected: /does not yet support selected plugins or repository credentials/,
    },
    {
      name: "foreign provider collision",
      foreignProvider: true,
      expected: /without exact AgentRevision ownership and content/,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      let sandboxCreates = 0;
      const gatewayClient = workspaceGatewayClient();
      gatewayClient.createSandbox = async () => {
        sandboxCreates++;
        throw new Error("an invalid runtime provider must not reach Sandbox creation");
      };
      if (scenario.foreignProvider) {
        gatewayClient.createProvider = async (request) => ({
          name: request.name,
          type: request.type,
          labels: { ...request.labels, "openclaw.dev/agent-id": "agt_foreign" },
          config: structuredClone(request.config),
        });
      }
      const driver = new OpenShellSandboxDriver(
        sandboxInstallation().drivers.sandbox.configuration,
        {
          id: "openshell-sandbox",
          implementation: "openshell",
          backend: backendFor(gatewayClient),
        },
      );
      const fixture = codexSandboxFixture(driver, scenario.fixture);
      scenario.mutate?.(fixture);

      await assert.rejects(
        driver.provisionHarness({
          ...fixture.context,
          revision: fixture.revision,
          requirements: fixture.requirements,
        }),
        (error) => {
          assert.match(String(error), scenario.expected);
          return true;
        },
      );
      assert.equal(sandboxCreates, 0);
    });
  }
});

test("OpenShell Namespace lifecycle creates, adopts, and deletes its exact operator Workspace", async () => {
  const gatewayClient = workspaceGatewayClient();
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  const context = namespaceContext();

  // A retry must adopt the same owned Workspace instead of creating a second boundary.
  await driver.ensureNamespace(context);
  await driver.ensureNamespace(context);
  assert.deepEqual(gatewayClient.workspaces.get(context.namespace.name), {
    name: context.namespace.name,
    labels: {
      "app.kubernetes.io/managed-by": "openclaw-enterprise",
      "openclaw.dev/namespace-id": context.namespace.id,
    },
    phase: "WORKSPACE_PHASE_ACTIVE",
  });
  assert.equal(
    gatewayClient.calls.filter(([operation]) => operation === "createWorkspace").length,
    1,
  );

  // A lost delete response can leave an owned Workspace terminating; retry must converge.
  gatewayClient.workspaces.get(context.namespace.name).phase = "WORKSPACE_PHASE_TERMINATING";
  await driver.cleanup(context);
  assert.equal(gatewayClient.workspaces.has(context.namespace.name), false);
  assert.deepEqual(gatewayClient.calls.at(-1), ["deleteWorkspace", context.namespace.name]);
});

test("OpenShell operator mode owns workspace chart resources around the Workspace lifecycle", async () => {
  const events = [];
  const configuration = sandboxInstallation().drivers.sandbox.configuration;
  configuration.gateway.operatorWorkspaceResources = [
    {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name: "openshell-sandbox" },
    },
  ];
  const gatewayClient = workspaceGatewayClient([], events);
  const driver = new OpenShellSandboxDriver(configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  const context = namespaceContext();
  context.kubernetes = kubernetesObjectClient(events);

  // The Gateway must not observe a Workspace until its operator-mode RBAC and
  // ServiceAccount resources have converged in the Compute-owned namespace.
  await driver.ensureNamespace(context);
  assert.deepEqual(events, [
    ["kubernetes", "patch", "ServiceAccount", "openshell-sandbox", context.namespace.name],
    ["gateway", "health"],
    ["gateway", "getWorkspace", context.namespace.name],
    ["gateway", "createWorkspace", context.namespace.name],
  ]);

  events.length = 0;
  await driver.cleanup(context);
  assert.deepEqual(events, [
    ["gateway", "getWorkspace", context.namespace.name],
    ["gateway", "deleteWorkspace", context.namespace.name],
    ["kubernetes", "delete", "ServiceAccount", "openshell-sandbox", context.namespace.name],
  ]);
});

test("OpenShell managed mode fails before mutating Kubernetes or the Gateway", async () => {
  const events = [];
  const configuration = sandboxInstallation().drivers.sandbox.configuration;
  configuration.gateway.workspaceMode = "managed";
  configuration.gateway.operatorWorkspaceResources = [
    {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name: "must-not-be-applied" },
    },
  ];
  const gatewayClient = workspaceGatewayClient();
  const driver = new OpenShellSandboxDriver(configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });
  const context = namespaceContext();
  context.kubernetes = kubernetesObjectClient(events);

  await assert.rejects(
    driver.ensureNamespace(context),
    /managed workspace mode is not implemented; cannot ensure a Namespace/,
  );
  assert.deepEqual(events, []);
  assert.deepEqual(gatewayClient.calls, []);
});

test("OpenShell Namespace cleanup refuses a same-name foreign Workspace", async () => {
  const context = namespaceContext();
  const gatewayClient = workspaceGatewayClient([
    {
      name: context.namespace.name,
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace-id": "ns_foreign",
      },
      phase: "WORKSPACE_PHASE_ACTIVE",
    },
  ]);
  const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: backendFor(gatewayClient),
  });

  await assert.rejects(driver.cleanup(context), /without exact OCC Namespace ownership/);
  assert.equal(gatewayClient.workspaces.has(context.namespace.name), true);
  assert.equal(
    gatewayClient.calls.some(([operation]) => operation === "deleteWorkspace"),
    false,
  );
});

test("startup rejects invalid bundled OpenShell configuration before invoking an injected factory", async (t) => {
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.unsupported = true;
  let invokedFactory = false;

  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
      createSandboxDriver() {
        invokedFactory = true;
        throw new Error("An injected factory must not bypass provider configuration validation.");
      },
    }),
    /drivers\.sandbox\.configuration does not match its Driver configuration schema/,
  );
  assert.equal(invokedFactory, false);
});

test("startup rejects OpenShell network values outside the v0.1 protocol enums", async (t) => {
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.policy.networkPolicies[0].endpoints[0].tls =
    "inspect";

  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
    }),
    /OpenShell network policy model-egress TLS mode must be one of: skip, terminate/,
  );
});

test("startup rejects OpenShell network policies without binary identities", async (t) => {
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.policy.networkPolicies[0].binaries = [];

  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
    }),
    /OpenShell network policy model-egress requires at least one binary path/,
  );
});

test("startup rejects inherited OpenShell network enum property names", async (t) => {
  const cases = [
    ["tls", "toString", /TLS mode must be one of: skip, terminate/],
    ["enforcement", "constructor", /enforcement mode must be one of: enforce, audit/],
    ["access", "__proto__", /access preset must be one of: read_only, read_write, full/],
  ];

  for (const [field, value, expected] of cases) {
    const configuration = sandboxInstallation();
    configuration.drivers.sandbox.configuration.policy.networkPolicies[0].endpoints[0][field] =
      value;
    await assert.rejects(
      loadInstallationConfiguration({
        mode: "production",
        environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
      }),
      expected,
    );
  }
});

test("startup rejects the deprecated OpenShell passthrough spelling", async (t) => {
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.policy.networkPolicies[0].endpoints[0].tls =
    "passthrough";

  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
    }),
    /OpenShell network policy model-egress TLS mode must be one of: skip, terminate/,
  );
});

test("startup rejects the removed per-Sandbox OpenShell ServiceAccount mode", async (t) => {
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.kubernetes.serviceAccount.mode = "driverConfig";

  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
    }),
    /OpenShell serviceAccount mode must be gatewayConfigured/,
  );
});

test("startup rejects an invalid OpenShell gateway readiness wait", async (t) => {
  const configuration = sandboxInstallation();
  configuration.drivers.sandbox.configuration.gateway.readiness = {
    serviceName: "openshell-gateway",
    podSelector: { "app.kubernetes.io/name": "openshell" },
    timeoutMs: 0,
  };

  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, configuration) },
    }),
    /OpenShell gateway readiness timeout must be a positive safe integer/,
  );
});
