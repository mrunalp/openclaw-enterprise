# OpenShell SandboxDriver

The bundled OpenShell SandboxDriver integrates a deployment-paired OpenShell
Gateway with dedicated Codex and native OpenClaw Harnesses and the bundled
[Kubernetes Compute Driver](kubernetes-compute.md). OCC retains ownership of
Agents, revisions, Namespaces, routing, credentials, and authorization.

The development profile implements plugin-free dedicated Codex with
[`v0.1.3-pre.2`](https://github.com/NVIDIA/OpenShell/tree/v0.1.3-pre.2). The paired
[OpenShell Credential Gateway](openshell-credential-gateway.md) delivers the
model key, while a revision-owned provider supplies Codex runtime files and its
workspace-node credential. These APIs remain experimental and unqualified for
production.

Embedded OpenClaw also fails when OpenShell is selected; the integration is
designed only for dedicated Harnesses. The bundled Driver supplies all three
containment facets required by dedicated native OpenClaw. See the
[qualification contract](#qualification-contract) before evaluating it.

## Ownership model

Kubernetes Compute owns the Namespace, isolation, per-Agent Gateway, storage,
Services, NetworkPolicies, and revision routing. It delegates Namespace setup
through `ensureNamespace` and the dedicated Harness through `provisionHarness`.

The OpenShell SandboxDriver owns only the provider sandboxing delegation:

- `configureAgent` contributes configuration before revision admission.
- In `operator` mode, `ensureNamespace` applies configured labels, workspace
  resources, and NetworkPolicies, then owns the exact active Workspace.
- `provisionHarness` asks the OpenShell gateway to create one OpenShell Sandbox
  in that Workspace. Dedicated Codex exposes its loopback app-server port in the
  same request; native OpenClaw requests no inbound service. The Driver adds each
  [credential attachment](#credential-attachments) to the Sandbox's providers,
  plus a revision-owned Codex runtime provider when applicable,
  validates the route, and returns the stable Sandbox reference.
- OpenShell's controller creates and owns the provider Harness Pod behind that
  Sandbox.
- `cleanup` derives the stable Sandbox identity during revision retirement, even
  when its Pod is gone. Namespace cleanup verifies Workspace ownership and
  removes the Workspace and configured resources before Compute deletes the
  Kubernetes namespace.

Compute trusts OpenShell to enforce its provider-owned Pod but still requires
workload readiness and exact revision routing. The revision stores only
`sandboxDriverId`; workers resolve the same Driver for provisioning and cleanup.

## OpenShell containment facets

The Driver configures all three available
[SandboxDriver containment facets](sandbox.md#containment-facets). Applying them
to a running Agent requires upstream support:

| Facet        | Current OpenShell behavior                                                                    |
| ------------ | --------------------------------------------------------------------------------------------- |
| `networking` | Binary-scoped OpenShell policies for Harness tool traffic, plus Kubernetes baseline policies. |
| `filesystem` | Approved PVC subpath mounts and OpenShell filesystem policy for read-only/read-write paths.   |
| `process`    | OpenShell process policy, including the configured run-as user and group.                     |

There is no `exec` facet. Command-level authorization and per-tool dynamic
sandbox creation are deferred; `exec` remains a tool invocation that runs inside
the selected Harness sandbox.

## Configuration

Select `drivers.sandbox` in the trusted Installation startup YAML. The bundled
OpenShell SandboxDriver can only be composed with the bundled Kubernetes Compute
Driver; selecting any installed Compute Driver with `drivers.sandbox` fails
startup. It also requires an [`openshell` Backend](../backends.md#openshell-gateway)
whose `drivers.sandbox` matches this ID, and the Backend's
[Credential Gateway](openshell-credential-gateway.md#configure-the-driver) member
must be selected too. The Backend owns the gateway connection; the Sandbox
rejects `endpoint`, `scheme`, `serviceName`, `port`, `auth`,
`requestTimeoutMs`, and `rootCertificatePath` in its `gateway` block.

```yaml
drivers:
  compute:
    id: compute-kubernetes
    configuration:
      # See kubernetes-compute.md for the required Kubernetes Compute config.

  sandbox:
    id: openshell-sandbox
    configuration:
      gateway:
        workspaceMode: operator
        operatorNamespaceLabels:
          openshell.ai/openclaw-workspace: "true"
        operatorWorkspaceResources: []
        networkPolicyResources: []
      kubernetes:
        runtimeClassName: openshell-sandbox
        serviceAccount:
          mode: gatewayConfigured
        sandboxDataMount:
          subPath: workspace
          mountPath: /sandbox/enterprise
          readOnly: false
      policy:
        process:
          runAsUser: "1000"
          runAsGroup: "1000"
        networkPolicies:
          - name: source-control
            binaries:
              - path: /usr/bin/git
            endpoints:
              - host: github.com
                ports: [443]
                protocol: tcp
                tls: skip
```

When `policy.filesystem` is omitted, the Driver sends OpenShell's permissive
runtime baseline: `/bin`, `/usr`, `/lib`, `/proc`, `/dev/urandom`, `/etc`,
`/var/log`, and `/app` are read-only; `/tmp`, `/dev/null`, the image workdir,
approved mounts, and `/sandbox/.openclaw-runtime` are writable. Set an explicit
`filesystem` block to replace the baseline when tightening the Sandbox. The
Driver still adds its required mounts, runtime root, and `/tmp`.

Do not add a policy for the model endpoint. The credential source's provider
profile allows `api.openai.com` with TLS inspection, and an uninspected rule for
the same host conflicts with it.

Each network policy requires a nonempty executable identity. Optional values are
`tls: skip|terminate`, `enforcement: enforce|audit`, and
`access: read_only|read_write|full`. The Driver rejects the removed
`tls: passthrough`; use `skip` for uninspected relay.
`gatewayConfigured` is the only ServiceAccount mode for `v0.1.3-pre.2`; the
gateway's configured sandbox ServiceAccount applies to every Sandbox it creates
and does not satisfy the per-Agent production requirement below.

Optional readiness observes a Service and Pods in the OCC namespace. Its timeout
and polling interval must be positive safe integers; cancellation stops the wait.
`startupDelayMs` is a bounded compatibility wait after new Sandbox creation.
Development uses 30 seconds because `v0.1.3-pre.2` exposes a service before its
canonical process listens; remove it when OpenShell reports service readiness.

The OpenShell gateway must be installed separately. The bundled driver does not
install it. `gateway.workspaceMode` is required and accepts `operator` or
`managed`. Managed mode is reserved for the future and currently fails before
the Driver mutates Kubernetes or calls the Gateway. Configure the Gateway's
Kubernetes driver with `workspaceMode: operator` and a namespace selector
matching `operatorNamespaceLabels`. In this mode the OpenShell Workspace name
must equal its pre-provisioned Kubernetes namespace, so OCC uses a stable
`oce-` name with a 15-character digest to stay within OpenShell v0.1.3-pre.2's
19-character Workspace limit.

The local OpenShell profile installs one pinned Gateway and places Workspace
resources in trusted Installation configuration. Its unauthenticated API is a
disposable, NetworkPolicy-isolated development boundary, not a production model.

`gateway.operatorWorkspaceResources` accepts namespace-scoped ServiceAccount,
Role, RoleBinding, and NetworkPolicy objects. `gateway.networkPolicyResources`
accepts provider NetworkPolicies. The Driver adds ownership and namespace;
Secrets and cluster-scoped objects are rejected.

`kubernetes.sandboxDataMount` must match exactly one approved dedicated Harness
workspace mount. It may not mount the PVC root, may not use `..`, and must mount
under `/sandbox/`.

For dedicated Codex, OpenShell's `configureAgent` hook contributes the effective
configuration before OCC validates and freezes the revision, disabling the
inner Codex app-server sandbox:

```json
{
  "plugins": {
    "entries": {
      "codex": {
        "enabled": true,
        "config": {
          "appServer": {
            "sandbox": "danger-full-access"
          }
        }
      }
    }
  }
}
```

OpenShell is the outer boundary, so Codex does not stack its own sandbox inside
it. Native OpenClaw already disables its inner isolation. Native sessions retain
separate workspaces but share the revision's OpenShell user, filesystem,
process, and network boundary; mutually untrusted sessions require separate
Agents. `runtime.nativeOpenClawSessionCapacity` accepts `1` through `1024` and
defaults to eight. Stopped sessions release their slots.

## Credential attachments

For a revision bound to a [credential source](../credential-sources.md),
Compute passes one attachment per source in `credentialAttachments`. The Driver
appends each attachment's provider name to the static `providers` list in
`SandboxSpec`. It rejects an attachment whose name does not have the OCC
`oce-cs-` provider shape or that repeats a static provider. Startup rejects
static `providers` entries that use the OCC shape, so operator-configured
providers cannot impersonate a credential source. After the Harness is ready,
Compute requires every attachment to report `ready` before activation.

## Dedicated Codex runtime provider

Kubernetes Compute emits bounded, nonsecret `runtime.json` and `config.toml`
files. The Driver imports a shared profile and creates a revision provider with
their contents. OpenShell exposes them read-only beneath the provider's
`/run/openshell/providers/` directory and reports their paths through
`OPENCLAW_PLUGIN_RUNTIME_MANIFEST` and
`OPENCLAW_PLUGIN_CODEX_CONFIG_TOML`.

Compute starts a first dedicated Gateway with fail-closed transport and an
inactive Agent Service. It calls `provisionHarness` only after the Gateway issues
the workspace-node setup Secret, so the first provider contains final setup.

The development Driver puts the setup envelope, including the short-lived
`bootstrapToken`, in a read-only provider file. The Harness rebuilds the
base64url code without changing the signed token. Sandbox policy limits node
egress to the Gateway destination and executable, but the token remains visible
inside the Sandbox. This diagnostic is not a production credential guarantee.
For same-cluster OpenShell, OCC controls setup through private WSS but gives the
Sandbox node the Agent Gateway Service URL. Compute waits for the provider-route
rollout before observing enrollment; other Sandbox Drivers retain private WSS.
The Harness retains the first valid setup and relaunches a failed workspace node
after one second without an attempt limit. Revision shutdown stops relaunches.

This proxy-mediated enrollment is implemented but still requires the protected
k3d proof below. The raw app-server token stays outside the provider. Selected
plugins and repository broker configuration fail before creation.

Revision cleanup deletes the Sandbox before its runtime provider. Namespace
cleanup then removes the shared profile. Replays adopt only exact
Namespace-, Agent-, and revision-owned providers with identical nonsecret
config. A failed or timed-out Sandbox create does not eagerly delete that
provider because the remote mutation may still have completed; the normal
revision cleanup path owns both resources.

## Create-time app-server exposure

For a dedicated Codex request that reaches OpenShell, the Driver reads the literal
`APP_SERVER_PORT` prepared by Compute and includes one unnamed service exposure
in `CreateSandbox`. It uses the Agent revision UUID as OpenShell's `request_id`,
and reconciliation first reads the derived Sandbox name. It adopts only an
exact existing Sandbox, then reads and verifies the unnamed service. The Driver
accepts only an HTTP or HTTPS origin. Its client retains a normalized URL for
control-endpoint clients and the original advertised URL for workload traffic.
The Driver exposes the latter through its optional Harness endpoint capability,
after converting it to a WebSocket origin.

For dedicated Codex, Compute supplies only the lowercase SHA-256 verifier as
`APP_TOKEN_SHA`; the raw token remains in the Agent Gateway. The Driver selects
`SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH`, so OpenShell forwards the
Gateway's bearer header and Codex authenticates it. Missing or incorrect bearer
credentials remain rejected. Other service exposures retain OpenShell's
authorization-stripping default. A Sandbox without a replayable Create receipt must be removed;
the Driver does not mutate it with a later `ExposeService` call.

When that endpoint capability is present, Kubernetes Compute replaces the
first fail-closed Gateway template with the advertised origin and does not
activate the direct Agent Service or a Compute-owned Harness route. This rule
applies by capability, not by a concrete Driver name; Sandbox Drivers without
it retain their existing Compute transport behavior.

Native OpenClaw does not accept inbound Harness traffic. Its enrolled node host
opens the connection to the Agent Gateway, so the Driver sends an empty service
exposure list and rejects any unexpected service URL returned by OpenShell.

## Kubernetes and admission requirements

OpenShell requires an operator-installed RuntimeClass or equivalent admission
exemption for its trusted privileged components. Because Pod Security Admission
exempts the whole Pod, a fail-closed policy must restrict it to digest-pinned
OpenShell images, expected ServiceAccounts, Namespaces, labels, and capabilities.

Do not grant wildcard tenant permissions to the SandboxDriver. It is wired to
use the same authenticated Kubernetes client as the Kubernetes Compute Driver;
there is no provider-specific Kubernetes access adapter. The
controller and worker need only Compute access plus namespace-scoped policy
apply and Gateway readiness. OpenShell owns Sandbox resources through its
Gateway; the Enterprise worker needs no Sandbox custom-resource permission.

Kubernetes NetworkPolicies are additive. The Kubernetes Compute Driver still
installs default-deny policies. For provider-owned inbound transport, it grants
the dedicated Agent Gateway egress only to the configured OpenShell Gateway Pod
peer and service port and omits direct Harness transport ingress. OpenShell
bootstrap policies must allow only gateway, control-plane, callback, and
approved provider connectivity needed for OpenShell to function. Broad
namespace egress or ingress allows can bypass the intended boundary.

Compute passes the provider-fenced network profile (`provider-fenced-v1`) to the
provider Harness template; the provider must retain it on the resulting Pod.
It admits no Compute DNS, model, or authentication egress; OpenShell's workload
fence governs those decisions. The policy proxy opens node connections from
OpenShell supervisor Pods (`openshell.ai/managed-by=openshell`,
`openshell.ai/boundary-role=supervisor`), which carry no `openclaw.dev` labels,
so same-cluster policies grant those callers only the tenant's Agent Gateway
Service port. The separately installed OpenShell gateway needs its own scoped
DNS/API policies.
Existing Sandboxes keep their template: redeploy the Agent revision to apply the
profile. See the
[network profile reference](kubernetes-compute/networking-and-isolation.md#explicit-network-profiles).

## Qualification contract

OpenShell remains an experimental development path. The current implementation
satisfies the local contract changes below; protected cluster proof remains.

### Workload identity

The Harness workload credential is optional. Until OCC implements token
verification and exchange and the Agent runtime consumes the result, production
configuration must allow disabling it. The local OpenShell profile does so.

When the workload credential is disabled, OpenShell may run the Agent container
with its gateway-configured infrastructure ServiceAccount. It does not need the
otherwise-unused per-Agent ServiceAccount. OpenShell's supervisor credential
must remain supervisor-only and inaccessible to the Agent container. If a
deployment explicitly requests an Agent ServiceAccount and projected token,
the Sandbox Driver must preserve both exactly or reject the revision; it must
not silently discard either half of that identity input.

A Kubernetes ServiceAccount token belongs to its issuing cluster trust domain;
it cannot identify one OCE Agent across separate Gateway and Harness clusters.
Future authentication may exchange Kubernetes, SPIFFE, or cloud evidence for a
short-lived credential scoped to the existing Agent ServicePrincipal and
revision. Gateway and Harness authenticate separately. See
[authorization](../authorization.md#principals).

### Writable runtime state

The Sandbox contract requires bounded, revision-local writable state rather than
a specific path or volume kind. Persistent data remains in explicit Agent-owned
mounts.

OpenShell mounts a revision-scoped Agent PVC subpath at
`/sandbox/.openclaw-runtime`, never the PVC root. Persistent categories retain
separate subpaths; non-workspace mounts live below `/sandbox/.openclaw-mounts`.
An exact mount environment path such as `OPENCLAW_NODE_STATE_DIR` points to a
process-created `state` child, avoiding atomic replacement through a symlink or
permission changes on a root-owned mount. The Agent PVC quota bounds the runtime
root, and Agent deletion removes it.
OpenShell uses the image's existing `/tmp` for temporary files because the
supervisor probes `TMPDIR` before the Harness can create a nested directory;
Kubernetes ephemeral-storage limits bound that writable layer.
Ordinary Kubernetes Compute may retain bounded `emptyDir` volumes at
`/home/node` and `/tmp`.

### Remaining qualification work

OpenShell gateway authentication must bind the trusted caller to the requested
Sandbox or Pod identity. Provider-managed files also require real Kubernetes
proof of their lifecycle, limits, direct-open behavior, and failures. The
proxy-mediated workspace-node enrollment above requires an exact k3d proof.
Missing admission, node enrollment, or gateway guarantees must fail the revision
instead of launching a weakened Harness.

## Sandbox log reads

`readSandboxLogs` calls only `GetSandboxLogs`. The OCC gateway identity needs
the `sandbox:read` scope and Workspace role `user`. OpenShell `NOT_FOUND`
becomes `RUNTIME_LOGS_SANDBOX_NOT_FOUND`. See
[Agent logs](../../guides/topics/agent-logs.md#sandbox-source).

## Troubleshooting

Common fail-closed errors include:

- `drivers.sandbox requires the bundled Kubernetes Compute Driver.`
- `The bundled OpenShell drivers.sandbox requires a backend entry with type openshell.`
- `OpenShell gateway option endpoint belongs to the openshell Backend or is unsupported.`
  Move the connection settings to the Backend.
- `The Harness requires a credential attachment that this OpenShell Backend did not issue.`
- `The Sandbox did not apply a required credential attachment.` Check the
  provider's status in OpenShell.
- `OpenShell gateway Service is unavailable.`
- `OpenShell gateway Pod is not ready.`
- `OpenShell SandboxDriver supports only dedicated Codex or OpenClaw Harness revisions.`
  Deployment status reports `SANDBOX_HARNESS_UNSUPPORTED`.
- `OpenShell dedicated Codex requires one literal APP_TOKEN_SHA verifier.`
  The deployment is malformed or attempted to pass the raw app-server token.
- `OpenShell dedicated Codex does not yet support selected plugins or repository credentials.`
  Deploy a plugin-free revision without repository bindings.
- A Sandbox that starts but never serves the Codex app-server can report
  `Provider environment is unavailable or changed during preparation`. Confirm
  `/sandbox/.openclaw-runtime/home/.codex` is writable and that no PVC mount is
  nested below `/sandbox/.openclaw-runtime`. A Landlock write grant does not
  override Unix ownership on the image layer.

## Related documentation

- [Development and production deployment](../../guides/deploy.md)

- [OpenShell testing](../../testing/openshell.md)
- [OpenShell Sandbox provisioning flow](../../flows/openshell-sandbox-provisioning.md)
- [SandboxDriver contract](sandbox.md) and [OpenShell Credential Gateway](openshell-credential-gateway.md)
- [ComputeDriver contract](compute.md)
- [Kubernetes ComputeDriver](kubernetes-compute.md)
- [Configuration reference](../settings.md)
