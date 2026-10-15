import { element } from "../dom.mjs";

export const displayDate = (value) => new Date(value).toLocaleString();
export const shortId = (value) => `${value.slice(0, 12)}…${value.slice(-6)}`;
export const namespacePath = (id) => `/namespaces/${encodeURIComponent(id)}`;

export function link(label, target, context) {
  const node = element("a", { href: context.pageUrl(target) }, label);
  node.addEventListener("click", (event) => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    context.navigate(target);
  });
  return node;
}

// A Namespace that is still provisioning (or failed to) refuses Agent, Configuration and
// deployment writes with NAMESPACE_NOT_READY; "conflicts with the saved state" would send the
// operator to the wrong place.
export const NAMESPACE_NOT_READY_MESSAGE =
  "This Namespace is not ready yet. Check its status on the Namespaces page: a provisioning Namespace becomes ready when its Kubernetes setup completes (on Kubernetes installs, after an operator grants the tenant RoleBindings).";

// The API's catch-all answers: a caller's own denial and an untyped conflict. They name nothing
// the caller can act on, so views keep their own guidance instead of showing them.
export const GENERIC_DENIAL = "The exact platform operation was not authorized.";
export const GENERIC_CONFLICT = "The requested platform resource already exists.";

// The API records these deployment endings as failed, but nothing went wrong with the version,
// so the console shows a neutral outcome instead. A newer version took over before this one
// became current (finding 1353; the record never names the newer version, so neither does the
// console), or the owner stopped the Agent while this version was deploying (finding 1375).
// REPOSITORY_REVISION_STOPPED stays a failure: it can also mean the Namespace is not ready.
const NEUTRAL_DEPLOYMENT_OUTCOMES = new Map([
  ["REVISION_SUPERSEDED", "superseded"],
  ["REPOSITORY_REVISION_SUPERSEDED", "superseded"],
  ["REVISION_STOPPED", "stopped"],
]);

// "superseded" or "stopped" for a neutral ending, otherwise null.
export function neutralDeploymentOutcome(status) {
  return status?.status === "failed"
    ? (NEUTRAL_DEPLOYMENT_OUTCOMES.get(status.error?.code) ?? null)
    : null;
}

// The recorded outcome to show: the API's status, except that a neutral ending is not a failure.
export function deploymentOutcome(status) {
  return neutralDeploymentOutcome(status) ?? status.status;
}

export const NEUTRAL_DEPLOYMENT_NOTES = {
  superseded: "Superseded by a newer version",
  stopped: "Stopped before it finished",
};

export function message(error, mutation = false) {
  if (error.code === "SAVED_CONFIGURATION_UNREADABLE") {
    const field = {
      plugins: "plugin selections",
      pluginApprovers: "plugin approvers",
      repositoryBindings: "repository access",
      harnessAuth: "harness authentication",
      secretBindings: "Secret bindings",
      repositoryCredentials: "repository credentials",
      configuration: "native configuration",
    }[error.field];
    return `Saved ${field ?? "configuration"} could not be read. Editing and deployment are unavailable for these settings. Ask an administrator to repair the saved configuration, then refresh this page.`;
  }
  if (error.status === 403) {
    return "Access denied. You do not have permission for this operation.";
  }
  if (error.status === 404) {
    return "Resource unavailable in this Namespace. Check the ID and your access.";
  }
  if (error.status === 409 && error.code === "NAMESPACE_NOT_READY") {
    return NAMESPACE_NOT_READY_MESSAGE;
  }
  if (error.status === 409) {
    return "The request conflicts with the saved state. Check for an existing Agent name or changed Configuration, then refresh.";
  }
  if (error.status === 400) {
    return "Check the entered values and resource IDs, then try again.";
  }
  if (error.status === 429) {
    return "Too many requests. Wait before trying again.";
  }
  return mutation
    ? "Outcome unknown. The result could not be confirmed. Refresh and inspect the saved state before trying again."
    : error.name === "TypeError" || error.name === "TimeoutError"
      ? "Request interrupted. Retry to check current access and saved state."
      : "Service unavailable. The read could not be completed. Try again.";
}

// A rejected write shows the API's own sentence, which names the field to fix (for example
// an inline model credential); other failures keep the generic status text.
export function rejectionMessage(error, mutation = false) {
  return error.status === 400 && error.serverMessage !== undefined
    ? error.serverMessage
    : message(error, mutation);
}

export function assertReadableConfiguration(resource) {
  if (resource.configurationReadError) {
    throw Object.assign(
      new Error(message(resource.configurationReadError)),
      resource.configurationReadError,
    );
  }
}
